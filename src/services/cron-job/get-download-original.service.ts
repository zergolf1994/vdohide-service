import { VideoProcessStatus, VIDEO_PROCESS_OPEN_STATUSES, WorkerType } from "@/core/enums";
import { VideoProcessModel, WorkspaceModel } from "@/db/models";
import { getTempStorages } from "../storage/get-storage.service";
import { getWorkers } from "../worker/get-workers.service";
import { getFilesNeededDownload } from "../file";
import { getSettingsByNames } from "../setting/get-setting.service";
import {
    buildTranscodeFileFilter,
    DEFAULT_TRANSCODE_FILE_SELECTION,
    normalizeTranscodeFileSelection,
    TranscodeFileSelection,
} from "./transcode-file-filter";
import {
    buildTranscodeWorkspaceFilter,
    DEFAULT_TRANSCODE_WORKSPACE_SELECTION,
    normalizeTranscodeWorkspaceSelection,
    TranscodeWorkspaceSelection,
} from "./transcode-workspace-filter";

interface DownloadConfig {
    enabled: boolean;
    sort?: { [key: string]: 1 | -1 };
    filter?: Record<string, any>;
    slotRate: number;
    workspaceSelection?: TranscodeWorkspaceSelection;
    fileSelection?: TranscodeFileSelection;
}

const default_download_config: DownloadConfig = {
    enabled: true,
    sort: { createdAt: -1 },
    filter: {},
    slotRate: 2,
    workspaceSelection: DEFAULT_TRANSCODE_WORKSPACE_SELECTION,
    fileSelection: DEFAULT_TRANSCODE_FILE_SELECTION,
};

// enqueuer: หา slot ว่าง → หาไฟล์ waiting ที่ยังไม่อยู่ในคิว → เติมเป็น pending
// worker (Go) จะมา claim pending เอง — endpoint นี้ยิงซ้ำได้ปลอดภัย (idempotent)
export const getDownloadOriginal = async () => {
    try {
        // merge รายฟิลด์ — doc ใน DB อาจมีแค่บาง field (เช่นของเก่าไม่มี slotRate)
        // ถ้าใช้ default เฉพาะตอน doc หายทั้งก้อน field ที่ขาดจะเป็น undefined → capacity เป็น NaN
        const settings = await getSettingsByNames(["download_config"])
        const storedConfig = settings.download_config && typeof settings.download_config === "object"
            ? settings.download_config as Record<string, unknown>
            : {};
        const download_config: DownloadConfig = {
            ...default_download_config,
            ...storedConfig,
        };

        if (!download_config.enabled) {
            return { message: "Download is disabled" }
        }

        const workspaceSelection = normalizeTranscodeWorkspaceSelection(
            download_config.workspaceSelection
        );
        const hasFileSelection = Object.prototype.hasOwnProperty.call(storedConfig, "fileSelection");
        const fileSelection = normalizeTranscodeFileSelection(download_config.fileSelection);
        let eligibleWorkspaceIds: string[] | null = null;
        if (workspaceSelection.rules.length > 0) {
            eligibleWorkspaceIds = await WorkspaceModel.distinct(
                "_id",
                buildTranscodeWorkspaceFilter(workspaceSelection)
            );
            if (eligibleWorkspaceIds.length === 0) {
                return { message: "No workspaces eligible for download" };
            }
        }

        const [storages, workers] = await Promise.all([
            getTempStorages(),
            getWorkers({ type: WorkerType.DOWNLOAD })
        ]);

        if (storages.count === 0) return { message: "Storage temp not ready" }
        if (workers.count === 0) return { message: "Worker download not ready" }

        // slot ว่าง = ความจุรวม - งานที่ค้างในคิว (pending + processing)
        // นับจาก video_process ตรงๆ ไม่เชื่อ activeJobs ที่ Go เขียน (ดูคอมเมนต์ใน worker.model)
        const capacity = workers.data.reduce((sum, w) => sum + (w.maxJobs || 1), 0) * download_config.slotRate;
        const openCount = await VideoProcessModel.countDocuments({
            processType: WorkerType.DOWNLOAD,
            status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
        });
        const slots = capacity - openCount;
        if (slots <= 0) {
            return { message: "Queue is full", data: { capacity, openCount } }
        }

        const filters: Record<string, unknown>[] = [];
        if (eligibleWorkspaceIds) filters.push({ spaceId: { $in: eligibleWorkspaceIds } });
        if (hasFileSelection) {
            const configuredFilter = buildTranscodeFileFilter(fileSelection);
            if (Object.keys(configuredFilter).length > 0) filters.push(configuredFilter);
        } else if (download_config.filter && Object.keys(download_config.filter).length > 0) {
            filters.push(download_config.filter);
        }
        const filter = filters.length > 1 ? { $and: filters } : filters[0] ?? {};
        const sort = hasFileSelection
            ? Object.fromEntries([
                ...(fileSelection.sort.length > 0
                    ? fileSelection.sort.map((entry) => [
                        entry.field === "size" ? "metadata.size" : "createdAt",
                        entry.direction === "asc" ? 1 : -1,
                    ])
                    : [["createdAt", -1]]),
                ["_id", 1],
            ])
            : download_config.sort ?? { createdAt: -1 };

        const files = await getFilesNeededDownload({
            limit: slots,
            sort,
            filter
        });

        if (files.data.length === 0) {
            return { message: "No files to enqueue", data: { capacity, openCount } }
        }

        // เติมคิว — partial unique index {fileId, processType} กันซ้ำอีกชั้น
        // (getFilesNeededDownload กรอง queued แล้ว แต่ check-then-act มีช่องว่างเสมอ)
        const docs = files.data.map((f: { fileId: string; spaceId?: string; slug?: string }) => ({
            fileId: f.fileId,
            spaceId: f.spaceId,
            slug: f.slug,
            processType: WorkerType.DOWNLOAD,
            status: VideoProcessStatus.PENDING,
        }));

        let enqueued = 0;
        try {
            const inserted = await VideoProcessModel.insertMany(docs, { ordered: false });
            enqueued = inserted.length;
        } catch (error: any) {
            // E11000 = ชนคิวที่มีอยู่ (รอบก่อนเพิ่ง insert) — ตัวที่เหลือเข้าไปแล้ว นับจากผลจริง
            if (error?.code !== 11000 && error?.writeErrors === undefined) throw error;
            enqueued = error?.insertedDocs?.length ?? 0;
        }

        return {
            message: "Success",
            data: {
                capacity,
                openCount,
                slots,
                candidates: files.count,
                enqueued,
            }
        }
    } catch (error) {
        console.error("getDownloadOriginal -> Error:", error);
        return { message: "Internal server error" }
    }
};
