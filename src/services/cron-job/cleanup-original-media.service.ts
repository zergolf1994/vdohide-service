import {
    MediaType,
    Resolution,
    VideoProcessStatus,
    VIDEO_PROCESS_OPEN_STATUSES,
    WorkerType,
} from "@/core/enums";
import { FileModel, MediaModel, VideoProcessModel } from "@/db/models";

// cleanup: ไฟล์ที่มี rendition ขนาด = metadata.highest ติดตั้งแล้ว →
// soft-delete media `original` (storage-node ลบไฟล์จริงตาม refcount)
//
// ── ออกแบบให้ไม่ scan ทั้ง collection (500K+ ไฟล์) ──
// original จะลบได้ก็ต่อเมื่อ "rendition เพิ่งถูกติดตั้ง" เท่านั้น — จุดนั้น
// รู้ได้จากงาน transfer ที่ status=completed ใน video_process ซึ่งมีอยู่
// ไม่กี่ doc เสมอ (archive cron ย้ายออกภายใน ~10 นาที) → cron โหมดปกติ
// เช็คเฉพาะไฟล์ของงานพวกนั้น O(งานที่เพิ่งเสร็จ) ไม่ใช่ O(ไฟล์ทั้งหมด)
//
// โหมด full sweep (ยิง manual: ?full=1&cursor=...) — ไล่ medias original
// ทีละหน้าด้วย _id cursor สำหรับเก็บตกของเก่า/ช่วง service down

const FULL_BATCH = 2000;

// ─── แกนตัดสินร่วม: รับ fileIds → soft-delete originals ที่เข้าเงื่อนไข ───
const purgeOriginalsFor = async (fileIds: string[]) => {
    if (fileIds.length === 0) return { files: 0, softDeleted: 0 };

    const [files, busyFileIds] = await Promise.all([
        FileModel.find({
            _id: { $in: fileIds },
            "metadata.highest": { $exists: true, $gt: 0 },
        })
            .select({ _id: 1, "metadata.highest": 1 })
            .lean(),
        // งานค้างชนิดไหนก็ตาม = อย่าเพิ่งแตะ original ของไฟล์นั้น
        // (transcode ใช้ original เป็น input / transfer กำลังติดตั้ง)
        VideoProcessModel.distinct("fileId", {
            fileId: { $in: fileIds },
            status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
        }),
    ]);
    const busy = new Set(busyFileIds as string[]);

    const highestByFile = new Map<string, string>();
    for (const f of files as any[]) {
        if (!busy.has(String(f._id))) {
            highestByFile.set(String(f._id), String(f.metadata.highest));
        }
    }
    if (highestByFile.size === 0) return { files: 0, softDeleted: 0 };

    // ต้องมีทั้ง original ที่ยังไม่ลบ และ rendition = highest ติดตั้งแล้ว
    const medias = await MediaModel.find({
        fileId: { $in: [...highestByFile.keys()] },
        type: MediaType.VIDEO,
        deletedAt: { $exists: false },
        $or: [
            { resolution: Resolution.ORIGINAL },
            { resolution: { $in: [...new Set(highestByFile.values())] } },
        ],
    })
        .select({ fileId: 1, resolution: 1 })
        .lean();

    const hasOriginal = new Set<string>();
    const hasHighest = new Set<string>();
    for (const m of medias as any[]) {
        const fid = String(m.fileId);
        if (String(m.resolution) === Resolution.ORIGINAL) hasOriginal.add(fid);
        else if (highestByFile.get(fid) === String(m.resolution)) hasHighest.add(fid);
    }
    const qualified = [...hasHighest].filter((fid) => hasOriginal.has(fid));
    if (qualified.length === 0) return { files: 0, softDeleted: 0 };

    const result = await MediaModel.updateMany(
        {
            fileId: { $in: qualified },
            type: MediaType.VIDEO,
            resolution: Resolution.ORIGINAL,
            deletedAt: { $exists: false },
        },
        { $set: { deletedAt: new Date() } }
    );

    console.log(`[cleanup:originals] soft-deleted ${result.modifiedCount} original media (${qualified.length} file(s))`);
    return { files: qualified.length, softDeleted: result.modifiedCount };
};

// ─── โหมดปกติ (cron): เฉพาะไฟล์ของงาน transfer ที่เพิ่งเสร็จ ───
export const cleanupOriginalMedia = async () => {
    try {
        // completed ยังไม่ถูก archive (หน้าต่าง ~10 นาที) — ใช้ index
        // {processType, status, ...} เดิม มีไม่กี่ doc เสมอ
        const fileIds = await VideoProcessModel.distinct("fileId", {
            processType: WorkerType.TRANSFER,
            status: VideoProcessStatus.COMPLETED,
        });

        if (fileIds.length === 0) {
            return { message: "No recently transferred files" };
        }

        const { files, softDeleted } = await purgeOriginalsFor(fileIds as string[]);
        return {
            message: "Success",
            data: { candidates: fileIds.length, files, softDeleted },
        };
    } catch (error) {
        console.error("cleanupOriginalMedia -> Error:", error);
        return { message: "Internal server error" };
    }
};

// ─── โหมด full sweep (manual): ไล่ medias original ทีละหน้าด้วย cursor ───
// GET /cron-job/cleanup-original-media?full=1[&cursor=<lastId>]
// ยิงซ้ำโดยส่ง nextCursor ที่ได้กลับมา จนกว่า done=true
export const cleanupOriginalMediaFull = async (cursor: string) => {
    try {
        const filter: Record<string, any> = {
            type: MediaType.VIDEO,
            resolution: Resolution.ORIGINAL,
            deletedAt: { $exists: false },
        };
        if (cursor) filter._id = { $gt: cursor };

        const originals = await MediaModel.find(filter)
            .sort({ _id: 1 })
            .limit(FULL_BATCH)
            .select({ _id: 1, fileId: 1 })
            .lean();

        if (originals.length === 0) {
            return { message: "Sweep done", data: { done: true } };
        }

        const fileIds = [...new Set((originals as any[]).map((m) => String(m.fileId)).filter(Boolean))];
        const { files, softDeleted } = await purgeOriginalsFor(fileIds);

        const last = originals[originals.length - 1] as any;
        return {
            message: "Success",
            data: {
                done: originals.length < FULL_BATCH,
                scanned: originals.length,
                files,
                softDeleted,
                nextCursor: String(last._id),
            },
        };
    } catch (error) {
        console.error("cleanupOriginalMediaFull -> Error:", error);
        return { message: "Internal server error" };
    }
};
