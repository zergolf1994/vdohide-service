import { VideoProcessStatus } from "@/core/enums";
import { VideoProcessModel, VideoProcessHistoryModel } from "@/db/models";

const BATCH_SIZE = 200;
const ARCHIVE_AFTER_MS = 5 * 60 * 1000; // completed ค้างเกิน 5 นาที → ย้าย

// archive: งาน completed → ย้ายไป video_process_history (TTL 30 วัน)
// คิวหลักเหลือแต่ pending/processing + failed/cancelled (marker รอ admin)
// ลำดับปลอดภัยเสมอ: insert history ก่อน → ลบเฉพาะตัวที่ยืนยันว่าอยู่ใน
// history แล้ว — ตายกลางทางยิงซ้ำได้ (E11000 = ย้ายไปแล้ว)
export const archiveCompletedProcesses = async () => {
    try {
        const cutoff = new Date(Date.now() - ARCHIVE_AFTER_MS);

        const docs = await VideoProcessModel.find({
            status: VideoProcessStatus.COMPLETED,
            updatedAt: { $lt: cutoff },
        })
            .sort({ updatedAt: 1 })
            .limit(BATCH_SIZE)
            .lean();

        if (docs.length === 0) {
            return { message: "No completed processes to archive" };
        }

        const now = new Date();
        const historyDocs = (docs as any[]).map((d) => ({ ...d, archivedAt: now }));

        try {
            await VideoProcessHistoryModel.insertMany(historyDocs, { ordered: false });
        } catch (error: any) {
            // E11000 = รอบก่อนย้ายไปแล้วแต่ยังไม่ทันลบต้นทาง — ข้ามได้
            if (error?.code !== 11000 && error?.writeErrors === undefined) throw error;
        }

        // ลบต้นทางเฉพาะตัวที่อยู่ใน history แน่ๆ แล้วเท่านั้น
        const ids = (docs as any[]).map((d) => d._id);
        const archivedIds = await VideoProcessHistoryModel.find({ _id: { $in: ids } })
            .select({ _id: 1 })
            .lean();
        const result = await VideoProcessModel.deleteMany({
            _id: { $in: (archivedIds as any[]).map((d) => d._id) },
            status: VideoProcessStatus.COMPLETED,
        });

        return {
            message: "Success",
            data: { scanned: docs.length, archived: result.deletedCount },
        };
    } catch (error) {
        console.error("archiveCompletedProcesses -> Error:", error);
        return { message: "Internal server error" };
    }
};
