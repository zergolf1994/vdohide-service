import { S3Client } from "@aws-sdk/client-s3";
import { StorageType } from "@/core/enums";
import { MediaModel, StorageModel } from "@/db/models";
import { applyPrefix, deleteVersions, listAllVersions, s3ClientFor } from "./s3-cleanup.helper";

const BATCH_SIZE = 20;

// key ฐานของ media: media.path เป็น source of truth (fallback {fileId}/{slug})
const baseKeyFor = (media: any, prefix: string): string =>
    applyPrefix(media.path || `${media.fileId}/${media.slug}`, prefix);

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

                // ── clone check: มี media อื่นที่ยังไม่ถูกลบ ใช้ path+storageId เดียวกันไหม ──
                // media.clonedFrom → clone ชี้ object จริงตัวเดียวกัน ถ้ายังมีคนใช้อยู่
                // ห้ามลบ S3 object (จะพัง clone) — ลบแค่ doc นี้พอ
                if (media.path) {
                    const activeClones = await MediaModel.countDocuments({
                        _id: { $ne: media._id },
                        storageId: media.storageId,
                        path: media.path,
                        deletedAt: { $exists: false },
                    });
                    if (activeClones > 0) {
                        await MediaModel.deleteOne({ _id: media._id });
                        skipped++;
                        console.log(`[cleanup:medias] ${media._id}: ${activeClones} clone(s) still use ${media.path} — DB only`);
                        continue;
                    }
                }

                if (!clientCache.has(storage._id)) {
                    clientCache.set(storage._id, s3ClientFor(storage));
                }
                const client = clientCache.get(storage._id)!;
                const base = baseKeyFor(media, storage.s3.prefix || "");

                // กันลบทั้ง bucket ถ้า base ว่าง (media เพี้ยน — เก็บ doc ไว้ให้เช็คมือ)
                if (!base) {
                    failed++;
                    console.error(`[cleanup:medias] ${media._id}: empty object key — skipped`);
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
