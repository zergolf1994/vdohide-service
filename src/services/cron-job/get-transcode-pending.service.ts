import {
    FileStatus,
    FileType,
    IngestSourceType,
    MediaType,
    VideoProcessStatus,
    VIDEO_PROCESS_OPEN_STATUSES,
    WorkerType,
} from "@/core/enums";
import { FileModel, IngestModel, MediaModel, VideoProcessModel } from "@/db/models";
import { getWorkers } from "../worker/get-workers.service";
import { getSettingsByNames } from "../setting/get-setting.service";

interface TranscodeConfig {
    enabled: boolean;
    slotRate: number;
    gpuEnabled?: boolean; // worker อ่านเอง — เก็บใน setting เดียวกัน
}

const default_transcode_config: TranscodeConfig = {
    enabled: true,
    slotRate: 2,
};

// enqueuer: ไฟล์ ready ที่ยังไม่เคย transcode → เติมงาน transcode pending
// — pool กลาง ไม่ผูก storage (worker โหลด original ผ่าน HTTP เอง)
//
// เกณฑ์ "ยังไม่เคย transcode" ดูจากของจริง ไม่ใช้ metadata.highest
// (highest เป็นป้ายคุณภาพต้นฉบับที่ worker-download ตั้งไว้ตั้งแต่แรก):
//   ไม่มี media resolution 360-1080 + ไม่มี ingest แปลงแล้วค้างรอ transfer
// ยิงซ้ำได้ปลอดภัย — partial unique index {fileId, processType} กันซ้ำ

const TRANSCODED_RESOLUTIONS = ["360", "480", "720", "1080"];
const TRANSCODED_FILENAMES = TRANSCODED_RESOLUTIONS.map((r) => `file_${r}.mp4`);
export const getTranscodePending = async () => {
    try {
        const settings = await getSettingsByNames(["transcode_config"]);
        const transcode_config: TranscodeConfig = {
            ...default_transcode_config,
            ...(settings.transcode_config ?? {}),
        };

        if (!transcode_config.enabled) {
            return { message: "Transcode is disabled" };
        }

        const workers = await getWorkers({ type: WorkerType.TRANSCODE });
        if (workers.count === 0) return { message: "Worker transcode not ready" };

        // slot รวมทั้ง pool — encode งานยาว slotRate คุมความลึกของคิว
        const capacity = workers.data.reduce(
            (sum: number, w: any) => sum + (w.maxJobs || 1),
            0
        ) * transcode_config.slotRate;
        const openCount = await VideoProcessModel.countDocuments({
            processType: WorkerType.TRANSCODE,
            status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
        });
        const slots = capacity - openCount;
        if (slots <= 0) {
            return { message: "Queue is full", data: { capacity, openCount } };
        }

        // candidate: ไฟล์ ready (original อยู่บน storage แล้ว) ที่ยังไม่มี
        // ผลลัพธ์ transcode เลย และไม่มีงาน transcode ค้าง/failed/cancelled
        const [blockedFileIds, transcodedFileIds, pendingIngestFileIds] = await Promise.all([
            VideoProcessModel.distinct("fileId", {
                processType: WorkerType.TRANSCODE,
                // failed/cancelled = terminal รอ admin สั่ง retry ที่ doc เดิม
                status: {
                    $in: [
                        ...VIDEO_PROCESS_OPEN_STATUSES,
                        VideoProcessStatus.FAILED,
                        VideoProcessStatus.CANCELLED,
                    ],
                },
            }),
            MediaModel.distinct("fileId", {
                type: MediaType.VIDEO,
                resolution: { $in: TRANSCODED_RESOLUTIONS },
                deletedAt: { $exists: false },
            }),
            IngestModel.distinct("fileId", {
                fileName: { $in: TRANSCODED_FILENAMES },
                sourceType: IngestSourceType.PROCESSED,
                deletedAt: { $exists: false },
            }),
        ]);
        const excluded = [...new Set([...blockedFileIds, ...transcodedFileIds, ...pendingIngestFileIds])];

        const files = await FileModel.find({
            type: FileType.VIDEO,
            status: FileStatus.READY,
            clonedFrom: { $exists: false },
            "metadata.trashedAt": { $exists: false },
            "metadata.deletedAt": { $exists: false },
            ...(excluded.length > 0 ? { _id: { $nin: excluded } } : {}),
        })
            .sort({ createdAt: 1 })
            .limit(slots)
            .select({ _id: 1, spaceId: 1, slug: 1 })
            .lean();

        if (files.length === 0) {
            return { message: "No files to enqueue", data: { capacity, openCount } };
        }

        const docs = (files as any[]).map((f) => ({
            fileId: f._id,
            spaceId: f.spaceId,
            slug: f.slug,
            processType: WorkerType.TRANSCODE,
            status: VideoProcessStatus.PENDING,
            timeline: {
                download: { status: "pending" },
                // encode_{res}/upload_{res} — worker เติมเองหลัง probe
            },
        }));

        let enqueued = 0;
        try {
            const inserted = await VideoProcessModel.insertMany(docs, { ordered: false });
            enqueued = inserted.length;
        } catch (error: any) {
            // E11000 = ชนคิวที่มีอยู่ — ตัวที่เหลือเข้าไปแล้ว นับจากผลจริง
            if (error?.code !== 11000 && error?.writeErrors === undefined) throw error;
            enqueued = error?.insertedDocs?.length ?? 0;
        }

        return {
            message: "Success",
            data: {
                capacity,
                openCount,
                slots,
                candidates: files.length,
                enqueued,
            },
        };
    } catch (error) {
        console.error("getTranscodePending -> Error:", error);
        return { message: "Internal server error" };
    }
};
