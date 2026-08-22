import {
    FileStatus,
    IngestSourceType,
    IngestStatus,
    MediaType,
    Resolution,
    VIDEO_PROCESS_OPEN_STATUSES,
} from "@/core/enums";
import { FileModel, IngestModel, MediaModel, VideoProcessModel } from "@/db/models";

const BATCH_SIZE = 500;
const COMPLETION_GRACE_MS = 10 * 60 * 1000;

type CandidateIngest = {
    _id: string;
    fileId?: string | null;
    sourceType?: string | null;
    mediaType?: string | null;
    resolution?: string | null;
    fileName?: string | null;
};

type InstalledMedia = {
    fileId?: string | null;
    type?: string | null;
    resolution?: string | null;
    fileName?: string | null;
};

const hasInstalledProcessedMedia = (
    ingest: CandidateIngest,
    medias: InstalledMedia[],
): boolean => {
    const fileName = ingest.fileName?.trim();
    let expectedType = ingest.mediaType?.trim();
    let expectedResolution = ingest.resolution?.trim();
    let expectedFileName = fileName;

    // Compatibility with processed ingests created before mediaType/resolution
    // were persisted by every worker.
    if (fileName === "sprite.zip") {
        expectedType ||= MediaType.THUMBNAIL;
        expectedFileName = "sprite.vtt";
    } else if (/^file_(original|360|480|720|1080)\.mp4$/i.test(fileName || "")) {
        expectedType ||= MediaType.VIDEO;
        expectedResolution ||= fileName!.slice(5, -4).toLowerCase();
    } else if (/^audio_.+\.(m4a|aac)$/i.test(fileName || "")) {
        expectedType ||= MediaType.AUDIO;
    }

    return medias.some((media) => {
        if (expectedType && media.type !== expectedType) return false;
        if (expectedResolution && media.resolution !== expectedResolution) return false;
        if (expectedFileName && media.fileName !== expectedFileName) return false;
        return Boolean(expectedType || expectedResolution || expectedFileName);
    });
};

// Repair safety net for workers that completed their durable output but failed
// to soft-delete the source ingest (for example, a transient MongoDB timeout).
// This service only marks an ingest deleted after independently confirming its
// replacement. cleanupDeletedIngests remains responsible for deleting objects.
export const repairCompletedIngests = async () => {
    try {
        const completedBefore = new Date(Date.now() - COMPLETION_GRACE_MS);
        const candidates = await IngestModel.find({
            deletedAt: { $exists: false },
            status: IngestStatus.COMPLETED,
            sourceType: { $in: [IngestSourceType.UPLOAD, IngestSourceType.PROCESSED] },
            updatedAt: { $lte: completedBefore },
        })
            .sort({ updatedAt: 1, _id: 1 })
            .limit(BATCH_SIZE)
            .select({
                _id: 1,
                fileId: 1,
                sourceType: 1,
                mediaType: 1,
                resolution: 1,
                fileName: 1,
            })
            .lean() as CandidateIngest[];

        if (candidates.length === 0) {
            return { message: "No completed ingests to repair" };
        }

        const fileIds = [...new Set(candidates.map((ingest) => ingest.fileId).filter(Boolean))] as string[];
        const [files, medias, openProcessFileIds, activeProcessedFileIds] = await Promise.all([
            FileModel.find({
                _id: { $in: fileIds },
                "metadata.deletedAt": { $exists: false },
            })
                .select({ _id: 1, status: 1 })
                .lean(),
            MediaModel.find({
                fileId: { $in: fileIds },
                deletedAt: { $exists: false },
            })
                .select({ fileId: 1, type: 1, resolution: 1, fileName: 1 })
                .lean(),
            VideoProcessModel.distinct("fileId", {
                fileId: { $in: fileIds },
                status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
            }),
            IngestModel.distinct("fileId", {
                fileId: { $in: fileIds },
                sourceType: IngestSourceType.PROCESSED,
                status: IngestStatus.COMPLETED,
                deletedAt: { $exists: false },
            }),
        ]);

        const activeFiles = new Map(files.map((file: any) => [String(file._id), file]));
        const openFiles = new Set(openProcessFileIds.map(String));
        const filesWithProcessedOutput = new Set(activeProcessedFileIds.map(String));
        const mediasByFile = new Map<string, InstalledMedia[]>();
        for (const media of medias as InstalledMedia[]) {
            if (!media.fileId) continue;
            const fileId = String(media.fileId);
            const list = mediasByFile.get(fileId) ?? [];
            list.push(media);
            mediasByFile.set(fileId, list);
        }

        const repairIds: string[] = [];
        let waitingForProcess = 0;
        let missingReplacement = 0;

        for (const ingest of candidates) {
            const fileId = ingest.fileId ? String(ingest.fileId) : "";
            if (!fileId || !activeFiles.has(fileId)) {
                // Orphaned ingest or a File already removed by cleanup.
                repairIds.push(String(ingest._id));
                continue;
            }
            if (openFiles.has(fileId)) {
                waitingForProcess++;
                continue;
            }

            const file = activeFiles.get(fileId) as any;
            const installed = mediasByFile.get(fileId) ?? [];
            if (ingest.sourceType === IngestSourceType.UPLOAD) {
                const fileSettled = [FileStatus.READY, FileStatus.READY_ORIGINAL].includes(file.status);
                const hasInstalledVideo = installed.some((media) =>
                    media.type === MediaType.VIDEO &&
                    (!media.resolution || Object.values(Resolution).includes(media.resolution as Resolution))
                );
                if (fileSettled && (hasInstalledVideo || filesWithProcessedOutput.has(fileId))) {
                    repairIds.push(String(ingest._id));
                } else {
                    missingReplacement++;
                }
                continue;
            }

            if (hasInstalledProcessedMedia(ingest, installed)) {
                repairIds.push(String(ingest._id));
            } else {
                missingReplacement++;
            }
        }

        let repaired = 0;
        if (repairIds.length > 0) {
            const now = new Date();
            const result = await IngestModel.updateMany(
                {
                    _id: { $in: repairIds },
                    deletedAt: { $exists: false },
                    status: IngestStatus.COMPLETED,
                },
                { $set: { deletedAt: now, updatedAt: now } },
            );
            repaired = result.modifiedCount;
        }

        if (repaired > 0) {
            console.log(
                `[repair:ingests] soft-deleted ${repaired} completed ingest(s) ` +
                `(${candidates.length} scanned, ${waitingForProcess} active, ${missingReplacement} unmatched)`,
            );
            return {
                message: "Success",
                data: { scanned: candidates.length, repaired, waitingForProcess, missingReplacement },
            };
        }

        return {
            message: "No completed ingests eligible for repair",
            data: { scanned: candidates.length, repaired, waitingForProcess, missingReplacement },
        };
    } catch (error) {
        console.error("repairCompletedIngests -> Error:", error);
        return { message: "Internal server error" };
    }
};
