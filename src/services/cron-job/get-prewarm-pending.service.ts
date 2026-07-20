import { FileStatus, FileType, MediaType, WorkerType } from "@/core/enums";
import { FileModel, MediaModel, PrewarmQueueModel } from "@/db/models";
import { getWorkers } from "../worker/get-workers.service";
import { getSettingsByNames } from "../setting/get-setting.service";

// setting "prewarm" — shape เดียวกับระบบเก่า (server-prewarm)
interface PrewarmSetting {
    enabled: boolean; // เปิด/ปิดงาน new (ยังไม่เคย warm บน pop นั้น)
    enabled_old: boolean; // เปิด/ปิดงาน reprewarm (warm ซ้ำของเก่า)
    prewarm_max_concurrent: number; // งาน new ค้างในคิวได้กี่ตัวต่อ pop
    prewarm_old_max_concurrent: number; // งาน reprewarm ค้างในคิวได้กี่ตัวต่อ pop
    prewarm_parallel: number; // worker อ่านเอง — HEAD พร้อมกันต่องาน new
    prewarm_old_parallel: number; // worker อ่านเอง — HEAD พร้อมกันต่องาน reprewarm
    reprewarm_age_minutes: number; // อายุก่อนถูก warm ซ้ำ (0 = ปิด)
}

const default_prewarm_setting: PrewarmSetting = {
    enabled: true,
    enabled_old: true,
    prewarm_max_concurrent: 1,
    prewarm_old_max_concurrent: 5,
    prewarm_parallel: 10,
    prewarm_old_parallel: 20,
    reprewarm_age_minutes: 60,
};

// enqueuer: เติมคิว prewarm_queue (คิวแยก ไม่ปน video_process) รายชิ้น media
// — worker warm เสร็จบันทึกผลลง medias.prewarm.{pop} แล้วลบ doc ทิ้ง
//
// กติกา:
//   - จ่ายงานตาม pop ของ worker ที่มีชีวิต (ไม่มี worker pop ไหน = ไม่จัดคิว pop นั้น)
//   - new (ยังไม่เคย warm บน pop นี้): pop อื่นต้องรอ fra warm เสร็จก่อน
//     และถ้า storage ของ media มี worker ผูกอยู่ (STORAGE_ID) → ประทับ
//     targetStorageId ให้ worker ตัวนั้นเท่านั้น claim
//   - reprewarm (เคย warm แล้ว เก่ากว่า reprewarm_age_minutes): worker ไหน
//     ก็ได้ มี/ไม่มี storageId ก็หยิบได้ — ไม่ประทับ target
// ยิงซ้ำได้ปลอดภัย — unique index {mediaId, pop} กันซ้ำ

const PREWARM_RESOLUTIONS = ["original", "1080", "720", "480", "360"];
const STALE_CLAIM_MS = 10 * 60 * 1000; // worker ตายคางาน → คืนคิว

// media ที่ warm ได้: วิดีโอทุก rendition
// (sprite ถอดออกชั่วคราว — จะกลับมาเปิดทีหลัง แค่คืนบรรทัด THUMBNAIL;
//  worker รองรับ type thumbnail อยู่แล้ว ไม่ต้องแก้ฝั่งนั้น)
const targetMediaFilter = {
    deletedAt: { $exists: false },
    $or: [
        { type: MediaType.VIDEO, resolution: { $in: PREWARM_RESOLUTIONS } },
        // { type: MediaType.THUMBNAIL, fileName: "sprite.vtt" },
    ],
};

// reprewarm ต้อง sort ด้วย prewarm.{pop}.prewarmAt — สร้าง index ครั้งแรกที่เจอ pop
const ensuredPopIndexes = new Set<string>();
const ensureReprewarmIndex = async (pop: string) => {
    if (ensuredPopIndexes.has(pop)) return;
    ensuredPopIndexes.add(pop);
    try {
        await MediaModel.collection.createIndex(
            { [`prewarm.${pop}.prewarmAt`]: 1 },
            { sparse: true, background: true }
        );
    } catch (error) {
        console.error(`ensureReprewarmIndex(${pop}) -> Error:`, error);
    }
};

// ── file gate: เอาเฉพาะ media ของไฟล์ที่เล่นได้จริง + คืน slug ประกอบ URL ──
const getPlayableFiles = async (fileIds: string[]) => {
    if (fileIds.length === 0) return new Map<string, string>();
    const files = await FileModel.find({
        _id: { $in: fileIds },
        type: FileType.VIDEO,
        status: FileStatus.READY,
        "metadata.trashedAt": { $exists: false },
        "metadata.deletedAt": { $exists: false },
    })
        .select({ _id: 1, slug: 1 })
        .lean();
    return new Map<string, string>((files as any[]).map((f) => [String(f._id), f.slug]));
};

export const getPrewarmPending = async () => {
    try {
        const settings = await getSettingsByNames(["prewarm"]);
        const cfg: PrewarmSetting = {
            ...default_prewarm_setting,
            ...(settings.prewarm ?? {}),
        };

        if (!cfg.enabled && !cfg.enabled_old) {
            return { message: "Prewarm is disabled" };
        }

        // reaper ในตัว: worker ตายคางาน (claim ค้างเกิน 10 นาที) → คืนคิว
        await PrewarmQueueModel.updateMany(
            {
                status: "processing",
                claimedAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) },
            },
            { $set: { status: "pending" }, $unset: { workerId: "", claimedAt: "" } }
        );

        const workers = await getWorkers({ type: WorkerType.PREWARM });
        if (workers.count === 0) return { message: "Worker prewarm not ready" };

        // จัดกลุ่ม worker ตาม pop (ไม่ระบุ = fra)
        const popWorkers = new Map<string, any[]>();
        for (const w of workers.data as any[]) {
            const pop = w.pop || "fra";
            if (!popWorkers.has(pop)) popWorkers.set(pop, []);
            popWorkers.get(pop)!.push(w);
        }

        const summary: Record<string, any> = {};

        for (const [pop, ws] of popWorkers) {
            // คิวแยกโควตาตามชนิดงาน — เหมือน bi-level scheduler ของระบบเก่า
            //   new: prewarm_max_concurrent คงที่ต่อ pop (งานไฟล์ใหม่ของเครื่องหลัก)
            //   reprewarm: prewarm_old_max_concurrent "ต่อเครื่อง" — 10 เครื่อง
            //   × 5 = 50 งานค้างได้พร้อมกัน
            const [openNew, openOld] = await Promise.all([
                PrewarmQueueModel.countDocuments({ pop, kind: "new" }),
                PrewarmQueueModel.countDocuments({ pop, kind: "reprewarm" }),
            ]);
            const slotsNew = cfg.enabled ? cfg.prewarm_max_concurrent - openNew : 0;
            const slotsOld = cfg.enabled_old
                ? cfg.prewarm_old_max_concurrent * ws.length - openOld
                : 0;
            if (slotsNew <= 0 && slotsOld <= 0) {
                summary[pop] = { openNew, openOld, message: "Queue is full" };
                continue;
            }

            // storage ที่มี worker ผูกอยู่ใน pop นี้ — งาน new ของ storage
            // พวกนี้ถูกประทับ target ให้ worker ตัวนั้นเท่านั้น
            const boundStorages = new Set<string>(
                ws.map((w: any) => w.storageId).filter(Boolean)
            );
            // ไม่มี worker แบบ pool (ไม่ผูก storage) เลย → งาน new ของ storage
            // อื่นจะไม่มีใคร claim ได้ — อย่าจัดเข้าคิว (กันงานค้างกิน slot)
            const hasPoolWorker = ws.some((w: any) => !w.storageId);

            const queuedMediaIds = await PrewarmQueueModel.distinct("mediaId", { pop });
            const excludeIds = new Set<string>(queuedMediaIds as string[]);

            const enqueueDocs: any[] = [];

            // ── new: ยังไม่เคย warm บน pop นี้ (ใหม่ก่อน — เหมือนระบบเก่า) ──
            // pop อื่นนอกจาก fra ต้องรอ fra เสร็จก่อนถึงจะเข้าคิวได้
            if (slotsNew > 0) {
                const newMedias = await MediaModel.find({
                    ...targetMediaFilter,
                    [`prewarm.${pop}`]: { $exists: false },
                    ...(pop !== "fra"
                        ? { "prewarm.fra.prewarmAt": { $exists: true } }
                        : {}),
                    ...(hasPoolWorker ? {} : { storageId: { $in: [...boundStorages] } }),
                    ...(excludeIds.size > 0 ? { _id: { $nin: [...excludeIds] } } : {}),
                })
                    .sort({ createdAt: -1 })
                    .limit(slotsNew * 3) // เผื่อโดน file gate ตัดทิ้ง
                    .select({ _id: 1, fileId: 1, slug: 1, type: 1, resolution: 1, storageId: 1 })
                    .lean();

                const newFileSlugs = await getPlayableFiles(
                    [...new Set((newMedias as any[]).map((m) => String(m.fileId)).filter(Boolean))]
                );
                let pickedNew = 0;
                for (const m of newMedias as any[]) {
                    if (pickedNew >= slotsNew) break;
                    const fileSlug = newFileSlugs.get(String(m.fileId));
                    if (!fileSlug) continue;
                    pickedNew++;
                    excludeIds.add(String(m._id));
                    enqueueDocs.push({
                        mediaId: m._id,
                        fileId: m.fileId,
                        slug: fileSlug,
                        mediaSlug: m.slug,
                        type: m.type,
                        resolution: m.resolution,
                        pop,
                        kind: "new",
                        status: "pending",
                        ...(m.storageId && boundStorages.has(m.storageId)
                            ? { targetStorageId: m.storageId }
                            : {}),
                    });
                }
            }

            // ── reprewarm: เคย warm แล้ว เก่ากว่า cutoff — worker ไหนก็ได้ ──
            if (slotsOld > 0 && cfg.reprewarm_age_minutes > 0) {
                await ensureReprewarmIndex(pop);
                const cutoff = new Date(Date.now() - cfg.reprewarm_age_minutes * 60_000);
                const oldMedias = await MediaModel.find({
                    ...targetMediaFilter,
                    [`prewarm.${pop}.prewarmAt`]: { $lt: cutoff },
                    ...(excludeIds.size > 0 ? { _id: { $nin: [...excludeIds] } } : {}),
                })
                    .sort({ [`prewarm.${pop}.prewarmAt`]: 1 }) // เก่าสุดก่อน
                    .limit(slotsOld * 3)
                    .select({ _id: 1, fileId: 1, slug: 1, type: 1, resolution: 1 })
                    .lean();

                const oldFileSlugs = await getPlayableFiles(
                    [...new Set((oldMedias as any[]).map((m) => String(m.fileId)).filter(Boolean))]
                );
                let pickedOld = 0;
                for (const m of oldMedias as any[]) {
                    if (pickedOld >= slotsOld) break;
                    const fileSlug = oldFileSlugs.get(String(m.fileId));
                    if (!fileSlug) continue;
                    pickedOld++;
                    enqueueDocs.push({
                        mediaId: m._id,
                        fileId: m.fileId,
                        slug: fileSlug,
                        mediaSlug: m.slug,
                        type: m.type,
                        resolution: m.resolution,
                        pop,
                        kind: "reprewarm",
                        status: "pending",
                    });
                }
            }

            if (enqueueDocs.length === 0) {
                summary[pop] = { openNew, openOld, message: "No media to enqueue" };
                continue;
            }

            let enqueued = 0;
            try {
                const inserted = await PrewarmQueueModel.insertMany(enqueueDocs, { ordered: false });
                enqueued = inserted.length;
            } catch (error: any) {
                // E11000 = ชนคิวที่มีอยู่ — ตัวที่เหลือเข้าไปแล้ว นับจากผลจริง
                if (error?.code !== 11000 && error?.writeErrors === undefined) throw error;
                enqueued = error?.insertedDocs?.length ?? 0;
            }
            summary[pop] = {
                openNew,
                openOld,
                slotsNew: Math.max(0, slotsNew),
                slotsOld: Math.max(0, slotsOld),
                candidates: enqueueDocs.length,
                enqueued,
            };
        }

        return { message: "Success", data: summary };
    } catch (error) {
        console.error("getPrewarmPending -> Error:", error);
        return { message: "Internal server error" };
    }
};
