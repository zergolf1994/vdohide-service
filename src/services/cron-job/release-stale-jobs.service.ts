import { VideoProcessStatus } from "@/core/enums";
import { VideoProcessModel, WorkerModel } from "@/db/models";

// ─── Reaper ──────────────────────────────────────────────────
// งาน processing ที่ worker เจ้าของตายไปแล้ว (heartbeat ขาด) → คืน pending
// ให้ worker ตัวอื่นหยิบต่อ — ไม่นับเป็น retry (ไม่ใช่ความผิดของงาน)
//
// ⚠ ตัดสินจาก heartbeat ของ worker เจ้าของ ไม่ใช่อายุของ claimedAt/updatedAt —
//   งานใหญ่ (ไฟล์หลาย GB) ใช้เวลาเป็นชั่วโมงได้ และ worker เขียน DB เฉพาะขอบ
//   step ดังนั้น updatedAt นิ่งนานไม่ได้แปลว่างานค้าง แต่ heartbeat ขาด = ตายจริง

const WORKER_HEARTBEAT_TTL_MS = 3 * 60 * 1000; // ต้องตรงกับ getWorkers
const CLAIM_GRACE_MS = 2 * 60 * 1000; // งานที่เพิ่ง claim สดๆ ยังไม่ต้องยุ่ง

export const releaseStaleJobs = async () => {
    try {
        const jobs = await VideoProcessModel.find(
            { status: VideoProcessStatus.PROCESSING },
            { workerId: 1, claimedAt: 1, processType: 1, slug: 1 }
        ).lean();

        if (jobs.length === 0) return { message: "No processing jobs", data: { released: 0 } };

        const workerIds = [...new Set(jobs.map((j: any) => j.workerId).filter(Boolean))];
        const aliveSince = new Date(Date.now() - WORKER_HEARTBEAT_TTL_MS);
        const aliveWorkerIds = await WorkerModel.distinct("workerId", {
            workerId: { $in: workerIds },
            heartbeatAt: { $gte: aliveSince },
        });
        const alive = new Set(aliveWorkerIds as string[]);

        const graceCutoff = new Date(Date.now() - CLAIM_GRACE_MS);
        const stale = (jobs as any[]).filter(
            (j) =>
                (!j.workerId || !alive.has(j.workerId)) &&
                (!j.claimedAt || j.claimedAt < graceCutoff)
        );
        if (stale.length === 0) return { message: "All workers alive", data: { released: 0 } };

        // status เช็คซ้ำใน filter — งานที่ worker เพิ่ง Complete/Release ไประหว่างรอบนี้จะไม่โดนทับ
        const result = await VideoProcessModel.updateMany(
            { _id: { $in: stale.map((j) => j._id) }, status: VideoProcessStatus.PROCESSING },
            {
                $set: { status: VideoProcessStatus.PENDING },
                $unset: { workerId: "", claimedAt: "" },
            }
        );

        if (result.modifiedCount > 0) {
            console.log(
                `[reaper] released ${result.modifiedCount} stale job(s):`,
                stale.map((j) => `${j.processType}/${j.slug ?? j._id} (worker=${j.workerId ?? "-"})`).join(", ")
            );
        }
        return { message: "Success", data: { released: result.modifiedCount } };
    } catch (error) {
        console.error("releaseStaleJobs -> Error:", error);
        return { message: "Internal server error" };
    }
};
