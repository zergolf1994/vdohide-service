import {
    FileStatus,
    FileType,
    IngestSourceType,
    VideoProcessStatus,
    VIDEO_PROCESS_OPEN_STATUSES,
    WorkerType,
} from "@/core/enums";
import { FileModel, IngestModel, VideoProcessModel } from "@/db/models";
import { getLocalStorages } from "../storage/get-storage.service";
import { getWorkers } from "../worker/get-workers.service";
import { getSettingsByNames } from "../setting/get-setting.service";

interface TransferConfig {
    enabled: boolean;
    slotRate: number;
}

const default_transfer_config: TransferConfig = {
    enabled: true,
    slotRate: 2,
};

// ─── Storage balance ─────────────────────────────────────────
// เลือก storage ปลายทางให้ไฟล์: เอาตัวที่ % ต่ำสุด (±2%) แล้วกระจาย
// tie ด้วย fnv1a(fileId) — deterministic ทุกที่คำนวณได้ตรงกัน
const STORAGE_BALANCE_MARGIN_PERCENT = 2;

const fnv1a32 = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
};

const capacityPercent = (s: any): number => s?.capacity?.percentage ?? 0;

const pickBalancedStorage = (fileId: string, storages: any[]): string | null => {
    if (storages.length === 0) return null;
    if (storages.length === 1) return storages[0]._id;

    const minPct = Math.min(...storages.map(capacityPercent));
    const candidates = storages
        .filter((s) => capacityPercent(s) <= minPct + STORAGE_BALANCE_MARGIN_PERCENT)
        .sort((a, b) => String(a._id).localeCompare(String(b._id)));

    return candidates[fnv1a32(fileId) % candidates.length]._id;
};

// enqueuer: ไฟล์ที่มี ingest "processed" ค้างบน S3 temp → เติมเป็นงาน transfer
// pending พร้อม targetStorageId (worker claim เฉพาะงานของ storage ตัวเอง)
// ยิงซ้ำได้ปลอดภัย — partial unique index {fileId, processType} กันซ้ำ
export const getTransferPending = async () => {
    try {
        const settings = await getSettingsByNames(["transfer_config"]);
        const transfer_config: TransferConfig = {
            ...default_transfer_config,
            ...(settings.transfer_config ?? {}),
        };

        if (!transfer_config.enabled) {
            return { message: "Transfer is disabled" };
        }

        const [storages, workers] = await Promise.all([
            getLocalStorages(),
            getWorkers({ type: WorkerType.TRANSFER }),
        ]);

        if (storages.count === 0) return { message: "No local storage available" };
        if (workers.count === 0) return { message: "Worker transfer not ready" };

        // slot แยกราย storage — งานถูกผูกกับ storage ปลายทาง จ่ายข้ามเครื่องไม่ได้
        // นับความจุจาก worker ที่ยังสด (storageId บน heartbeat) ลบงานค้างของ storage นั้น
        const slotsByStorage = new Map<string, number>();
        for (const w of workers.data as any[]) {
            if (!w.storageId) continue;
            slotsByStorage.set(
                w.storageId,
                (slotsByStorage.get(w.storageId) ?? 0) + (w.maxJobs || 1) * transfer_config.slotRate
            );
        }

        const openJobs = await VideoProcessModel.find(
            { processType: WorkerType.TRANSFER, status: { $in: VIDEO_PROCESS_OPEN_STATUSES } },
            { targetStorageId: 1 }
        ).lean();
        for (const j of openJobs as any[]) {
            if (!j.targetStorageId) continue;
            slotsByStorage.set(j.targetStorageId, (slotsByStorage.get(j.targetStorageId) ?? 0) - 1);
        }

        const totalSlots = [...slotsByStorage.values()].reduce((sum, n) => sum + Math.max(0, n), 0);
        if (totalSlots <= 0) {
            return { message: "Queue is full", data: { slotsByStorage: Object.fromEntries(slotsByStorage) } };
        }

        // balance เฉพาะ storage ที่มี worker สดรองรับ — ไม่งั้นงานจะค้างคิวไม่มีคนหยิบ
        const targetableStorages = (storages.data as any[]).filter((s) => slotsByStorage.has(s._id));
        if (targetableStorages.length === 0) {
            return { message: "No storage with alive transfer worker" };
        }

        // candidate = ไฟล์ที่มี ingest processed ค้าง และไม่มีงาน transfer
        // ค้าง/failed (failed = รอ admin สั่ง retry) และ download จบแล้ว
        const [pendingIngestFileIds, blockedFileIds, downloadingFileIds] = await Promise.all([
            IngestModel.distinct("fileId", {
                sourceType: IngestSourceType.PROCESSED,
                deletedAt: { $exists: false },
            }),
            VideoProcessModel.distinct("fileId", {
                processType: WorkerType.TRANSFER,
                // failed/cancelled = terminal ที่ต้องรอ admin สั่ง retry ที่ doc เดิม
                // — ห้ามเติมคิวใหม่เอง ไม่งั้น cancel แล้วเด้งกลับมาใน 20 วิ
                status: {
                    $in: [
                        ...VIDEO_PROCESS_OPEN_STATUSES,
                        VideoProcessStatus.FAILED,
                        VideoProcessStatus.CANCELLED,
                    ],
                },
            }),
            VideoProcessModel.distinct("fileId", {
                processType: WorkerType.DOWNLOAD,
                status: VideoProcessStatus.PROCESSING,
            }),
        ]);

        const excluded = new Set([...blockedFileIds, ...downloadingFileIds]);
        const candidateIds = (pendingIngestFileIds as string[]).filter((id) => id && !excluded.has(id));
        if (candidateIds.length === 0) {
            return { message: "No files to enqueue", data: { totalSlots } };
        }

        const files = await FileModel.find({
            _id: { $in: candidateIds },
            type: FileType.VIDEO,
            status: { $in: [FileStatus.READY_ORIGINAL, FileStatus.READY] },
            clonedFrom: { $exists: false },
            "metadata.trashedAt": { $exists: false },
            "metadata.deletedAt": { $exists: false },
        })
            .sort({ createdAt: 1 })
            .limit(totalSlots * 3) // เผื่อบางไฟล์ assign ไป storage ที่ slot หมด
            .select({ _id: 1, spaceId: 1, slug: 1 })
            .lean();

        // จ่ายงานตาม balance + ตัดตาม slot คงเหลือราย storage
        const docs: any[] = [];
        for (const f of files as any[]) {
            const target = pickBalancedStorage(String(f._id), targetableStorages);
            if (!target) continue;
            const remain = slotsByStorage.get(target) ?? 0;
            if (remain <= 0) continue;
            slotsByStorage.set(target, remain - 1);

            docs.push({
                fileId: f._id,
                spaceId: f.spaceId,
                slug: f.slug,
                processType: WorkerType.TRANSFER,
                status: VideoProcessStatus.PENDING,
                targetStorageId: target,
                timeline: {
                    download: { status: "pending" },
                    extract: { status: "pending" },
                    install: { status: "pending" },
                    media: { status: "pending" },
                },
            });
        }

        if (docs.length === 0) {
            return { message: "No files to enqueue", data: { totalSlots, candidates: files.length } };
        }

        let enqueued = 0;
        try {
            const inserted = await VideoProcessModel.insertMany(docs, { ordered: false });
            enqueued = inserted.length;
        } catch (error: any) {
            // E11000 = ชนคิวที่มีอยู่ — ตัวที่เหลือเข้าไปแล้ว นับจากผลจริง
            if (error?.code !== 11000 && error?.writeErrors === undefined) throw error;
            enqueued = error?.insertedDocs?.length ?? 0;
        }

        return {
            message: "Success",
            data: {
                totalSlots,
                candidates: candidateIds.length,
                enqueued,
            },
        };
    } catch (error) {
        console.error("getTransferPending -> Error:", error);
        return { message: "Internal server error" };
    }
};
