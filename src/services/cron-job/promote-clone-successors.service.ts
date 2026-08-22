import { FileType, MediaType } from "@/core/enums";
import { FileModel, MediaModel } from "@/db/models";

const ISOLATED_CLONE_POLICY = "isolated" as const;

const activeCloneFilter = {
    type: FileType.VIDEO,
    "metadata.trashedAt": { $exists: false },
    "metadata.deletedAt": { $exists: false },
};

const missingPathFilter = {
    $or: [
        { path: { $exists: false } },
        { path: null },
        { path: "" },
    ],
};

interface PromoteOptions {
    excludeFileIds?: string[];
    excludeSpaceId?: string;
}

export const promoteCloneSuccessors = async (
    sourceFileIds: string[],
    options: PromoteOptions = {},
) => {
    const sourceIds = [...new Set(sourceFileIds.map(String))];
    const excludedIds = [...new Set((options.excludeFileIds ?? []).map(String))];
    let promoted = 0;

    for (const sourceFileId of sourceIds) {
        const clones = await FileModel.find({
            ...activeCloneFilter,
            ...(excludedIds.length > 0 ? { _id: { $nin: excludedIds } } : {}),
            ...(options.excludeSpaceId ? { spaceId: { $ne: options.excludeSpaceId } } : {}),
            clonedFrom: sourceFileId,
        })
            .sort({ createdAt: 1, _id: 1 })
            .select({ _id: 1 })
            .lean();

        if (clones.length === 0) continue;

        const promotedFileId = String(clones[0]!._id);
        const survivingClones = await FileModel.find({
            ...(excludedIds.length > 0 ? { _id: { $nin: excludedIds } } : {}),
            ...(options.excludeSpaceId ? { spaceId: { $ne: options.excludeSpaceId } } : {}),
            clonedFrom: sourceFileId,
            "metadata.deletedAt": { $exists: false },
        })
            .select({ _id: 1 })
            .lean();
        const groupFileIds = (survivingClones as any[]).map((clone) => String(clone._id));
        const claim = await FileModel.updateOne(
            { _id: promotedFileId, clonedFrom: sourceFileId },
            { $unset: { clonedFrom: "" }, $set: { updatedAt: new Date() } },
        );

        // Another process already promoted this group.
        if (claim.modifiedCount === 0) continue;

        await FileModel.updateMany(
            {
                _id: { $in: groupFileIds, $ne: promotedFileId },
                clonedFrom: sourceFileId,
                "metadata.deletedAt": { $exists: false },
            },
            { $set: { clonedFrom: promotedFileId, updatedAt: new Date() } },
        );

        const medias = await MediaModel.find({
            fileId: { $in: groupFileIds },
            deletedAt: { $exists: false },
            ...missingPathFilter,
        })
            .select({ _id: 1, type: 1, fileName: 1, clonedFrom: 1 })
            .lean();

        const operations = (medias as any[]).flatMap((media) => {
            const physicalOwnerId = String(media.clonedFrom || sourceFileId);
            const fileName = typeof media.fileName === "string" ? media.fileName.trim() : "";
            const path = media.type === MediaType.THUMBNAIL
                ? `${physicalOwnerId}/sprite`
                : fileName
                    ? `${physicalOwnerId}/${fileName}`
                    : "";

            return path
                ? [{
                    updateOne: {
                        filter: { _id: media._id, ...missingPathFilter },
                        update: { $set: { path, updatedAt: new Date() } },
                    },
                }]
                : [];
        });

        if (operations.length > 0) {
            await MediaModel.bulkWrite(operations);
        }

        promoted++;
        console.log(`[promote:clones] ${sourceFileId} -> ${promotedFileId} (${groupFileIds.length} clone(s))`);
    }

    return promoted;
};

const auxiliaryMediaFilter = {
    $or: [
        { type: MediaType.AUDIO },
        {
            type: MediaType.SUBTITLE,
            "metadata.clonePolicy": { $ne: ISOLATED_CLONE_POLICY },
        },
        { type: MediaType.THUMBNAIL, fileName: "sprite.vtt" },
    ],
};

// Older user-uploaded subtitle records predate clonePolicy. Their browser-side
// content hash is a reliable marker, while generated tracks do not use it.
// Mark the upload itself isolated, then retire only propagated copies. The
// physical object stays referenced by the original Media record.
const retireLegacyIsolatedSubtitleCopies = async () => {
    const unclassified = await MediaModel.find({
        type: MediaType.SUBTITLE,
        sourceHash: /^fnv1a_[0-9a-f]{8}$/i,
        "metadata.clonePolicy": { $exists: false },
        deletedAt: { $exists: false },
    })
        .sort({ _id: 1 })
        .limit(500)
        .select({ _id: 1 })
        .lean();

    let classified = 0;
    if (unclassified.length > 0) {
        const result = await MediaModel.updateMany(
            { _id: { $in: unclassified.map((media) => media._id) } },
            { $set: { "metadata.clonePolicy": ISOLATED_CLONE_POLICY, updatedAt: new Date() } },
        );
        classified = result.modifiedCount;
    }

    const propagated = await MediaModel.find({
        type: MediaType.SUBTITLE,
        "metadata.clonePolicy": ISOLATED_CLONE_POLICY,
        clonedFrom: { $exists: true, $nin: [null, ""] },
        deletedAt: { $exists: false },
    })
        .sort({ _id: 1 })
        .limit(500)
        .select({ _id: 1 })
        .lean();

    let retired = 0;
    if (propagated.length > 0) {
        const now = new Date();
        const result = await MediaModel.updateMany(
            { _id: { $in: propagated.map((media) => media._id) }, deletedAt: { $exists: false } },
            { $set: { deletedAt: now, updatedAt: now } },
        );
        retired = result.modifiedCount;
    }

    if (classified > 0 || retired > 0) {
        console.log(`[repair:clone-media] classified ${classified} isolated subtitle(s), retired ${retired} propagated copy/copies`);
    }
    return { classified, retired };
};

const mediaIdentity = (media: any) => {
    const fileName = typeof media.fileName === "string" ? media.fileName : "";
    const sourceIndex = media.metadata?.sourceIndex ?? "";
    return `${media.type}:${fileName}:${sourceIndex}`;
};

let cloneRepairCursor: string | null = null;

// Synchronize separated audio/subtitle tracks and sprite.vtt across a clone
// group. The canonical/original File is always preferred as the source. A
// surviving clone is used only for legacy groups whose original was removed.
const syncMissingCloneAuxiliaryMedia = async () => {
    const clones = await FileModel.find({
        ...activeCloneFilter,
        clonedFrom: { $exists: true, $nin: [null, ""] },
        ...(cloneRepairCursor ? { _id: { $gt: cloneRepairCursor } } : {}),
    })
        .sort({ _id: 1 })
        .select({ _id: 1, clonedFrom: 1 })
        .limit(500)
        .lean();

    if (clones.length === 0) {
        cloneRepairCursor = null;
        return { syncedFiles: 0, syncedMedia: 0 };
    }
    cloneRepairCursor = clones.length < 500
        ? null
        : String((clones[clones.length - 1] as any)._id);

    const sourceIds = [...new Set((clones as any[]).map((file) => String(file.clonedFrom)))];
    const existingSources = await FileModel.find({
        _id: { $in: sourceIds },
        ...activeCloneFilter,
    })
        .select({
            _id: 1,
            "metadata.highest": 1,
            "metadata.mediaLayout": 1,
            "metadata.audioTrackCount": 1,
        })
        .lean();
    const existingSourceIds = new Set((existingSources as any[]).map((file) => String(file._id)));
    const sourceById = new Map(
        (existingSources as any[]).map((file) => [String(file._id), file]),
    );
    const cloneIds = (clones as any[]).map((file) => String(file._id));
    const groupFileIds = [...new Set([...sourceIds, ...cloneIds])];

    const medias = await MediaModel.find({
        fileId: { $in: groupFileIds },
        deletedAt: { $exists: false },
        ...auxiliaryMediaFilter,
    }).lean();

    const mediaByFile = new Map<string, any[]>();
    for (const media of medias as any[]) {
        const fileId = String(media.fileId);
        const list = mediaByFile.get(fileId) ?? [];
        list.push(media);
        mediaByFile.set(fileId, list);
    }

    const clonesBySource = new Map<string, any[]>();
    for (const clone of clones as any[]) {
        const sourceId = String(clone.clonedFrom);
        const list = clonesBySource.get(sourceId) ?? [];
        list.push(clone);
        clonesBySource.set(sourceId, list);
    }

    const operations: any[] = [];
    const fileOperations: any[] = [];
    const operationKeys = new Set<string>();

    for (const [sourceId, members] of clonesBySource) {
        // Canonical media wins. Members only fill gaps in legacy groups.
        const desiredByIdentity = new Map<string, any>();
        for (const media of mediaByFile.get(sourceId) ?? []) {
            desiredByIdentity.set(mediaIdentity(media), media);
        }
        for (const member of members) {
            for (const media of mediaByFile.get(String(member._id)) ?? []) {
                const identity = mediaIdentity(media);
                if (!desiredByIdentity.has(identity)) desiredByIdentity.set(identity, media);
            }
        }

        const sourceMetadata = sourceById.get(sourceId)?.metadata;
        if (sourceMetadata) {
            const audioCount = [...desiredByIdentity.values()]
                .filter((media) => media.type === MediaType.AUDIO).length;
            const metadataSet: Record<string, unknown> = {};

            if (sourceMetadata.highest !== undefined) {
                metadataSet["metadata.highest"] = sourceMetadata.highest;
            }
            if (sourceMetadata.mediaLayout !== undefined || audioCount > 0) {
                metadataSet["metadata.mediaLayout"] = sourceMetadata.mediaLayout ?? "separated";
            }
            if (sourceMetadata.audioTrackCount !== undefined || audioCount > 0) {
                metadataSet["metadata.audioTrackCount"] = sourceMetadata.audioTrackCount ?? audioCount;
            }
            const metadataEntries = Object.entries(metadataSet);
            if (metadataEntries.length > 0) {
                fileOperations.push({
                    updateMany: {
                        filter: {
                            _id: { $in: members.map((member) => String(member._id)) },
                            $or: metadataEntries.map(([field, value]) => ({
                                [field]: { $ne: value },
                            })),
                        },
                        update: {
                            $set: { ...metadataSet, updatedAt: new Date() },
                        },
                    },
                });
            }
        }

        if (desiredByIdentity.size === 0) continue;

        const targetIds = members.map((member) => String(member._id));
        if (existingSourceIds.has(sourceId)) targetIds.unshift(sourceId);

        for (const targetId of targetIds) {
            const existing = new Set(
                (mediaByFile.get(targetId) ?? []).map(mediaIdentity),
            );

            for (const [identity, source] of desiredByIdentity) {
                if (existing.has(identity)) continue;
                const operationKey = `${targetId}:${identity}`;
                if (operationKeys.has(operationKey)) continue;
                operationKeys.add(operationKey);

                const identityFilter = source.fileName
                    ? { fileName: source.fileName }
                    : { "metadata.sourceIndex": source.metadata?.sourceIndex };

                operations.push({
                    updateOne: {
                        filter: {
                            fileId: targetId,
                            type: source.type,
                            ...identityFilter,
                            deletedAt: { $exists: false },
                        },
                        update: {
                            $setOnInsert: {
                                type: source.type,
                                fileName: source.fileName,
                                mimeType: source.mimeType,
                                resolution: source.resolution,
                                storageId: source.storageId,
                                path: source.path,
                                sourceHash: source.sourceHash,
                                fileId: targetId,
                                clonedFrom: source.clonedFrom || String(source.fileId),
                                metadata: source.metadata,
                            },
                        },
                        upsert: true,
                    },
                });
            }
        }
    }

    let syncedFiles = 0;
    let syncedMedia = 0;

    if (fileOperations.length > 0) {
        const fileResult = await FileModel.bulkWrite(fileOperations, { ordered: false });
        syncedFiles = fileResult.modifiedCount;
    }

    if (operations.length > 0) {
        const mediaResult = await MediaModel.bulkWrite(operations, { ordered: false });
        syncedMedia = mediaResult.upsertedCount;
    }

    // Counts are per File because isolated user uploads intentionally differ
    // across clone members. Recompute after shared-media upserts and legacy
    // copy retirement instead of copying the canonical File's count.
    const subtitleCounts = await MediaModel.aggregate<{ _id: string; count: number }>([
        {
            $match: {
                fileId: { $in: groupFileIds },
                type: MediaType.SUBTITLE,
                deletedAt: { $exists: false },
            },
        },
        { $group: { _id: "$fileId", count: { $sum: 1 } } },
    ]);
    const subtitleCountByFile = new Map(
        subtitleCounts.map((entry) => [String(entry._id), entry.count]),
    );
    const countOperations = groupFileIds.map((fileId) => {
        const count = subtitleCountByFile.get(fileId) ?? 0;
        return {
            updateOne: {
                filter: { _id: fileId, "metadata.subtitleTrackCount": { $ne: count } },
                update: { $set: { "metadata.subtitleTrackCount": count, updatedAt: new Date() } },
            },
        };
    });
    if (countOperations.length > 0) {
        const countResult = await FileModel.bulkWrite(countOperations, { ordered: false });
        syncedFiles += countResult.modifiedCount;
    }

    if (syncedFiles > 0 || syncedMedia > 0) {
        console.log(`[repair:clone-media] synced ${syncedFiles} file metadata and ${syncedMedia} missing audio/subtitle/sprite media record(s)`);
    }
    return { syncedFiles, syncedMedia };
};

// Repairs legacy groups where the source File document was already removed.
export const repairOrphanedCloneGroups = async () => {
    const isolated = await retireLegacyIsolatedSubtitleCopies();
    const roots = await FileModel.distinct("clonedFrom", {
        ...activeCloneFilter,
        clonedFrom: { $exists: true, $nin: [null, ""] },
    });

    let orphaned: string[] = [];
    let promoted = 0;
    if (roots.length > 0) {
        const existing = await FileModel.find({
            _id: { $in: roots },
            "metadata.deletedAt": { $exists: false },
        })
            .select({ _id: 1 })
            .lean();
        const existingIds = new Set((existing as any[]).map((file) => String(file._id)));
        orphaned = roots.map(String).filter((id) => !existingIds.has(id)).slice(0, 100);
        promoted = await promoteCloneSuccessors(orphaned);
    }
    const { syncedFiles, syncedMedia } = await syncMissingCloneAuxiliaryMedia();

    return {
        message: promoted > 0 || syncedFiles > 0 || syncedMedia > 0 || isolated.classified > 0 || isolated.retired > 0
            ? "Success"
            : "No clone repairs needed",
        data: { scanned: orphaned.length, promoted, syncedFiles, syncedMedia, ...isolated },
    };
};
