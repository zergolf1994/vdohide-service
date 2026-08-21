import {
    FileStatus,
    FileType,
    IngestSourceType,
    MediaType,
    VideoProcessStatus,
    VIDEO_PROCESS_OPEN_STATUSES,
    WorkerType,
} from "@/core/enums";
import { FileModel, IngestModel, MediaModel, VideoProcessModel, WorkspaceModel } from "@/db/models";
import { getWorkers } from "../worker/get-workers.service";
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

interface SpritesheetConfig {
    enabled: boolean;
    slotRate: number;
    workspaceSelection?: TranscodeWorkspaceSelection;
    fileSelection?: TranscodeFileSelection;
}

const default_spritesheet_config: SpritesheetConfig = {
    enabled: true,
    slotRate: 2,
    workspaceSelection: DEFAULT_TRANSCODE_WORKSPACE_SELECTION,
    fileSelection: DEFAULT_TRANSCODE_FILE_SELECTION,
};

// enqueuer: ไฟล์ ready ที่มี video media แต่ยังไม่มี thumbnail → เติมงาน spritesheet
//   - storage ที่มี worker ติดเครื่อง (heartbeat มี storageId) → ประทับ
//     targetStorageId (worker อ่าน/เขียนดิสก์ตรง ไม่มี network I/O)
//   - storage ที่ไม่มี worker → จ่ายเข้า pool กลาง (ไม่ใส่ targetStorageId)
//     remote worker โหลดผ่าน HTTP แล้วอัพ sprite.zip + ingest ให้ worker-transfer
// ยิงซ้ำได้ปลอดภัย — partial unique index {fileId, processType} กันซ้ำ
export const getSpritesheetPending = async () => {
    try {
        const settings = await getSettingsByNames(["spritesheet_config"]);
        const spritesheet_config: SpritesheetConfig = {
            ...default_spritesheet_config,
            ...(settings.spritesheet_config ?? {}),
        };

        if (!spritesheet_config.enabled) {
            return { message: "Spritesheet is disabled" };
        }

        const workspaceSelection = normalizeTranscodeWorkspaceSelection(
            spritesheet_config.workspaceSelection
        );
        const fileSelection = normalizeTranscodeFileSelection(
            spritesheet_config.fileSelection
        );
        let eligibleWorkspaceIds: string[] | null = null;
        if (workspaceSelection.rules.length > 0) {
            eligibleWorkspaceIds = await WorkspaceModel.distinct(
                "_id",
                buildTranscodeWorkspaceFilter(workspaceSelection)
            );
            if (eligibleWorkspaceIds.length === 0) {
                return { message: "No workspaces eligible for spritesheet" };
            }
        }

        const workers = await getWorkers({ type: WorkerType.SPRITESHEET });
        if (workers.count === 0) return { message: "Worker spritesheet not ready" };

        // slot แยกราย storage (worker ติดเครื่อง) + pool กลาง (worker ไม่ผูก storage)
        const slotsByStorage = new Map<string, number>();
        let poolSlots = 0;
        for (const w of workers.data as any[]) {
            const slots = (w.maxJobs || 1) * spritesheet_config.slotRate;
            if (w.storageId) {
                slotsByStorage.set(w.storageId, (slotsByStorage.get(w.storageId) ?? 0) + slots);
            } else {
                poolSlots += slots;
            }
        }

        const openJobs = await VideoProcessModel.find(
            { processType: WorkerType.SPRITESHEET, status: { $in: VIDEO_PROCESS_OPEN_STATUSES } },
            { targetStorageId: 1 }
        ).lean();
        for (const j of openJobs as any[]) {
            if (j.targetStorageId) {
                slotsByStorage.set(j.targetStorageId, (slotsByStorage.get(j.targetStorageId) ?? 0) - 1);
            } else {
                poolSlots -= 1;
            }
        }
        poolSlots = Math.max(0, poolSlots);

        const boundSlots = [...slotsByStorage.values()].reduce((sum, n) => sum + Math.max(0, n), 0);
        const totalSlots = boundSlots + poolSlots;
        if (totalSlots <= 0) {
            return { message: "Queue is full", data: { poolSlots, slotsByStorage: Object.fromEntries(slotsByStorage) } };
        }

        // candidate: video media group รายไฟล์ → storage ของ "วิดีโอเล็กสุด"
        // ต้องตรงกับ findSmallestVideo ฝั่ง worker (360→480→720→1080→original)
        // — resolution ของไฟล์เดียวกันกระจายหลาย storage ได้ (ตั้งใจ ไม่ sticky)
        const [videoByFile, thumbFileIds, blockedFileIds, pendingSpriteFileIds] = await Promise.all([
            MediaModel.aggregate([
                { $match: { type: MediaType.VIDEO, deletedAt: { $exists: false } } },
                {
                    $addFields: {
                        _resRank: {
                            $switch: {
                                branches: [
                                    { case: { $eq: ["$resolution", "360"] }, then: 1 },
                                    { case: { $eq: ["$resolution", "480"] }, then: 2 },
                                    { case: { $eq: ["$resolution", "720"] }, then: 3 },
                                    { case: { $eq: ["$resolution", "1080"] }, then: 4 },
                                ],
                                default: 5, // original / อื่นๆ มาท้ายสุด
                            },
                        },
                    },
                },
                { $sort: { fileId: 1, _resRank: 1 } },
                { $group: { _id: "$fileId", storageId: { $first: "$storageId" } } },
            ]),
            MediaModel.distinct("fileId", {
                type: MediaType.THUMBNAIL,
                deletedAt: { $exists: false },
            }),
            VideoProcessModel.distinct("fileId", {
                processType: WorkerType.SPRITESHEET,
                // failed/cancelled = terminal รอ admin สั่ง retry ที่ doc เดิม
                status: {
                    $in: [
                        ...VIDEO_PROCESS_OPEN_STATUSES,
                        VideoProcessStatus.FAILED,
                        VideoProcessStatus.CANCELLED,
                    ],
                },
            }),
            // sprite.zip อัพแล้วรอ worker-transfer ติดตั้ง — ห้ามจ่ายซ้ำ
            IngestModel.distinct("fileId", {
                fileName: "sprite.zip",
                sourceType: IngestSourceType.PROCESSED,
                deletedAt: { $exists: false },
            }),
        ]);

        const excluded = new Set([...thumbFileIds, ...blockedFileIds, ...pendingSpriteFileIds]);
        const storageByFile = new Map<string, string>();
        for (const m of videoByFile as any[]) {
            if (m._id && m.storageId && !excluded.has(m._id)) {
                storageByFile.set(m._id, m.storageId);
            }
        }
        if (storageByFile.size === 0) {
            return { message: "No files to enqueue", data: { totalSlots } };
        }

        const baseFileFilter: Record<string, unknown> = {
            _id: { $in: [...storageByFile.keys()] },
            type: FileType.VIDEO,
            status: { $in: [FileStatus.READY_ORIGINAL, FileStatus.READY] },
            clonedFrom: { $exists: false },
            "metadata.trashedAt": { $exists: false },
            "metadata.deletedAt": { $exists: false },
        };
        const fileFilters: Record<string, unknown>[] = [baseFileFilter];
        if (eligibleWorkspaceIds) {
            fileFilters.push({ spaceId: { $in: eligibleWorkspaceIds } });
        }
        const configuredFileFilter = buildTranscodeFileFilter(fileSelection);
        if (Object.keys(configuredFileFilter).length > 0) {
            fileFilters.push(configuredFileFilter);
        }
        const fileFilter = fileFilters.length === 1
            ? baseFileFilter
            : { $and: fileFilters };
        const fileSort = Object.fromEntries([
            ...(fileSelection.sort.length > 0
                ? fileSelection.sort.map((entry) => [
                    entry.field === "size" ? "metadata.size" : "createdAt",
                    entry.direction === "asc" ? 1 : -1,
                ])
                : [["createdAt", 1]]),
            ["_id", 1],
        ]);

        const files = await FileModel.find(fileFilter)
            .sort(fileSort)
            .limit(totalSlots * 3) // เผื่อบางไฟล์อยู่ storage ที่ slot หมด
            .select({ _id: 1, spaceId: 1, slug: 1 })
            .lean();

        const docs: any[] = [];
        for (const f of files as any[]) {
            const storageId = storageByFile.get(String(f._id));
            if (!storageId) continue;

            // worker ติดเครื่องมาก่อน (เร็วกว่า ไม่เปลืองเน็ต) — ไม่มีค่อยลง pool
            const boundRemain = slotsByStorage.get(storageId) ?? 0;
            let targetStorageId: string | undefined;
            if (slotsByStorage.has(storageId) && boundRemain > 0) {
                slotsByStorage.set(storageId, boundRemain - 1);
                targetStorageId = storageId;
            } else if (!slotsByStorage.has(storageId) && poolSlots > 0) {
                poolSlots -= 1; // ไม่ผูก storage → remote pool
            } else {
                continue; // storage มี worker แต่ slot เต็ม (รอรอบหน้า) / pool เต็ม
            }

            docs.push({
                fileId: f._id,
                spaceId: f.spaceId,
                slug: f.slug,
                processType: WorkerType.SPRITESHEET,
                status: VideoProcessStatus.PENDING,
                ...(targetStorageId ? { targetStorageId } : {}),
                timeline: {
                    prepare: { status: "pending" },
                    generate: { status: "pending" },
                    install: { status: "pending" },
                    media: { status: "pending" },
                },
            });
        }

        if (docs.length === 0) {
            return { message: "No files to enqueue", data: { totalSlots, candidates: files.length } };
        }

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
                totalSlots,
                poolSlots,
                candidates: storageByFile.size,
                enqueued,
            },
        };
    } catch (error) {
        console.error("getSpritesheetPending -> Error:", error);
        return { message: "Internal server error" };
    }
};
