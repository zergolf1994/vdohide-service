import { MediaType, Resolution } from "@/core/enums";
import { FileModel, MediaModel } from "@/db/models";

// ตรวจ Original เป็นชุดแบบมี cursor แทน aggregation ที่ lookup ทุก Original
// ก่อนค่อย limit ซึ่งจะช้าลงเรื่อย ๆ เมื่อไฟล์ที่ยังแปลงไม่เสร็จสะสมมากขึ้น
const NORMAL_BATCH = 2000;
const FULL_BATCH = 2000;
const TRANSCODED_RESOLUTIONS = new Set<string>([
    Resolution.R1080,
    Resolution.R720,
    Resolution.R480,
    Resolution.R360,
]);

interface OriginalCandidate {
    _id: string;
    fileId: string;
}

interface PurgeResult {
    scanned: number;
    candidates: number;
    softDeleted: number;
    lastScannedId: string;
}

// cursor ของ cron ปกติอยู่ใน process เดียวกัน โดย runEnqueuer ป้องกันการรันซ้อน
// เมื่อเดินถึงท้าย collection จะวนกลับต้นใหม่ เพื่อให้ Original ที่เพิ่งมี
// rendition ครบหลังจากถูกตรวจไปแล้วกลับมาถูกตรวจในรอบ sweep ถัดไป
let normalCursor = "";

const findOriginalBatch = async (limit: number, afterId = "") => {
    const filter: Record<string, unknown> = {
        type: MediaType.VIDEO,
        resolution: Resolution.ORIGINAL,
        deletedAt: { $exists: false },
        fileId: { $type: "string" },
    };
    if (afterId) filter._id = { $gt: afterId };

    return MediaModel.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .select({ _id: 1, fileId: 1 })
        .lean<OriginalCandidate[]>();
};

const findEligibleOriginalIds = async (originals: OriginalCandidate[]) => {
    if (originals.length === 0) return [];

    const fileIds = [...new Set(originals.map((media) => media.fileId))];
    const files = await FileModel.find({
        _id: { $in: fileIds },
        "metadata.highest": { $exists: true, $gt: 0 },
    })
        .select({ _id: 1, "metadata.highest": 1 })
        .lean();

    // แบ่งตาม resolution เพื่อให้แต่ละ query ใช้ index
    // {fileId, resolution, type, deletedAt} ได้ตรง ๆ โดยไม่ต้องใช้ $expr/$lookup
    const fileIdsByHighest = new Map<string, string[]>();
    for (const file of files) {
        const highest = String(file.metadata?.highest ?? "");
        if (!TRANSCODED_RESOLUTIONS.has(highest)) continue;
        fileIdsByHighest.set(highest, [
            ...(fileIdsByHighest.get(highest) ?? []),
            String(file._id),
        ]);
    }

    const playableFileIds = new Set<string>();
    await Promise.all(
        [...fileIdsByHighest.entries()].map(async ([resolution, ids]) => {
            const matchedIds = await MediaModel.distinct("fileId", {
                fileId: { $in: ids },
                type: MediaType.VIDEO,
                resolution,
                deletedAt: { $exists: false },
            });
            for (const fileId of matchedIds) playableFileIds.add(String(fileId));
        })
    );

    return originals
        .filter((media) => playableFileIds.has(media.fileId))
        .map((media) => media._id);
};

const purgeOriginalBatch = async (limit: number, afterId = ""): Promise<PurgeResult> => {
    const originals = await findOriginalBatch(limit, afterId);
    if (originals.length === 0) {
        return {
            scanned: 0,
            candidates: 0,
            softDeleted: 0,
            lastScannedId: "",
        };
    }

    const originalIds = await findEligibleOriginalIds(originals);
    let softDeleted = 0;

    if (originalIds.length > 0) {
        const result = await MediaModel.updateMany(
            {
                _id: { $in: originalIds },
                type: MediaType.VIDEO,
                resolution: Resolution.ORIGINAL,
                deletedAt: { $exists: false },
            },
            { $set: { deletedAt: new Date() } }
        );
        softDeleted = result.modifiedCount;

        console.log(
            `[cleanup:originals] soft-deleted ${softDeleted} original media ` +
            `(${originalIds.length} eligible, ${originals.length} scanned)`
        );
    }

    return {
        scanned: originals.length,
        candidates: originalIds.length,
        softDeleted,
        lastScannedId: String(originals[originals.length - 1]._id),
    };
};

// Normal cron: ตรวจเพียงหนึ่ง bounded batch ต่อรอบ และเลื่อน cursor จากรายการ
// ที่ "ตรวจแล้ว" ไม่ใช่เฉพาะรายการที่ลบได้ จึงไม่ติดอยู่กับ Original กลุ่มเดิม
export const cleanupOriginalMedia = async () => {
    try {
        let result = await purgeOriginalBatch(NORMAL_BATCH, normalCursor);

        // เดินถึงท้าย collection แล้ว: วนกลับต้นทันทีในรอบเดียวกัน เพื่อไม่เสีย cron
        if (result.scanned === 0 && normalCursor) {
            normalCursor = "";
            result = await purgeOriginalBatch(NORMAL_BATCH);
        }

        normalCursor = result.scanned < NORMAL_BATCH ? "" : result.lastScannedId;

        if (result.scanned === 0) {
            return { message: "No original medias to scan", data: result };
        }
        if (result.candidates === 0) {
            return { message: "No eligible original medias", data: result };
        }
        return { message: "Success", data: result };
    } catch (error) {
        console.error("cleanupOriginalMedia -> Error:", error);
        return { message: "Internal server error" };
    }
};

// Manual full sweep ใช้ cursor จาก caller และคืน cursor จากรายการสุดท้ายที่ตรวจ
// GET /cron-job/cleanup-original-media?full=1[&cursor=<lastScannedId>]
export const cleanupOriginalMediaFull = async (cursor: string) => {
    try {
        const result = await purgeOriginalBatch(FULL_BATCH, cursor);
        return {
            message: result.scanned === 0 ? "Sweep done" : "Success",
            data: {
                done: result.scanned < FULL_BATCH,
                scanned: result.scanned,
                files: result.candidates,
                softDeleted: result.softDeleted,
                nextCursor: result.lastScannedId || cursor,
            },
        };
    } catch (error) {
        console.error("cleanupOriginalMediaFull -> Error:", error);
        return { message: "Internal server error" };
    }
};
