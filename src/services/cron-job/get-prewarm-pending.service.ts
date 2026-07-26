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

// เผื่อคิวล่วงหน้า 3 เท่าของจำนวนที่ worker รันพร้อมกัน — งานจบเป็นวินาที
// แต่ cron เติมทุก 1 นาที ถ้าคิว = จำนวน slot พอดี worker จะว่างรอรอบเติม
const QUEUE_BUFFER = 3;

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

// ช่องเก่ากรอง+sort ด้วย prewarm.{pop}.prewarmAt (เอาเฉพาะ doc ที่มี field
// จริงและเก่ากว่า cutoff) — index ตัวนี้คือตัวที่ทำให้ query ไม่ต้องสแกนทั้ง
// collection
const ensuredPopIndexes = new Set<string>();
const ensureReprewarmIndex = async (pop: string) => {
    if (ensuredPopIndexes.has(pop)) return;
    ensuredPopIndexes.add(pop);
    try {
        await MediaModel.collection.createIndex({ [`prewarm.${pop}.prewarmAt`]: 1 });
    } catch (error: any) {
        // 85 IndexOptionsConflict / 86 IndexKeySpecsConflict — เวอร์ชันก่อน
        // เคยสร้างแบบ sparse ไว้ ลบทิ้งแล้วสร้างใหม่ให้ครอบ missing-field ด้วย
        if (error?.code === 85 || error?.code === 86) {
            try {
                await MediaModel.collection.dropIndex(`prewarm.${pop}.prewarmAt_1`);
                await MediaModel.collection.createIndex({ [`prewarm.${pop}.prewarmAt`]: 1 });
                return;
            } catch (e) {
                console.error(`ensureReprewarmIndex(${pop}) recreate -> Error:`, e);
                return;
            }
        }
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
            // สองช่องคิดคนละโควตา ไม่แย่งกัน — bi-level scheduler แบบระบบเก่า
            //   new (ยังไม่เคย warm): prewarm_max_concurrent "ต่อ storage"
            //     — warm ครั้งแรก CF ต้อง MISS ไปดูดจาก origin จริง ปล่อยเยอะ
            //     พร้อมกันจะกินแบนด์วิดท์ (1Gbps) ของ storage นั้น
            //   reprewarm (warm แล้ว เก่ากว่า cutoff): prewarm_old_max_concurrent
            //     "ต่อเครื่อง" — ส่วนใหญ่ CF ยัง HIT อยู่ ไม่แตะ origin
            //     จึงไม่ต้องคิดโควตาต่อ storage
            const [openNew, openOld] = await Promise.all([
                PrewarmQueueModel.countDocuments({ pop, kind: "new" }),
                PrewarmQueueModel.countDocuments({ pop, kind: "reprewarm" }),
            ]);
            const slotsOld = cfg.enabled_old
                ? cfg.prewarm_old_max_concurrent * ws.length * QUEUE_BUFFER - openOld
                : 0;

            // โควตา firstWarm ที่ใช้ไปแล้วต่อ storage — ตอนนี้มีแต่งาน kind:"new"
            // ที่ประทับ firstWarm (ช่อง reprewarm ไม่ประทับแล้ว) แต่ยังนับจาก
            // field นี้เพื่อให้ doc เก่าที่ค้างคิวอยู่ก่อนแก้ยังถูกนับด้วย
            // × QUEUE_BUFFER เหมือนช่องเก่า — งานจบใน 10-20 วิ ถ้าคิวมีแค่ 1
            // worker จะว่างรอรอบ cron 40-50 วิ; เติมล่วงหน้าให้ทำต่อเนื่องได้
            const capPerStorage = cfg.prewarm_max_concurrent * QUEUE_BUFFER;
            const usedAgg = await PrewarmQueueModel.aggregate([
                { $match: { pop, firstWarm: true } },
                { $group: { _id: "$storageId", n: { $sum: 1 } } },
            ]);
            const usedPerStorage = new Map<string, number>(
                (usedAgg as any[]).map((x) => [String(x._id ?? ""), x.n])
            );
            const takeStorageSlot = (storageId: any) => {
                const sid = String(storageId ?? "");
                const used = usedPerStorage.get(sid) ?? 0;
                if (used >= capPerStorage) return false;
                usedPerStorage.set(sid, used + 1);
                return true;
            };

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
            // จำกัดคิวค้างไม่เกิน capPerStorage ต่อ storage (คุมแบนด์วิดท์ origin)
            if (cfg.enabled) {
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
                    .limit(Math.max(60, capPerStorage * 20)) // เผื่อโดน cap/file gate ตัดทิ้ง
                    .select({ _id: 1, fileId: 1, slug: 1, type: 1, resolution: 1, storageId: 1 })
                    .lean();

                const newFileSlugs = await getPlayableFiles(
                    [...new Set((newMedias as any[]).map((m) => String(m.fileId)).filter(Boolean))]
                );
                for (const m of newMedias as any[]) {
                    const fileSlug = newFileSlugs.get(String(m.fileId));
                    if (!fileSlug) continue;
                    if (!takeStorageSlot(m.storageId)) continue; // storage นี้เต็มโควตา — รอบหน้า
                    excludeIds.add(String(m._id));
                    enqueueDocs.push({
                        mediaId: m._id,
                        fileId: m.fileId,
                        slug: fileSlug,
                        mediaSlug: m.slug,
                        type: m.type,
                        resolution: m.resolution,
                        storageId: m.storageId,
                        firstWarm: true,
                        pop,
                        kind: "new",
                        status: "pending",
                        ...(m.storageId && boundStorages.has(m.storageId)
                            ? { targetStorageId: m.storageId }
                            : {}),
                    });
                }
            }

            // ── ช่องเก่า: warm ซ้ำเฉพาะตัวที่ "เคย warm แล้ว" และเก่ากว่า cutoff
            // ไม่รวม backlog (ยังไม่เคย warm) เพราะ:
            //   1) doc ที่ไม่มี field จะถูก sort เป็น null = มาก่อนสุดเสมอ พอมี
            //      backlog เยอะ ตัวที่ถึงเวลา re-warm จริงจะไม่โผล่ใน limit เลย
            //   2) backlog กินแบนด์วิดท์ origin จึงต้องคุมด้วยโควตาต่อ storage
            //      ซึ่งเป็นงานของช่อง new อยู่แล้ว — เอามาปนทำให้ช่องนี้ตัน
            if (slotsOld > 0 && cfg.reprewarm_age_minutes > 0) {
                await ensureReprewarmIndex(pop);
                const cutoff = new Date(Date.now() - cfg.reprewarm_age_minutes * 60_000);
                const { $or: typeOr, ...restTarget } = targetMediaFilter as any;
                const oldMedias = await MediaModel.find({
                    ...restTarget,
                    $and: [
                        { $or: typeOr },
                        { [`prewarm.${pop}.prewarmAt`]: { $lt: cutoff } },
                        // fra-first: pop อื่นแตะได้เฉพาะ media ที่ fra warm แล้ว
                        ...(pop !== "fra"
                            ? [{ "prewarm.fra.prewarmAt": { $exists: true } }]
                            : []),
                    ],
                    ...(excludeIds.size > 0 ? { _id: { $nin: [...excludeIds] } } : {}),
                })
                    .sort({ [`prewarm.${pop}.prewarmAt`]: 1 })
                    .limit(slotsOld * 3)
                    .select({
                        _id: 1, fileId: 1, slug: 1, type: 1, resolution: 1,
                        storageId: 1, [`prewarm.${pop}.prewarmAt`]: 1,
                    })
                    .lean();

                const oldFileSlugs = await getPlayableFiles(
                    [...new Set((oldMedias as any[]).map((m) => String(m.fileId)).filter(Boolean))]
                );
                let pickedOld = 0;
                for (const m of oldMedias as any[]) {
                    if (pickedOld >= slotsOld) break;
                    const fileSlug = oldFileSlugs.get(String(m.fileId));
                    if (!fileSlug) continue;
                    // ไม่แตะโควตาต่อ storage — ช่องนี้คุมด้วย slotsOld ของตัวเอง
                    pickedOld++;
                    enqueueDocs.push({
                        mediaId: m._id,
                        fileId: m.fileId,
                        slug: fileSlug,
                        mediaSlug: m.slug,
                        type: m.type,
                        resolution: m.resolution,
                        storageId: m.storageId,
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
                slotsOld: Math.max(0, slotsOld),
                firstWarmPerStorage: Object.fromEntries(usedPerStorage),
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
