import { StorageAccept, StorageDrainState, StorageStatus, StorageType } from "@/core/enums";
import { StorageModel } from "@/db/models";

// local storage ที่รับไฟล์เพิ่มได้ (transfer ปลายทาง) — เต็มเกิน cutoff = ไม่รับ
// cutoff ปรับได้ที่ transfer_config.maxPercent (service เป็นเจ้าของค่า) default 95
const DEFAULT_MAX_PERCENT = 95;

export const getLocalStorages = async (maxPercent: number = DEFAULT_MAX_PERCENT) => {
    try {
        const storages = await StorageModel.find({
            enable: true,
            status: StorageStatus.ONLINE,
            type: StorageType.LOCAL,
            $or: [
                { "capacity.percentage": { $lt: maxPercent } },
                { "capacity.percentage": { $exists: false } },
                { capacity: { $exists: false } },
            ],
        }).sort({ "capacity.percentage": 1, _id: 1 });

        return { count: storages.length, data: storages }
    } catch (error) {
        console.error("getLocalStorages -> Error:", error);
        return { count: 0, data: [] }
    }
};

export const getTempStorages = async () => {
    try {
        const storages = await StorageModel.find({
            enable: true,
            status: StorageStatus.ONLINE,
            accepts: { $all: [StorageAccept.TEMP, StorageAccept.VIDEO] }
        });

        return { count: storages.length, data: storages }

    } catch (error) {
        return { count: 0, data: [] }
    }
};

// S3 ถาวรสำหรับเก็บ media ที่พร้อมเล่น ไม่รวม bucket temp และ storage ที่
// กำลัง drain อยู่ ค่า capacity ของ S3 อาจดูแลจากภายนอก จึงไม่ใช้เป็น gate
// บังคับเหมือน local disk.
export const getPermanentS3Storages = async () => {
    try {
        const storages = await StorageModel.find({
            enable: true,
            status: StorageStatus.ONLINE,
            type: StorageType.S3,
            accepts: { $all: [StorageAccept.STORAGE, StorageAccept.VIDEO] },
            $or: [
                { drainState: StorageDrainState.IDLE },
                { drainState: { $exists: false } },
            ],
            originUrl: { $exists: true, $nin: [null, ""] },
            publicUrl: { $exists: true, $nin: [null, ""] },
            "s3.bucket": { $exists: true, $nin: [null, ""] },
        }).sort({ "capacity.percentage": 1, _id: 1 });

        return { count: storages.length, data: storages };
    } catch (error) {
        console.error("getPermanentS3Storages -> Error:", error);
        return { count: 0, data: [] };
    }
};
