import {
    ApiKeyModel,
    CustomDomainModel,
    FileModel,
    IngestModel,
    MediaModel,
    StarredModel,
    WorkspaceMemberModel,
    WorkspaceModel,
} from "@/db/models";
import { promoteCloneSuccessors } from "./promote-clone-successors.service";

const HOBBY_GRACE_MS = 1 * 60 * 1000;
const WORKSPACE_BATCH_SIZE = 10;
const FILE_BATCH_SIZE = 10_000;
const PAID_PLANS = ["pro", "enterprise"];

const eligibleWorkspaceFilter = (now: Date) => ({
    $or: [
        {
            "plan.planType": "hobby",
            "metadata.deletedAt": {
                $exists: true,
                $lte: new Date(now.getTime() - HOBBY_GRACE_MS),
            },
        },
        {
            "plan.planType": { $in: PAID_PLANS },
            "metadata.deletedAt": { $exists: true, $lte: now },
            "plan.expiresAt": { $exists: true, $lte: now },
        },
    ],
});

/**
 * Remove deleted workspaces in two phases:
 * 1. Remove direct workspace records and soft-delete its files/assets.
 * 2. Wait for the existing ingest/media/file cleaners, then remove workspace.
 */
export const cleanupDeletedWorkspaces = async () => {
    const now = new Date();

    try {
        const workspaces = await WorkspaceModel.find(eligibleWorkspaceFilter(now))
            .sort({ "metadata.deletedAt": 1 })
            .limit(WORKSPACE_BATCH_SIZE)
            .select({ _id: 1, creatorId: 1, "metadata.deletedAt": 1, "metadata.deletedBy": 1 })
            .lean();

        if (workspaces.length === 0) {
            return { message: "No workspaces ready for cleanup" };
        }

        let deleted = 0;
        let waiting = 0;
        let filesMarked = 0;

        for (const workspace of workspaces as any[]) {
            const spaceId = String(workspace._id);
            const deletedBy = workspace.metadata?.deletedBy || workspace.creatorId;

            // These records have no asynchronous physical cleanup requirement.
            await Promise.all([
                ApiKeyModel.deleteMany({ spaceId }),
                CustomDomainModel.deleteMany({ spaceId }),
                WorkspaceMemberModel.deleteMany({ spaceId }),
            ]);

            // Process a bounded set per pass. Mark storage records first, then
            // File, so an interrupted pass can safely retry the same files.
            const files = await FileModel.find({
                spaceId,
                "metadata.deletedAt": { $exists: false },
            })
                .sort({ _id: 1 })
                .limit(FILE_BATCH_SIZE)
                .select({ _id: 1 })
                .lean();

            if (files.length > 0) {
                const activeFileIds = files.map((file: any) => String(file._id));

                // A clone outside this workspace must become the new logical
                // owner before the original File/Media records are retired.
                await promoteCloneSuccessors(activeFileIds, { excludeSpaceId: spaceId });

                await Promise.all([
                    MediaModel.updateMany(
                        { fileId: { $in: activeFileIds }, deletedAt: { $exists: false } },
                        { $set: { deletedAt: now } }
                    ),
                    IngestModel.updateMany(
                        { fileId: { $in: activeFileIds }, deletedAt: { $exists: false } },
                        { $set: { deletedAt: now } }
                    ),
                    StarredModel.deleteMany({ fileId: { $in: activeFileIds } }),
                ]);

                const fileUpdate = await FileModel.updateMany(
                    { _id: { $in: activeFileIds }, "metadata.deletedAt": { $exists: false } },
                    {
                        $set: {
                            "metadata.trashedAt": now,
                            "metadata.deletedAt": now,
                            ...(deletedBy
                                ? {
                                    "metadata.trashedBy": deletedBy,
                                    "metadata.deletedBy": deletedBy,
                                }
                                : {}),
                        },
                    }
                );

                filesMarked += fileUpdate.modifiedCount;
                waiting++;
                console.log(
                    `[cleanup:workspaces] ${spaceId}: marked ${fileUpdate.modifiedCount} file(s) for deletion`
                );
                continue;
            }

            // Existing cleaners remove File only after all ingest/media records
            // and their physical objects are gone. Never remove Workspace earlier.
            const remainingFiles = await FileModel.countDocuments({ spaceId });
            if (remainingFiles > 0) {
                waiting++;
                continue;
            }

            const result = await WorkspaceModel.deleteOne({
                _id: spaceId,
                "metadata.deletedAt": workspace.metadata.deletedAt,
            });
            deleted += result.deletedCount;

            if (result.deletedCount > 0) {
                console.log(`[cleanup:workspaces] deleted workspace ${spaceId}`);
            }
        }

        return {
            message: "Success",
            data: {
                scanned: workspaces.length,
                filesMarked,
                waiting,
                deleted,
            },
        };
    } catch (error) {
        console.error("cleanupDeletedWorkspaces -> Error:", error);
        return { message: "Internal server error" };
    }
};
