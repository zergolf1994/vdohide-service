import { FileModel, IngestModel, MediaModel } from "@/db/models";

const BATCH_SIZE = 100;

// cleanup: file ที่ soft-delete แล้ว (metadata.deletedAt) และไม่เหลือ
// ingest/media doc ใดๆ เลย (นับรวมที่ soft-delete — ต้องรอ cleanup ตัวอื่น
// เก็บกวาดของจริงให้หมดก่อน) → ลบ doc ออกจากฐานข้อมูลถาวร
export const cleanupDeletedFiles = async () => {
    try {
        const files = await FileModel.find({ "metadata.deletedAt": { $exists: true } })
            .sort({ "metadata.deletedAt": 1 })
            .limit(BATCH_SIZE)
            .select({ _id: 1 })
            .lean();

        if (files.length === 0) {
            return { message: "No deleted files" };
        }

        const ids = files.map((f: any) => String(f._id));

        // ยังมี ingest/media ผูกอยู่ = ของจริงอาจยังค้างบน storage — ข้ามไว้ก่อน
        const [ingestFileIds, mediaFileIds] = await Promise.all([
            IngestModel.distinct("fileId", { fileId: { $in: ids } }),
            MediaModel.distinct("fileId", { fileId: { $in: ids } }),
        ]);
        const blocked = new Set([...ingestFileIds, ...mediaFileIds]);

        const purgable = ids.filter((id) => !blocked.has(id));
        if (purgable.length === 0) {
            return { message: "No files ready to purge", data: { scanned: ids.length } };
        }

        const result = await FileModel.deleteMany({ _id: { $in: purgable } });
        console.log(`[cleanup:files] purged ${result.deletedCount} file doc(s)`);

        return {
            message: "Success",
            data: { scanned: ids.length, purged: result.deletedCount, blocked: blocked.size },
        };
    } catch (error) {
        console.error("cleanupDeletedFiles -> Error:", error);
        return { message: "Internal server error" };
    }
};
