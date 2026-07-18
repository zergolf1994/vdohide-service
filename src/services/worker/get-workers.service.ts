import { WorkerType } from "@/core/enums";
import { WorkerModel } from "@/db/models";

// heartbeat มาทุก 1 นาที — ขาดเกิน 3 นาที = ตาย ไม่นับ slot
const WORKER_HEARTBEAT_TTL_MS = 3 * 60 * 1000;

// worker ที่ "รับงานได้": enable + heartbeat สด (status ไม่ใช่ตัวตัดสิน — ดู worker.enum)
export const getWorkers = async ({ type }: { type: WorkerType }) => {
    try {
        const aliveSince = new Date(Date.now() - WORKER_HEARTBEAT_TTL_MS);
        const workers = await WorkerModel.find({
            type,
            enable: true,
            heartbeatAt: { $gte: aliveSince },
        }).lean();

        return { count: workers.length, data: workers };
    } catch (error) {
        console.error("getWorkers -> Error:", error);
        return { count: 0, data: [] };
    }
};
