import {
    IngestMigrationState,
    IngestSourceType,
    MediaType,
    StorageDrainState,
    StorageStatus,
    StorageType,
    TransferMode,
    VideoProcessStatus,
    VIDEO_PROCESS_OPEN_STATUSES,
    WorkerType,
} from "@/core/enums";
import { FileModel, IngestModel, MediaModel, StorageModel, VideoProcessModel } from "@/db/models";
import { getTempStorages } from "../storage/get-storage.service";
import { getWorkers } from "../worker/get-workers.service";

type DrainStorage = {
    _id: string;
    drainState: StorageDrainState;
    drainTempStorageId?: string;
    drainRequestedAt?: Date;
};

const timelineFor = (mode: TransferMode) => {
    if (mode === TransferMode.EVACUATE) {
        return {
            scan: { status: "pending" },
            upload: { status: "pending" },
            ingest: { status: "pending" },
        };
    }
    return {
        verify: { status: "pending" },
        cleanup: { status: "pending" },
    };
};

const enqueueCleanup = async (storage: DrainStorage, slots: number) => {
    if (slots <= 0) return 0;

    const installed = await IngestModel.aggregate<{
        _id: { fileId: string; migrationId: string };
        sourceMediaIds: string[];
    }>([
        {
            $match: {
                sourceType: IngestSourceType.MIGRATION,
                migrationState: IngestMigrationState.INSTALLED,
                sourceStorageId: storage._id,
                deletedAt: { $exists: false },
            },
        },
        {
            $group: {
                _id: { fileId: "$fileId", migrationId: "$migrationId" },
                sourceMediaIds: { $addToSet: "$sourceMediaId" },
            },
        },
        { $limit: slots * 3 },
    ]);

    if (installed.length === 0) return 0;
    const ids = installed.map((item) => item._id.fileId);
    const blocked = new Set(
        await VideoProcessModel.distinct("fileId", {
            fileId: { $in: ids },
            processType: WorkerType.TRANSFER,
            status: {
                $in: [...VIDEO_PROCESS_OPEN_STATUSES, VideoProcessStatus.FAILED, VideoProcessStatus.CANCELLED],
            },
        }),
    );
    const files = await FileModel.find({ _id: { $in: ids } }, { spaceId: 1, slug: 1 }).lean();
    const fileMap = new Map(files.map((file) => [String(file._id), file]));

    const docs = installed
        .filter((item) => !blocked.has(item._id.fileId))
        .slice(0, slots)
        .map((item) => {
            const file = fileMap.get(item._id.fileId);
            return {
                fileId: item._id.fileId,
                spaceId: file?.spaceId,
                slug: file?.slug,
                processType: WorkerType.TRANSFER,
                transferMode: TransferMode.CLEANUP,
                status: VideoProcessStatus.PENDING,
                sourceStorageId: storage._id,
                migrationId: item._id.migrationId,
                sourceMediaIds: item.sourceMediaIds.filter(Boolean),
                timeline: timelineFor(TransferMode.CLEANUP),
            };
        });

    if (docs.length === 0) return 0;
    try {
        return (await VideoProcessModel.insertMany(docs, { ordered: false })).length;
    } catch (error: any) {
        if (error?.code !== 11000 && error?.writeErrors === undefined) throw error;
        return error?.insertedDocs?.length ?? 0;
    }
};

const enqueueEvacuate = async (storage: DrainStorage, tempStorageId: string, slots: number) => {
    if (slots <= 0) return 0;

    const mediaGroups = await MediaModel.aggregate<{
        _id: string;
        sourceMediaIds: string[];
    }>([
        {
            $match: {
                storageId: storage._id,
                fileId: { $exists: true },
                clonedFrom: { $exists: false },
                deletedAt: { $exists: false },
            },
        },
        {
            $group: {
                _id: "$fileId",
                sourceMediaIds: { $addToSet: "$_id" },
            },
        },
        { $sort: { _id: 1 } },
        { $limit: slots * 3 },
    ]);

    if (mediaGroups.length === 0) return 0;
    const ids = mediaGroups.map((group) => group._id);
    const blocked = new Set(
        await VideoProcessModel.distinct("fileId", {
            fileId: { $in: ids },
            processType: WorkerType.TRANSFER,
            status: {
                $in: [...VIDEO_PROCESS_OPEN_STATUSES, VideoProcessStatus.FAILED, VideoProcessStatus.CANCELLED],
            },
        }),
    );
    const staged = new Set(
        await IngestModel.distinct("fileId", {
            fileId: { $in: ids },
            sourceType: IngestSourceType.MIGRATION,
            sourceStorageId: storage._id,
            deletedAt: { $exists: false },
        }),
    );
    const files = await FileModel.find({ _id: { $in: ids } }, { spaceId: 1, slug: 1 }).lean();
    const fileMap = new Map(files.map((file) => [String(file._id), file]));
    const requestedAt = storage.drainRequestedAt?.getTime() ?? 0;

    const docs = mediaGroups
        .filter((group) => !blocked.has(group._id) && !staged.has(group._id))
        .slice(0, slots)
        .map((group) => {
            const file = fileMap.get(group._id);
            return {
                fileId: group._id,
                spaceId: file?.spaceId,
                slug: file?.slug,
                processType: WorkerType.TRANSFER,
                transferMode: TransferMode.EVACUATE,
                status: VideoProcessStatus.PENDING,
                sourceStorageId: storage._id,
                tempStorageId,
                migrationId: `${storage._id}:${requestedAt}:${group._id}`,
                sourceMediaIds: group.sourceMediaIds,
                timeline: timelineFor(TransferMode.EVACUATE),
            };
        });

    if (docs.length === 0) return 0;

    // The admin can request cancellation while this cron iteration is still
    // running. Re-check immediately before insertion so a stale storage read
    // does not keep filling the queue after cancellation.
    const stillScheduling = await StorageModel.exists({
        _id: storage._id,
        drainState: {
            $in: [StorageDrainState.REQUESTED, StorageDrainState.DRAINING, StorageDrainState.BLOCKED],
        },
    });
    if (!stillScheduling) return 0;

    try {
        return (await VideoProcessModel.insertMany(docs, { ordered: false })).length;
    } catch (error: any) {
        if (error?.code !== 11000 && error?.writeErrors === undefined) throw error;
        return error?.insertedDocs?.length ?? 0;
    }
};

const finishCancellingDrain = async (storage: DrainStorage, sourceSlots: number) => {
    const openSourceJobs = await VideoProcessModel.countDocuments({
        processType: WorkerType.TRANSFER,
        status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
        sourceStorageId: storage._id,
    });

    let cleanupEnqueued = 0;
    if (sourceSlots > 0) {
        cleanupEnqueued = await enqueueCleanup(storage, Math.max(0, sourceSlots - openSourceJobs));
    }

    const [openJobs, failedJobs, remainingMigration] = await Promise.all([
        VideoProcessModel.countDocuments({
            processType: WorkerType.TRANSFER,
            sourceStorageId: storage._id,
            status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
        }),
        VideoProcessModel.countDocuments({
            processType: WorkerType.TRANSFER,
            sourceStorageId: storage._id,
            status: {
                $in: [VideoProcessStatus.FAILED, VideoProcessStatus.CANCELLED],
            },
        }),
        IngestModel.countDocuments({
            sourceType: IngestSourceType.MIGRATION,
            sourceStorageId: storage._id,
            deletedAt: { $exists: false },
        }),
    ]);

    if (openJobs === 0 && failedJobs === 0 && remainingMigration === 0) {
        await StorageModel.updateOne(
            {
                _id: storage._id,
                drainState: StorageDrainState.CANCELLING,
            },
            {
                $set: {
                    enable: true,
                    drainState: StorageDrainState.IDLE,
                    status: StorageStatus.ONLINE,
                },
                $unset: {
                    drainTempStorageId: "",
                    drainRequestedAt: "",
                    drainCompletedAt: "",
                    drainError: "",
                },
            },
        );
        return cleanupEnqueued;
    }

    const drainError =
        failedJobs > 0
            ? `${failedJobs} migration job(s) need attention before cancellation can finish`
            : sourceSlots <= 0
              ? "Transfer worker is offline; queued migration work cannot finish"
              : undefined;

    await StorageModel.updateOne(
        {
            _id: storage._id,
            drainState: StorageDrainState.CANCELLING,
        },
        drainError ? { $set: { drainError } } : { $unset: { drainError: "" } },
    );

    return cleanupEnqueued;
};

export const getStorageDrainPending = async () => {
    try {
        const storages = (await StorageModel.find({
            type: StorageType.LOCAL,
            status: StorageStatus.ONLINE,
            drainState: {
                $in: [
                    StorageDrainState.REQUESTED,
                    StorageDrainState.DRAINING,
                    StorageDrainState.CANCELLING,
                    StorageDrainState.BLOCKED,
                ],
            },
        }).lean()) as DrainStorage[];

        if (storages.length === 0) return { message: "No storage drain requested", data: { enqueued: 0 } };

        const [workers, tempStorages] = await Promise.all([
            getWorkers({ type: WorkerType.TRANSFER }),
            getTempStorages(),
        ]);
        const workerSlots = new Map<string, number>();
        for (const worker of workers.data as any[]) {
            if (!worker.storageId) continue;
            workerSlots.set(
                String(worker.storageId),
                (workerSlots.get(String(worker.storageId)) ?? 0) + Math.max(1, worker.maxJobs ?? 1),
            );
        }

        let enqueued = 0;
        for (const storage of storages) {
            const sourceSlots = workerSlots.get(String(storage._id)) ?? 0;
            if (storage.drainState === StorageDrainState.CANCELLING) {
                enqueued += await finishCancellingDrain(storage, sourceSlots);
                continue;
            }

            const unsupportedCount = await MediaModel.countDocuments({
                storageId: storage._id,
                deletedAt: { $exists: false },
                type: { $nin: [MediaType.VIDEO, MediaType.THUMBNAIL] },
            });
            if (unsupportedCount > 0) {
                await StorageModel.updateOne(
                    {
                        _id: storage._id,
                        drainState: { $ne: StorageDrainState.CANCELLING },
                    },
                    {
                        $set: {
                            drainState: StorageDrainState.BLOCKED,
                            drainError: `${unsupportedCount} non-video media record(s) require a different migration worker`,
                        },
                    },
                );
                continue;
            }
            if (sourceSlots <= 0) {
                await StorageModel.updateOne(
                    {
                        _id: storage._id,
                        drainState: { $ne: StorageDrainState.CANCELLING },
                    },
                    {
                        $set: {
                            drainState: StorageDrainState.BLOCKED,
                            drainError: "Transfer worker is offline",
                        },
                    },
                );
                continue;
            }

            const openSourceJobs = await VideoProcessModel.countDocuments({
                processType: WorkerType.TRANSFER,
                status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
                sourceStorageId: storage._id,
            });
            const availableSlots = Math.max(0, sourceSlots - openSourceJobs);
            const cleanupEnqueued = await enqueueCleanup(storage, availableSlots);
            enqueued += cleanupEnqueued;

            const temp = storage.drainTempStorageId
                ? (tempStorages.data as any[]).find((item) => String(item._id) === storage.drainTempStorageId)
                : (tempStorages.data as any[])[0];
            if (!temp) {
                await StorageModel.updateOne(
                    {
                        _id: storage._id,
                        drainState: { $ne: StorageDrainState.CANCELLING },
                    },
                    {
                        $set: {
                            drainState: StorageDrainState.BLOCKED,
                            drainError: "No temp storage available",
                        },
                    },
                );
                continue;
            }

            enqueued += await enqueueEvacuate(storage, String(temp._id), Math.max(0, availableSlots - cleanupEnqueued));

            const [remainingMedia, openJobs, failedJobs, remainingMigration] = await Promise.all([
                MediaModel.countDocuments({
                    storageId: storage._id,
                    deletedAt: { $exists: false },
                }),
                VideoProcessModel.countDocuments({
                    processType: WorkerType.TRANSFER,
                    sourceStorageId: storage._id,
                    status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
                }),
                VideoProcessModel.countDocuments({
                    processType: WorkerType.TRANSFER,
                    sourceStorageId: storage._id,
                    status: {
                        $in: [VideoProcessStatus.FAILED, VideoProcessStatus.CANCELLED],
                    },
                }),
                IngestModel.countDocuments({
                    sourceType: IngestSourceType.MIGRATION,
                    sourceStorageId: storage._id,
                    deletedAt: { $exists: false },
                }),
            ]);

            if (remainingMedia === 0 && openJobs === 0 && failedJobs === 0 && remainingMigration === 0) {
                await StorageModel.updateOne(
                    {
                        _id: storage._id,
                        drainState: { $ne: StorageDrainState.CANCELLING },
                    },
                    {
                        $set: {
                            drainState: StorageDrainState.COMPLETED,
                            drainCompletedAt: new Date(),
                            status: StorageStatus.OFFLINE,
                        },
                        $unset: { drainError: "" },
                    },
                );
            } else if (failedJobs > 0) {
                await StorageModel.updateOne(
                    {
                        _id: storage._id,
                        drainState: { $ne: StorageDrainState.CANCELLING },
                    },
                    {
                        $set: {
                            drainState: StorageDrainState.BLOCKED,
                            drainError: `${failedJobs} migration job(s) need attention`,
                        },
                    },
                );
            } else {
                await StorageModel.updateOne(
                    {
                        _id: storage._id,
                        drainState: { $ne: StorageDrainState.CANCELLING },
                    },
                    {
                        $set: {
                            drainState: StorageDrainState.DRAINING,
                            drainTempStorageId: String(temp._id),
                        },
                        $unset: { drainError: "" },
                    },
                );
            }
        }

        return { message: "Success", data: { enqueued } };
    } catch (error) {
        console.error("getStorageDrainPending -> Error:", error);
        return { message: "Internal server error", data: { enqueued: 0 } };
    }
};
