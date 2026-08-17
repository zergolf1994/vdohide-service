import {
    FileStatus,
    FileType,
    IngestMigrationState,
    IngestSourceType,
    TransferMode,
    VideoProcessStatus,
    VIDEO_PROCESS_OPEN_STATUSES,
    WorkerType,
} from "@/core/enums";
import { FileModel, IngestModel, VideoProcessModel } from "@/db/models";
import { getLocalStorages, getPermanentS3Storages } from "../storage/get-storage.service";
import { getWorkers } from "../worker/get-workers.service";
import { getSettingsByNames } from "../setting/get-setting.service";

interface TransferConfig {
    enabled: boolean;
    slotRate: number;
    /** เต็มเกินกี่ % = ไม่รับไฟล์ใหม่ (cutoff) — worker ยังมี safety guard ที่สูงกว่า */
    maxPercent: number;
    /** ช่วง % ที่ถือว่า "ว่างพอๆ กัน" แล้วกระจายงาน — กว้าง = spread หลาย storage */
    balanceGap: number;
}

const default_transfer_config: TransferConfig = {
    enabled: true,
    slotRate: 2,
    maxPercent: 95,
    balanceGap: 8,
};

// ─── Storage balance ─────────────────────────────────────────
// เลือก storage ปลายทางให้ไฟล์: เอาตัวที่ % ต่ำสุด (±gap) แล้วกระจาย
// tie ด้วย fnv1a(fileId) — deterministic ทุกที่คำนวณได้ตรงกัน
const fnv1a32 = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
};

const capacityPercent = (s: any): number => s?.capacity?.percentage ?? 0;

const pickBalancedStorage = (fileId: string, storages: any[], balanceGap: number): string | null => {
    if (storages.length === 0) return null;
    if (storages.length === 1) return storages[0]._id;

    const minPct = Math.min(...storages.map(capacityPercent));
    const candidates = storages
        .filter((s) => capacityPercent(s) <= minPct + balanceGap)
        .sort((a, b) => String(a._id).localeCompare(String(b._id)));

    return candidates[fnv1a32(fileId) % candidates.length]._id;
};

// enqueuer: ไฟล์ที่มี ingest "processed" ค้างบน S3 temp → เติมเป็นงาน transfer
// pending พร้อม targetStorageId (worker claim เฉพาะงานของ storage ตัวเอง)
// ถ้า permanent S3 มี worker ของตัวเอง ให้ worker นั้นติดตั้งตรงเข้า S3 ก่อน;
// ถ้าไม่มีจึงใช้ local worker เป็น executor แล้วส่งต่อไป permanent S3
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

        const [storages, permanentS3Storages, workers] = await Promise.all([
            getLocalStorages(transfer_config.maxPercent),
            getPermanentS3Storages(),
            getWorkers({ type: WorkerType.TRANSFER }),
        ]);

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

        // executor มีได้สองแบบ:
        // 1) worker ที่ผูกกับ permanent S3 เดียวกับปลายทาง (ทางตรงและควรเลือกก่อน)
        // 2) worker ที่ผูกกับ local storage ทำหน้าที่อัปโหลดต่อไป permanent S3
        // targetStorageId คือ executor เสมอ ส่วน destinationStorageId คือปลายทางจริง
        const localExecutors = (storages.data as any[]).filter((s) => slotsByStorage.has(String(s._id)));
        const permanentS3 = permanentS3Storages.data as any[];
        const directS3Executors = permanentS3.filter((s) => slotsByStorage.has(String(s._id)));
        if (localExecutors.length === 0 && directS3Executors.length === 0) {
            return { message: "No storage with alive transfer worker" };
        }

        // candidate = ไฟล์ที่มี ingest processed ค้าง และไม่มีงาน transfer
        // ค้าง/failed (failed = รอ admin สั่ง retry) และ download จบแล้ว
        const [
            pendingIngestFileIds,
            normalIngestFileIds,
            blockedFileIds,
            blockedMigrationIds,
            openMigrationInstallFileIds,
            downloadingFileIds,
        ] = await Promise.all([
            IngestModel.distinct("fileId", {
                $or: [
                    { sourceType: IngestSourceType.PROCESSED },
                    {
                        sourceType: IngestSourceType.MIGRATION,
                        migrationState: IngestMigrationState.STAGED,
                    },
                ],
                deletedAt: { $exists: false },
            }),
            IngestModel.distinct("fileId", {
                sourceType: IngestSourceType.PROCESSED,
                deletedAt: { $exists: false },
            }),
            VideoProcessModel.distinct("fileId", {
                processType: WorkerType.TRANSFER,
                migrationId: { $exists: false },
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
            VideoProcessModel.distinct("migrationId", {
                processType: WorkerType.TRANSFER,
                migrationId: { $exists: true },
                status: {
                    $in: [
                        ...VIDEO_PROCESS_OPEN_STATUSES,
                        VideoProcessStatus.FAILED,
                        VideoProcessStatus.CANCELLED,
                    ],
                },
            }),
            VideoProcessModel.distinct("fileId", {
                processType: WorkerType.TRANSFER,
                transferMode: TransferMode.INSTALL,
                migrationId: { $exists: true },
                status: { $in: VIDEO_PROCESS_OPEN_STATUSES },
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

        const migrationIngests = await IngestModel.find(
            {
                fileId: { $in: files.map((file) => file._id) },
                sourceType: IngestSourceType.MIGRATION,
                migrationState: IngestMigrationState.STAGED,
                migrationId: { $nin: blockedMigrationIds },
                deletedAt: { $exists: false },
            },
            { fileId: 1, migrationId: 1, sourceStorageId: 1, sourceMediaId: 1 }
        )
            .sort({ createdAt: 1, _id: 1 })
            .lean();
        const migrationByFile = new Map<string, {
            migrationId: string;
            sourceStorageId: string;
            sourceMediaIds: string[];
        }>();
        const openMigrationInstallFiles = new Set(openMigrationInstallFileIds.map(String));
        const normalIngestFiles = new Set(normalIngestFileIds.map(String));
        for (const ingest of migrationIngests as any[]) {
            const fileId = String(ingest.fileId);
            if (
                migrationByFile.has(fileId) ||
                openMigrationInstallFiles.has(fileId)
            ) {
                continue;
            }
            migrationByFile.set(fileId, {
                migrationId: String(ingest.migrationId),
                sourceStorageId: String(ingest.sourceStorageId),
                sourceMediaIds: ingest.sourceMediaId
                    ? [String(ingest.sourceMediaId)]
                    : [],
            });
        }

        // จ่ายงานตาม balance + ตัดตาม slot คงเหลือราย storage
        const docs: any[] = [];
        for (const f of files as any[]) {
            const fileId = String(f._id);
            if (openMigrationInstallFiles.has(fileId)) continue;

            const migration = migrationByFile.get(fileId);
            if (!migration && !normalIngestFiles.has(fileId)) continue;

            // เลือกเฉพาะ executor ที่ยังเหลือ slot ป้องกัน hash ไปตก storage เต็ม
            // แล้วข้ามงาน ทั้งที่ storage ตัวอื่นยังรับได้
            const availableDirectS3 = directS3Executors.filter(
                (storage) => (slotsByStorage.get(String(storage._id)) ?? 0) > 0,
            );
            const availableLocal = localExecutors.filter(
                (storage) => (slotsByStorage.get(String(storage._id)) ?? 0) > 0,
            );

            // Permanent S3 ที่มี worker ผูก storageId เดียวกันรับงานโดยตรง
            // targetStorageId และ destinationStorageId จึงเป็น ID เดียวกัน
            const directS3 = pickBalancedStorage(fileId, availableDirectS3, transfer_config.balanceGap);
            const executor = directS3 ?? pickBalancedStorage(fileId, availableLocal, transfer_config.balanceGap);
            if (!executor) continue;
            const remain = slotsByStorage.get(executor) ?? 0;
            if (remain <= 0) continue;
            slotsByStorage.set(executor, remain - 1);

            // ถ้าใช้ local executor ให้เลือก permanent S3 เป็นปลายทางถ้ามี;
            // ถ้าไม่มี permanent S3 จะไม่ใส่ destinationStorageId และติดตั้ง local
            const s3Destination = directS3 ?? pickBalancedStorage(fileId, permanentS3, transfer_config.balanceGap);

            docs.push({
                fileId: f._id,
                spaceId: f.spaceId,
                slug: f.slug,
                processType: WorkerType.TRANSFER,
                status: VideoProcessStatus.PENDING,
                transferMode: TransferMode.INSTALL,
                targetStorageId: executor,
                ...(s3Destination ? { destinationStorageId: s3Destination } : {}),
                ...(migration
                    ? {
                        sourceStorageId: migration.sourceStorageId,
                        migrationId: migration.migrationId,
                        sourceMediaIds: migration.sourceMediaIds,
                    }
                    : {}),
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
