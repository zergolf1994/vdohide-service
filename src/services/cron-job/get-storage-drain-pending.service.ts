import {
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
import { getLocalStorages, getPermanentS3Storages, getTempStorages } from "../storage/get-storage.service";
import { getWorkers } from "../worker/get-workers.service";

type DrainStorage = {
    _id: string;
    type: StorageType;
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
    if (mode === TransferMode.RESTORE) {
        return {
            download: { status: "pending" },
            install: { status: "pending" },
            media: { status: "pending" },
        };
    }
    return {
        verify: { status: "pending" },
        cleanup: { status: "pending" },
    };
};

const enqueueRestore = async (
    storage: DrainStorage,
    destinations: Array<{ _id: string; slots: number }>,
) => {
    const totalSlots = destinations.reduce((total, item) => total + item.slots, 0);
    if (totalSlots <= 0) return 0;

    const blockedFileIds = await VideoProcessModel.distinct("fileId", {
        processType: WorkerType.TRANSFER,
        sourceStorageId: storage._id,
        status: {
            $in: [...VIDEO_PROCESS_OPEN_STATUSES, VideoProcessStatus.FAILED, VideoProcessStatus.CANCELLED],
        },
    });
    const medias = await MediaModel.find({
        storageId: storage._id,
        fileId: {
            $exists: true,
            ...(blockedFileIds.length > 0 ? { $nin: blockedFileIds.map(String) } : {}),
        },
        clonedFrom: { $exists: false },
        deletedAt: { $exists: false },
        type: { $in: [MediaType.VIDEO, MediaType.THUMBNAIL, MediaType.AUDIO, MediaType.SUBTITLE] },
    })
        .sort({ createdAt: 1, _id: 1 })
        .limit(totalSlots * 10)
        .lean();
    if (medias.length === 0) return 0;

    const fileIds = [...new Set(medias.map((media) => String(media.fileId)))];
    const files = await FileModel.find({ _id: { $in: fileIds } }, { spaceId: 1, slug: 1 }).lean();
    const fileMap = new Map(files.map((file) => [String(file._id), file]));
    const requestedAt = storage.drainRequestedAt?.getTime() ?? 0;
    const remaining = new Map(destinations.map((item) => [item._id, item.slots]));
    const docs: Record<string, unknown>[] = [];
    const scheduledFileIds = new Set<string>();

    for (const media of medias) {
        const target = destinations.find((item) => (remaining.get(item._id) ?? 0) > 0);
        if (!target) break;
        const fileId = String(media.fileId);
        if (scheduledFileIds.has(fileId)) continue;
        const file = fileMap.get(fileId);
        if (!file) continue;
        docs.push({
            fileId,
            spaceId: file.spaceId,
            slug: file.slug,
            processType: WorkerType.TRANSFER,
            transferMode: TransferMode.RESTORE,
            status: VideoProcessStatus.PENDING,
            sourceStorageId: storage._id,
            targetStorageId: target._id,
            migrationId: `${storage._id}:${requestedAt}:${media._id}`,
            sourceMediaIds: [String(media._id)],
            resolution: media.resolution,
            file_name: media.fileName,
            timeline: timelineFor(TransferMode.RESTORE),
        });
        scheduledFileIds.add(fileId);
        remaining.set(target._id, (remaining.get(target._id) ?? 1) - 1);
    }
    if (docs.length === 0) return 0;

    const stillScheduling = await StorageModel.exists({
        _id: storage._id,
        drainState: { $in: [StorageDrainState.REQUESTED, StorageDrainState.DRAINING, StorageDrainState.BLOCKED] },
    });
    if (!stillScheduling) return 0;
    try {
        return (await VideoProcessModel.insertMany(docs, { ordered: false })).length;
    } catch (error: any) {
        if (error?.code !== 11000 && error?.writeErrors === undefined) throw error;
        return error?.insertedDocs?.length ?? 0;
    }
};

const enqueueEvacuate = async (
    storage: DrainStorage,
    tempStorageId: string | undefined,
    destinationStorageId: string | undefined,
    slots: number,
) => {
    if (slots <= 0) return 0;

    const [stagedMediaIds, blockedMediaIds] = await Promise.all([
        IngestModel.distinct("sourceMediaId", {
            sourceType: IngestSourceType.MIGRATION,
            sourceStorageId: storage._id,
            deletedAt: { $exists: false },
        }),
        VideoProcessModel.distinct("sourceMediaIds", {
            processType: WorkerType.TRANSFER,
            sourceStorageId: storage._id,
            status: {
                $in: [...VIDEO_PROCESS_OPEN_STATUSES, VideoProcessStatus.FAILED, VideoProcessStatus.CANCELLED],
            },
        }),
    ]);
    const excludedMediaIds = [...new Set([...stagedMediaIds, ...blockedMediaIds].map(String))];

    const mediaGroups = await MediaModel.aggregate<{
        _id: string;
        sourceMediaId: string;
    }>([
        {
            $match: {
                storageId: storage._id,
                fileId: { $exists: true },
                clonedFrom: { $exists: false },
                deletedAt: { $exists: false },
                ...(excludedMediaIds.length > 0 ? { _id: { $nin: excludedMediaIds } } : {}),
            },
        },
        { $sort: { createdAt: 1, _id: 1 } },
        {
            $group: {
                _id: "$fileId",
                // One file can have several renditions. Drain exactly one
                // root media per EVACUATE queue. Once local → Temp completes,
                // the next rendition may be staged without waiting for INSTALL.
                sourceMediaId: { $first: "$_id" },
            },
        },
        { $sort: { _id: 1 } },
        { $limit: slots * 3 },
    ]);

    if (mediaGroups.length === 0) return 0;
    const ids = mediaGroups.map((group) => group._id);
    const files = await FileModel.find({ _id: { $in: ids } }, { spaceId: 1, slug: 1 }).lean();
    const fileMap = new Map(files.map((file) => [String(file._id), file]));
    const requestedAt = storage.drainRequestedAt?.getTime() ?? 0;

    const docs = mediaGroups
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
                ...(tempStorageId ? { tempStorageId } : {}),
                ...(destinationStorageId ? { destinationStorageId } : {}),
                migrationId: `${storage._id}:${requestedAt}:${group.sourceMediaId}`,
                sourceMediaIds: [group.sourceMediaId],
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
    const [openJobs, failedJobs, remainingMigration, pendingDeletion] = await Promise.all([
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
        MediaModel.countDocuments({
            storageId: storage._id,
            deletedAt: { $exists: true, $ne: null },
        }),
    ]);

    if (openJobs === 0 && failedJobs === 0 && remainingMigration === 0 && pendingDeletion === 0) {
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
        return 0;
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

    return 0;
};

export const getStorageDrainPending = async () => {
    try {
        const storages = (await StorageModel.find({
            type: { $in: [StorageType.LOCAL, StorageType.S3] },
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

        const [workers, tempStorages, permanentS3Storages, localStorages] = await Promise.all([
            getWorkers({ type: WorkerType.TRANSFER }),
            getTempStorages(),
            getPermanentS3Storages(),
            getLocalStorages(95),
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
            if (storage.type === StorageType.LOCAL && storage.drainState === StorageDrainState.CANCELLING) {
                enqueued += await finishCancellingDrain(storage, sourceSlots);
                continue;
            }

            const unsupportedCount = await MediaModel.countDocuments({
                storageId: storage._id,
                clonedFrom: { $exists: false },
                deletedAt: { $exists: false },
                type: { $nin: [MediaType.VIDEO, MediaType.THUMBNAIL, MediaType.AUDIO, MediaType.SUBTITLE] },
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
                            drainError: `${unsupportedCount} unsupported media record(s) require a different migration worker`,
                        },
                    },
                );
                continue;
            }
            if (storage.type === StorageType.S3) {
                const destinations: Array<{ _id: string; slots: number }> = [];
                for (const target of localStorages.data as any[]) {
                    const targetId = String(target._id);
                    const capacity = workerSlots.get(targetId) ?? 0;
                    if (capacity <= 0) continue;
                    const openJobs = await VideoProcessModel.countDocuments({
                        processType: WorkerType.TRANSFER,
                        targetStorageId: targetId,
                        status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
                    });
                    const slots = Math.max(0, capacity - openJobs);
                    if (slots > 0) destinations.push({ _id: targetId, slots });
                }

                if (storage.drainState === StorageDrainState.CANCELLING) {
                    enqueued += await finishCancellingDrain(
                        storage,
                        destinations.reduce((total, item) => total + item.slots, 0),
                    );
                    continue;
                }

                if (destinations.length > 0) {
                    enqueued += await enqueueRestore(storage, destinations);
                }

                const [remainingMedia, openJobs, failedJobs, pendingDeletion] = await Promise.all([
                    MediaModel.countDocuments({
                        storageId: storage._id,
                        clonedFrom: { $exists: false },
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
                        status: { $in: [VideoProcessStatus.FAILED, VideoProcessStatus.CANCELLED] },
                    }),
                    MediaModel.countDocuments({
                        storageId: storage._id,
                        deletedAt: { $exists: true, $ne: null },
                    }),
                ]);

                if (remainingMedia === 0 && openJobs === 0 && failedJobs === 0 && pendingDeletion === 0) {
                    await StorageModel.updateOne(
                        { _id: storage._id, drainState: { $ne: StorageDrainState.CANCELLING } },
                        {
                            $set: {
                                drainState: StorageDrainState.COMPLETED,
                                drainCompletedAt: new Date(),
                                status: StorageStatus.OFFLINE,
                            },
                            $unset: { drainError: "", drainTempStorageId: "" },
                        },
                    );
                } else if (failedJobs > 0) {
                    await StorageModel.updateOne(
                        { _id: storage._id, drainState: { $ne: StorageDrainState.CANCELLING } },
                        { $set: { drainState: StorageDrainState.BLOCKED, drainError: `${failedJobs} migration job(s) need attention` } },
                    );
                } else if (destinations.length === 0 && openJobs === 0) {
                    await StorageModel.updateOne(
                        { _id: storage._id, drainState: { $ne: StorageDrainState.CANCELLING } },
                        {
                            $set: {
                                drainState: StorageDrainState.BLOCKED,
                                drainError: "No Local storage below 95% with an available transfer worker",
                            },
                        },
                    );
                } else {
                    await StorageModel.updateOne(
                        { _id: storage._id, drainState: { $ne: StorageDrainState.CANCELLING } },
                        {
                            $set: { drainState: StorageDrainState.DRAINING },
                            $unset: { drainError: "", drainTempStorageId: "" },
                        },
                    );
                }
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
                transferMode: { $in: [TransferMode.EVACUATE, TransferMode.CLEANUP] },
            });
            const availableSlots = Math.max(0, sourceSlots - openSourceJobs);

            // S3 ถาวรพร้อมใช้ → ย้ายตรงและ cut over ใน EVACUATE job เดียว
            // ไม่มีจึง fallback ไป staging บน Temp ตาม flow เดิม
            const destination = (permanentS3Storages.data as any[])[0];
            const temp = destination
                ? undefined
                : storage.drainTempStorageId
                  ? (tempStorages.data as any[]).find((item) => String(item._id) === storage.drainTempStorageId)
                  : (tempStorages.data as any[])[0];
            if (!destination && !temp) {
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

            enqueued += await enqueueEvacuate(
                storage,
                temp ? String(temp._id) : undefined,
                destination ? String(destination._id) : undefined,
                availableSlots,
            );

            const [remainingMedia, openJobs, failedJobs, remainingMigration, pendingDeletion] = await Promise.all([
                MediaModel.countDocuments({
                    storageId: storage._id,
                    clonedFrom: { $exists: false },
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
                MediaModel.countDocuments({
                    storageId: storage._id,
                    deletedAt: { $exists: true, $ne: null },
                }),
            ]);

            if (
                remainingMedia === 0 &&
                openJobs === 0 &&
                failedJobs === 0 &&
                remainingMigration === 0 &&
                pendingDeletion === 0
            ) {
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
                    destination
                        ? {
                            $set: { drainState: StorageDrainState.DRAINING },
                            $unset: { drainTempStorageId: "", drainError: "" },
                        }
                        : {
                            $set: {
                                drainState: StorageDrainState.DRAINING,
                                drainTempStorageId: String(temp!._id),
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
