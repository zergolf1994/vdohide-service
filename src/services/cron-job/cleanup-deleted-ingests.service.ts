import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { StorageType } from "@/core/enums";
import { IngestModel, StorageModel } from "@/db/models";

const BATCH_SIZE = 20;

// S3 client ต่อ storage — cache ไว้ในรอบเดียว (ไม่ข้ามรอบ กัน config เก่าค้าง)
const s3ClientFor = (storage: any): S3Client => {
    const cfg = storage.s3 ?? {};
    let endpoint: string | undefined = cfg.endpoint || undefined;
    if (endpoint && !endpoint.startsWith("http")) {
        endpoint = "https://" + endpoint;
    }
    return new S3Client({
        endpoint,
        region: cfg.region || "auto",
        credentials: {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
        },
        forcePathStyle: !!cfg.forcePathStyle,
    });
};

// key เดียวกับฝั่ง Go worker: ingest.path เป็น source of truth
// (fallback {fileId}/{fileName} สำหรับ doc เก่า) + เติม s3.prefix ถ้ายังไม่มี
const objectKeyFor = (ingest: any, prefix: string): string => {
    let key: string = ingest.path || `${ingest.fileId}/${ingest.fileName}`;
    if (prefix && !key.startsWith(prefix)) {
        key = prefix.replace(/\/+$/, "") + "/" + key;
    }
    return key;
};

// cleanup: ingest ที่ soft-delete แล้ว (deletedAt) → ลบ object จริงจาก
// storage (ส่วนมากเป็น S3 temp) แล้วค่อยลบ doc ออกจากฐานข้อมูล
// ลบ object ไม่สำเร็จ = คง doc ไว้ให้รอบหน้า retry (ห้ามลบ doc ก่อน —
// จะเสีย pointer แล้ว object ค้างบน S3 ตลอดไป)
export const cleanupDeletedIngests = async () => {
    try {
        const ingests = await IngestModel.find({ deletedAt: { $exists: true } })
            .sort({ deletedAt: 1 })
            .limit(BATCH_SIZE)
            .lean();

        if (ingests.length === 0) {
            return { message: "No deleted ingests" };
        }

        const storageCache = new Map<string, any>();
        const clientCache = new Map<string, S3Client>();
        let purged = 0;
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

                if (storage && storage.type === StorageType.S3 && storage.s3) {
                    if (!clientCache.has(storage._id)) {
                        clientCache.set(storage._id, s3ClientFor(storage));
                    }
                    const client = clientCache.get(storage._id)!;
                    const key = objectKeyFor(ingest, storage.s3.prefix || "");

                    // DeleteObject เป็น idempotent — object หายไปแล้วก็สำเร็จ
                    await client.send(
                        new DeleteObjectCommand({ Bucket: storage.s3.bucket, Key: key })
                    );
                    console.log(`[cleanup:ingests] deleted s3://${storage.s3.bucket}/${key}`);
                }
                // storage หาย / ไม่ใช่ S3 → ไม่มี object ให้ลบ ลบ doc ได้เลย

                await IngestModel.deleteOne({ _id: ingest._id });
                purged++;
            } catch (err) {
                failed++;
                console.error(`[cleanup:ingests] ${ingest._id} (${ingest.fileName}):`, err);
            }
        }

        return { message: "Success", data: { scanned: ingests.length, purged, failed } };
    } catch (error) {
        console.error("cleanupDeletedIngests -> Error:", error);
        return { message: "Internal server error" };
    }
};
