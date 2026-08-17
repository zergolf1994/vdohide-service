import { FileType, MediaType } from "@/core/enums";
import { FileModel, MediaModel } from "@/db/models";

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

const syncMissingCloneSprites = async () => {
    const missing = await FileModel.aggregate([
        {
            $match: {
                ...activeCloneFilter,
                clonedFrom: { $exists: true, $nin: [null, ""] },
            },
        },
        {
            $lookup: {
                from: "medias",
                let: { cloneFileId: "$_id" },
                pipeline: [
                    {
                        $match: {
                            $expr: { $eq: ["$fileId", "$$cloneFileId"] },
                            type: MediaType.THUMBNAIL,
                            fileName: "sprite.vtt",
                            deletedAt: { $exists: false },
                        },
                    },
                    { $limit: 1 },
                ],
                as: "_sprite",
            },
        },
        { $match: { "_sprite.0": { $exists: false } } },
        { $project: { _id: 1, clonedFrom: 1 } },
        { $limit: 500 },
    ]);

    if (missing.length === 0) return 0;

    const sourceIds = [...new Set(missing.map((file: any) => String(file.clonedFrom)))];
    const sourceSprites = await MediaModel.find({
        fileId: { $in: sourceIds },
        type: MediaType.THUMBNAIL,
        fileName: "sprite.vtt",
        deletedAt: { $exists: false },
    }).lean();
    const spriteBySource = new Map(
        (sourceSprites as any[]).map((media) => [String(media.fileId), media]),
    );

    const operations = (missing as any[]).flatMap((clone) => {
        const sourceFileId = String(clone.clonedFrom);
        const source = spriteBySource.get(sourceFileId);
        if (!source) return []; // source ยังไม่สร้าง sprite — worker จะกระจายให้ภายหลัง

        return [{
            updateOne: {
                filter: {
                    fileId: String(clone._id),
                    type: MediaType.THUMBNAIL,
                    fileName: "sprite.vtt",
                    deletedAt: { $exists: false },
                },
                update: {
                    $setOnInsert: {
                        type: MediaType.THUMBNAIL,
                        fileName: source.fileName,
                        mimeType: source.mimeType,
                        storageId: source.storageId,
                        path: source.path,
                        sourceHash: source.sourceHash,
                        fileId: String(clone._id),
                        clonedFrom: source.clonedFrom || sourceFileId,
                        metadata: source.metadata,
                    },
                },
                upsert: true,
            },
        }];
    });

    if (operations.length === 0) return 0;

    const result = await MediaModel.bulkWrite(operations, { ordered: false });
    const synced = result.upsertedCount;

    if (synced > 0) {
        console.log(`[repair:clone-sprites] synced ${synced} missing sprite media record(s)`);
    }
    return synced;
};

// Repairs legacy groups where the source File document was already removed.
export const repairOrphanedCloneGroups = async () => {
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
    const syncedSprites = await syncMissingCloneSprites();

    return {
        message: promoted > 0 || syncedSprites > 0 ? "Success" : "No clone repairs needed",
        data: { scanned: orphaned.length, promoted, syncedSprites },
    };
};
