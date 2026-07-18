import schedule from "node-schedule"
import mongoose from "mongoose"
import { getDownloadOriginal } from "@/services/cron-job/get-download-original.service"
import { getTransferPending } from "@/services/cron-job/get-transfer-pending.service"
import { releaseStaleJobs } from "@/services/cron-job/release-stale-jobs.service"

// enqueuer หนึ่งตัวต่อหนึ่ง cron — กันรอบใหม่ทับรอบเก่า + log เฉพาะตอนสถานะเปลี่ยน
const runEnqueuer = (name: string, fn: () => Promise<{ message?: string; data?: any } | undefined>) => {
    let running = false;
    let lastMessage = "";
    return async () => {
        // cron อาจยิงก่อน mongoose ต่อเสร็จ (bufferCommands=false จะ throw ทันที)
        // — ข้ามรอบนี้ไปเงียบๆ เดี๋ยวรอบหน้าก็มา
        if (mongoose.connection.readyState !== 1) return;
        if (running) return;
        running = true;
        try {
            const result = await fn();
            const enqueued = (result as any)?.data?.enqueued ?? 0;

            if (enqueued > 0) {
                console.log(`[${name}] enqueued ${enqueued} job(s)`);
            } else if (result?.message !== lastMessage) {
                // สถานะเปลี่ยน (เช่น worker หาย / disabled / กลับมาปกติ) ค่อยบอกที
                console.log(`[${name}] ${result?.message}`);
            }
            lastMessage = result?.message ?? "";
        } catch (err) {
            console.error(`[${name}] error:`, err);
        } finally {
            running = false;
        }
    };
};

// เหลื่อมวินาทีกัน — ไม่ยิง DB พร้อมกันเป๊ะทุกรอบ
schedule.scheduleJob("*/20 * * * * *", runEnqueuer("enqueuer:download", getDownloadOriginal));
schedule.scheduleJob("10,30,50 * * * * *", runEnqueuer("enqueuer:transfer", getTransferPending));

// reaper: worker ตายคางาน (heartbeat ขาดเกิน 3 นาที) → คืนงานเข้าคิว
schedule.scheduleJob("5 * * * * *", runEnqueuer("reaper", releaseStaleJobs));