import { S3Client } from "@aws-sdk/client-s3";
import { MediaType, StorageType } from "@/core/enums";
import { MediaModel, StorageModel } from "@/db/models";
import { applyPrefix, deleteVersions, listAllVersions, s3ClientFor } from "./s3-cleanup.helper";

const BATCH_SIZE = 100;

const nonEmpty = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";

// clonedFrom ของ media ในระบบปัจจุบันเก็บ source fileId ที่เป็นเจ้าของ object จริง
// (clone.fileId เป็น id ของ clone เอง) จึงต้อง resolve ผ่าน clonedFrom ก่อน
const effectiveFileIdFor = (media: any): string =>
    nonEmpty(media.clonedFrom) || nonEmpty(media.fileId);

// Legacy media หลายตัวไม่มี path แต่ permanent S3 layout คือ:
//   video/image/etc. -> {effectiveFileId}/{fileName}
//   thumbnail       -> {effectiveFileId}/sprite/*
const fallbackKeyFor = (media: any): string | null => {
    const effectiveFileId = effectiveFileIdFor(media);
    if (!effectiveFileId) return null;

    if (media.type === MediaType.THUMBNAIL) {
        return `${effectiveFileId}/sprite`;
    }

    const fileName = nonEmpty(media.fileName);
    return fileName ? `${effectiveFileId}/${fileName}` : null;
};

// media.path เป็น source of truth; fallback รองรับ record เก่าและ worker
// ที่ยังไม่ได้ persist path. ถ้า resolve ไม่ได้ต้องเก็บ doc ไว้ ห้ามเดาแล้วลบ
const rawBaseKeyFor = (media: any): string | null =>
    nonEmpty(media.path) || fallbackKeyFor(media);

const missingPathFilter = {
    $or: [
        { path: { $exists: false } },
        { path: null },
        { path: "" },
    ],
};

// นับ media ที่ยัง active และชี้ physical object เดียวกัน ครอบคลุมทั้ง:
// - record ใหม่ที่ persist path เหมือนกัน
// - record เก่าที่ต้อง derive จาก clonedFrom || fileId
const countActiveReferences = async (
    media: any,
    rawBase: string,
    fullBase: string,
    prefix: string,
): Promise<number> => {
    const pathValues = [...new Set([rawBase, fullBase])];
    const referenceClauses: any[] = [
        { path: { $in: pathValues } },
    ];

    const fallback = fallbackKeyFor(media);
    const effectiveFileId = effectiveFileIdFor(media);
    // จะเทียบแบบ legacy ได้เมื่อ fallback ของ record นี้ชี้ object เดียวกับ path จริง
    if (fallback && effectiveFileId && applyPrefix(fallback, prefix) === fullBase) {
        const effectiveReference = {
            $or: [
                { clonedFrom: effectiveFileId },
                {
                    fileId: effectiveFileId,
                    $or: [
                        { clonedFrom: { $exists: false } },
                        { clonedFrom: null },
                        { clonedFrom: "" },
                    ],
                },
            ],
        };
        const assetIdentity = media.type === MediaType.THUMBNAIL
            ? { type: MediaType.THUMBNAIL }
            : { fileName: nonEmpty(media.fileName) };

        referenceClauses.push({
            $and: [missingPathFilter, effectiveReference, assetIdentity],
        });
    }

    return MediaModel.countDocuments({
        _id: { $ne: media._id },
        storageId: media.storageId,
        deletedAt: { $exists: false },
        $or: referenceClauses,
    });
};

// cleanup: media ที่ soft-delete แล้ว (deletedAt) ซึ่งอยู่บน "S3" เท่านั้น →
// ลบ object จริงบน S3 แล้วค่อยลบ doc
// (media = ไฟล์ mp4 เดี่ยวที่ media.path — HLS แพ็กสดตอนเล่น ไม่ได้เก็บ segments)
//
// media ที่อยู่บน LOCAL storage ไม่แตะ — storage-node เป็นคนลบไฟล์จริงตาม
// refcount เอง (ตรงข้ามกับ S3 ที่ storage-node เข้าไม่ถึง ต้องใช้ service นี้)
//
// ลบ object ไม่สำเร็จ = คง doc ไว้ให้รอบหน้า retry (ห้ามลบ doc ก่อน —
// จะเสีย pointer แล้ว object ค้างบน S3 ตลอดไป)
export const cleanupDeletedMedias = async () => {
    try {
        // จำกัด batch ให้เป็น media ของ S3 storage เท่านั้น (local ปล่อยให้ storage-node)
        const s3Storages = await StorageModel
            .find({ type: StorageType.S3 })
            .select({ _id: 1 })
            .lean();
        const s3Ids = (s3Storages as any[]).map((s) => String(s._id));

        if (s3Ids.length === 0) {
            return { message: "No S3 storage configured" };
        }

        const medias = await MediaModel.find({
            deletedAt: { $exists: true },
            storageId: { $in: s3Ids },
        })
            .sort({ deletedAt: 1 })
            .limit(BATCH_SIZE)
            .lean();

        if (medias.length === 0) {
            return { message: "No deleted S3 medias" };
        }

        const storageCache = new Map<string, any>();
        const clientCache = new Map<string, S3Client>();
        let purged = 0;
        let deletedObjects = 0;
        let skipped = 0; // clone ยังใช้อยู่ → ลบแค่ doc ไม่แตะ S3
        let failed = 0;

        for (const media of medias as any[]) {
            try {
                if (!storageCache.has(media.storageId)) {
                    storageCache.set(
                        media.storageId,
                        await StorageModel.findById(media.storageId).lean()
                    );
                }
                const storage = storageCache.get(media.storageId);

                // storage หาย / ไม่ใช่ S3 / config ไม่ครบ → ข้าม (ให้ทางอื่นจัดการ)
                if (!storage || storage.type !== StorageType.S3 || !storage.s3?.bucket) {
                    continue;
                }

                if (!clientCache.has(storage._id)) {
                    clientCache.set(storage._id, s3ClientFor(storage));
                }
                const client = clientCache.get(storage._id)!;
                const rawBase = rawBaseKeyFor(media);

                // กันลบทั้ง bucket/ทำ object orphan ถ้า media เพี้ยน
                if (!rawBase) {
                    failed++;
                    console.error(`[cleanup:medias] ${media._id}: empty object key — skipped`);
                    continue;
                }
                const prefix = storage.s3.prefix || "";
                const base = applyPrefix(rawBase, prefix);

                // ── ref check: original/clone ที่ยัง active ใช้ object เดียวกันไหม ──
                // ถ้ายังมี ลบเฉพาะ soft-deleted media doc; object จะอยู่จน reference
                // ตัวสุดท้ายถูกลบ
                const activeReferences = await countActiveReferences(media, rawBase, base, prefix);
                if (activeReferences > 0) {
                    await MediaModel.deleteOne({ _id: media._id });
                    skipped++;
                    console.log(`[cleanup:medias] ${media._id}: ${activeReferences} active reference(s) still use ${base} — DB only`);
                    continue;
                }

                // ทุก version + delete marker ของไฟล์ mp4 นี้ → ลบถาวรจริง ไม่เหลือ "hidden"
                const refs = await listAllVersions(client, storage.s3.bucket, base);

                if (refs.length > 0) {
                    await deleteVersions(client, storage.s3.bucket, refs);
                    deletedObjects += refs.length;
                    console.log(`[cleanup:medias] purged ${refs.length} version(s) under s3://${storage.s3.bucket}/${base}`);
                }
                // refs ว่าง = ไม่มี object แล้ว (ลบ doc ได้เลย)

                await MediaModel.deleteOne({ _id: media._id });
                purged++;
            } catch (err) {
                failed++;
                console.error(`[cleanup:medias] ${media._id} (${media.fileName ?? media.slug}):`, err);
            }
        }

        return {
            message: "Success",
            data: { scanned: medias.length, purged, deletedObjects, skipped, failed },
        };
    } catch (error) {
        console.error("cleanupDeletedMedias -> Error:", error);
        return { message: "Internal server error" };
    }
};
