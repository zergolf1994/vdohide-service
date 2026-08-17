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

// Repairs legacy groups where the source File document was already removed.
export const repairOrphanedCloneGroups = async () => {
    const roots = await FileModel.distinct("clonedFrom", {
        ...activeCloneFilter,
        clonedFrom: { $exists: true, $nin: [null, ""] },
    });

    if (roots.length === 0) return { message: "No clone groups" };

    const existing = await FileModel.find({
        _id: { $in: roots },
        "metadata.deletedAt": { $exists: false },
    })
        .select({ _id: 1 })
        .lean();
    const existingIds = new Set((existing as any[]).map((file) => String(file._id)));
    const orphaned = roots.map(String).filter((id) => !existingIds.has(id)).slice(0, 100);

    if (orphaned.length === 0) return { message: "No orphaned clone groups" };

    const promoted = await promoteCloneSuccessors(orphaned);
    return {
        message: promoted > 0 ? "Success" : "No orphaned clone groups",
        data: { scanned: orphaned.length, promoted },
    };
};
