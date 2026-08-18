import { MediaType, Resolution } from "@/core/enums";
import { MediaModel } from "@/db/models";

// An original is disposable when the same File has an active video rendition
// whose resolution exactly matches files.metadata.highest. This deliberately
// derives truth from File + Media records and does not depend on short-lived
// video_process/video_process_history documents.

const NORMAL_BATCH = 2000;
const FULL_BATCH = 2000;

interface EligibleOriginal {
    _id: string;
    fileId: string;
    highest: string;
}

const findEligibleOriginals = async (limit: number, afterId = "") => {
    const originalMatch: Record<string, unknown> = {
        type: MediaType.VIDEO,
        resolution: Resolution.ORIGINAL,
        deletedAt: { $exists: false },
        fileId: { $type: "string" },
    };
    if (afterId) originalMatch._id = { $gt: afterId };

    return MediaModel.aggregate<EligibleOriginal>([
        { $match: originalMatch },
        { $sort: { _id: 1 } },
        {
            $lookup: {
                from: "files",
                localField: "fileId",
                foreignField: "_id",
                pipeline: [
                    { $match: { "metadata.highest": { $exists: true, $gt: 0 } } },
                    { $project: { _id: 0, highest: { $toString: "$metadata.highest" } } },
                ],
                as: "file",
            },
        },
        { $unwind: "$file" },
        {
            $lookup: {
                from: "medias",
                let: { fileId: "$fileId", highest: "$file.highest" },
                pipeline: [
                    {
                        $match: {
                            type: MediaType.VIDEO,
                            deletedAt: { $exists: false },
                            $expr: {
                                $and: [
                                    { $eq: ["$fileId", "$$fileId"] },
                                    { $eq: ["$resolution", "$$highest"] },
                                ],
                            },
                        },
                    },
                    { $limit: 1 },
                    { $project: { _id: 1 } },
                ],
                as: "highestMedia",
            },
        },
        { $match: { "highestMedia.0": { $exists: true } } },
        { $project: { _id: 1, fileId: 1, highest: "$file.highest" } },
        { $limit: limit },
    ]).allowDiskUse(true);
};

const purgeEligibleOriginals = async (limit: number, afterId = "") => {
    const originals = await findEligibleOriginals(limit, afterId);
    if (originals.length === 0) {
        return { candidates: 0, softDeleted: 0, lastId: "" };
    }

    const originalIds = originals.map((media) => media._id);
    const result = await MediaModel.updateMany(
        {
            _id: { $in: originalIds },
            type: MediaType.VIDEO,
            resolution: Resolution.ORIGINAL,
            deletedAt: { $exists: false },
        },
        { $set: { deletedAt: new Date() } }
    );

    console.log(
        `[cleanup:originals] soft-deleted ${result.modifiedCount} original media ` +
        `(${originals.length} eligible file(s))`
    );
    return {
        candidates: originals.length,
        softDeleted: result.modifiedCount,
        lastId: String(originals[originals.length - 1]._id),
    };
};

// Normal cron: delete one bounded batch. Successfully deleted originals leave
// the active index, so the next run naturally advances without a process marker
// or persistent cursor.
export const cleanupOriginalMedia = async () => {
    try {
        const result = await purgeEligibleOriginals(NORMAL_BATCH);
        if (result.candidates === 0) {
            return { message: "No eligible original medias" };
        }
        return { message: "Success", data: result };
    } catch (error) {
        console.error("cleanupOriginalMedia -> Error:", error);
        return { message: "Internal server error" };
    }
};

// Manual full sweep remains cursor-compatible for callers that want to drain
// several batches immediately. Normal cron no longer requires this endpoint.
// GET /cron-job/cleanup-original-media?full=1[&cursor=<lastOriginalId>]
export const cleanupOriginalMediaFull = async (cursor: string) => {
    try {
        const result = await purgeEligibleOriginals(FULL_BATCH, cursor);
        return {
            message: result.candidates === 0 ? "Sweep done" : "Success",
            data: {
                done: result.candidates < FULL_BATCH,
                scanned: result.candidates,
                files: result.candidates,
                softDeleted: result.softDeleted,
                nextCursor: result.lastId || cursor,
            },
        };
    } catch (error) {
        console.error("cleanupOriginalMediaFull -> Error:", error);
        return { message: "Internal server error" };
    }
};
