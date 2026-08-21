import { AbortMultipartUploadCommand, S3Client } from "@aws-sdk/client-s3";
import { IngestStatus, StorageType } from "@/core/enums";
import { IngestModel, StorageModel } from "@/db/models";
import { applyPrefix, deleteVersions, listAllVersions, s3ClientFor } from "./s3-cleanup.helper";

// One migration creates one deleted ingest per media. Process enough objects
// per pass to keep up with a drain while bounding S3 list/delete requests.
const BATCH_SIZE = 100;
const STALE_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

// key เดียวกับฝั่ง Go worker: ingest.path เป็น source of truth
// (fallback {fileId}/{fileName} สำหรับ doc เก่า) + เติม s3.prefix ถ้ายังไม่มี
const baseKeyFor = (ingest: any, prefix: string): string =>
    applyPrefix(ingest.path || `${ingest.fileId}/${ingest.fileName}`, prefix);

// cleanup: ingest ที่ soft-delete แล้ว (deletedAt) → ลบ object จริงจาก
// storage (ส่วนมากเป็น S3 temp) แล้วค่อยลบ doc ออกจากฐานข้อมูล
//
// S3: ลบ "ทุก version + delete marker" (bucket ที่เปิด versioning เช่น B2 ต้อง
//     ลบระบุ VersionId ไม่งั้นแค่ hide) + เช็ค clone ก่อน (path+storageId เดียวกัน
//     ที่ยังไม่ถูกลบ = ยังมีคนใช้ object → ลบแค่ doc)
// non-S3 / storage หาย: ไม่มี object ให้ลบผ่าน service → ลบ doc ได้เลย
//
// ลบ object ไม่สำเร็จ = คง doc ไว้ให้รอบหน้า retry (ห้ามลบ doc ก่อน —
// จะเสีย pointer แล้ว object ค้างบน S3 ตลอดไป)
export const cleanupDeletedIngests = async () => {
    try {
        const staleBefore = new Date(Date.now() - STALE_UPLOAD_AGE_MS);
        const ingests = await IngestModel.find({
            $or: [
                { deletedAt: { $exists: true } },
                { status: IngestStatus.UPLOADING, updatedAt: { $lt: staleBefore } },
            ],
        })
            .sort({ deletedAt: 1 })
            .limit(BATCH_SIZE)
            .lean();

        if (ingests.length === 0) {
            return { message: "No deleted ingests" };
        }

        const storageCache = new Map<string, any>();
        const clientCache = new Map<string, S3Client>();
        let purged = 0;
        let deletedObjects = 0;
        let skipped = 0; // clone ยังใช้อยู่ → ลบแค่ doc ไม่แตะ S3
        let failed = 0;

        for (const ingest of ingests as any[]) {
            try {
                let storage = null;
                if (ingest.storageId) {
                    if (!storageCache.has(ingest.storageId)) {
                        storageCache.set(
                            ingest.storageId,
                            await StorageModel.findById(ingest.storageId).lean()
                        );
                    }
                    storage = storageCache.get(ingest.storageId);
                }

                if (storage && storage.type === StorageType.S3 && storage.s3?.bucket) {
                    // ── clone check: มี ingest อื่นที่ยังไม่ถูกลบ ใช้ path+storageId เดียวกันไหม ──
                    if (ingest.path) {
                        const activeClones = await IngestModel.countDocuments({
                            _id: { $ne: ingest._id },
                            storageId: ingest.storageId,
                            path: ingest.path,
                            deletedAt: { $exists: false },
                        });
                        if (activeClones > 0) {
                            await IngestModel.deleteOne({ _id: ingest._id });
                            skipped++;
                            console.log(`[cleanup:ingests] ${ingest._id}: ${activeClones} clone(s) still use ${ingest.path} — DB only`);
                            continue;
                        }
                    }

                    if (!clientCache.has(storage._id)) {
                        clientCache.set(storage._id, s3ClientFor(storage));
                    }
                    const client = clientCache.get(storage._id)!;
                    const base = baseKeyFor(ingest, storage.s3.prefix || "");

                    if (!base) {
                        failed++;
                        console.error(`[cleanup:ingests] ${ingest._id}: empty object key — skipped`);
                        continue;
                    }

                    if (ingest.multipart?.uploadId && !ingest.multipart.completedAt) {
                        try {
                            await client.send(new AbortMultipartUploadCommand({
                                Bucket: storage.s3.bucket,
                                Key: base,
                                UploadId: ingest.multipart.uploadId,
                            }));
                            console.log(`[cleanup:ingests] aborted stale multipart upload ${ingest.multipart.uploadId} for s3://${storage.s3.bucket}/${base}`);
                        } catch (error: any) {
                            // client อาจ abort ไปแล้วก่อน soft-delete ingest
                            if (error?.name !== "NoSuchUpload") throw error;
                        }
                    }

                    // ทุก version + delete marker → ลบระบุ VersionId (หายถาวรจริง ไม่เหลือ hidden)
                    const refs = await listAllVersions(client, storage.s3.bucket, base);
                    if (refs.length > 0) {
                        await deleteVersions(client, storage.s3.bucket, refs);
                        deletedObjects += refs.length;
                        console.log(`[cleanup:ingests] purged ${refs.length} version(s) under s3://${storage.s3.bucket}/${base}`);
                    }
                }
                // storage หาย / ไม่ใช่ S3 → ไม่มี object ให้ลบ ลบ doc ได้เลย

                await IngestModel.deleteOne({ _id: ingest._id });
                purged++;
            } catch (err) {
                failed++;
                console.error(`[cleanup:ingests] ${ingest._id} (${ingest.fileName}):`, err);
            }
        }

        return { message: "Success", data: { scanned: ingests.length, purged, deletedObjects, skipped, failed } };
    } catch (error) {
        console.error("cleanupDeletedIngests -> Error:", error);
        return { message: "Internal server error" };
    }
};
