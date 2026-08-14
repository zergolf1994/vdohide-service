import schedule from "node-schedule"
import mongoose from "mongoose"
import { getDownloadOriginal } from "@/services/cron-job/get-download-original.service"
import { getTransferPending } from "@/services/cron-job/get-transfer-pending.service"
import { getSpritesheetPending } from "@/services/cron-job/get-spritesheet-pending.service"
import { getTranscodePending } from "@/services/cron-job/get-transcode-pending.service"
import { getPrewarmPending } from "@/services/cron-job/get-prewarm-pending.service"
import { releaseStaleJobs } from "@/services/cron-job/release-stale-jobs.service"
import { cleanupDeletedIngests } from "@/services/cron-job/cleanup-deleted-ingests.service"
import { cleanupDeletedMedias } from "@/services/cron-job/cleanup-deleted-medias.service"
import { cleanupDeletedFiles } from "@/services/cron-job/cleanup-deleted-files.service"
import { archiveCompletedProcesses } from "@/services/cron-job/archive-completed-processes.service"
import { updateWorkspaceUsage } from "@/services/cron-job/update-workspace-usage.service"
import { cleanupOriginalMedia } from "@/services/cron-job/cleanup-original-media.service"
import { getStorageDrainPending } from "@/services/cron-job/get-storage-drain-pending.service"
import { cleanupDeletedWorkspaces } from "@/services/cron-job/cleanup-deleted-workspaces.service"
import { verifyCustomDomains } from "@/services/cron-job/verify-custom-domains.service"

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
schedule.scheduleJob("0,20,40 * * * * *", runEnqueuer("enqueuer:storage-drain", getStorageDrainPending));
schedule.scheduleJob("15,45 * * * * *", runEnqueuer("enqueuer:spritesheet", getSpritesheetPending));
schedule.scheduleJob("25,55 * * * * *", runEnqueuer("enqueuer:transcode", getTranscodePending));
// prewarm งานไม่รีบเท่าตัวอื่น (ผู้ชมเล่นได้อยู่แล้ว แค่ช้ากว่าตอน MISS)
// — ทุก 1 นาทีพอ
schedule.scheduleJob("50 * * * * *", runEnqueuer("enqueuer:prewarm", getPrewarmPending));

// reaper: worker ตายคางาน (heartbeat ขาดเกิน 3 นาที) → คืนงานเข้าคิว
schedule.scheduleJob("5 * * * * *", runEnqueuer("reaper", releaseStaleJobs));

// ingest cleanup ทุก 1 นาที: ลบ object บน S3 ของ ingest ที่ soft-delete แล้ว
// file cleanup ทุก 5 นาที: ลบ doc ที่ไม่เหลือ ingest/media อ้างอิง
schedule.scheduleJob("35 * * * * *", runEnqueuer("cleanup:ingests", cleanupDeletedIngests));
schedule.scheduleJob("30 */2 * * * *", runEnqueuer("cleanup:files", cleanupDeletedFiles));

// archive: completed ค้างเกิน 5 นาที → ย้ายไป video_process_history (TTL 30 วัน)
// คิวหลักเหลือแต่งาน active + failed/cancelled
schedule.scheduleJob("15 */5 * * * *", runEnqueuer("archive:processes", archiveCompletedProcesses));

// usage: รวม files.size ราย workspace → workspaces.capacity.used
schedule.scheduleJob("45 * * * * *", runEnqueuer("update:workspace-usage", updateWorkspaceUsage));

// originals: rendition = highest ติดตั้งแล้ว → soft-delete media original
// (storage-node เป็นคนลบไฟล์จริงตาม refcount)
schedule.scheduleJob("40 */5 * * * *", runEnqueuer("cleanup:originals", cleanupOriginalMedia));

// medias: media ที่ soft-delete แล้ว "บน S3" → ลบ object จริง (m3u8+segments) แล้วลบ doc
// (local ปล่อยให้ storage-node จัดการ refcount เอง — S3 มันเข้าไม่ถึง)
schedule.scheduleJob("50 */5 * * * *", runEnqueuer("cleanup:medias", cleanupDeletedMedias));

// workspaces: hobby waits 10 minutes; paid plans wait until both deletion and
// subscription expiry. Child files are drained by the existing cleanup jobs.
schedule.scheduleJob("12 * * * * *", runEnqueuer("cleanup:workspaces", cleanupDeletedWorkspaces));

// custom domains: cron only claims records whose dns.nextVerifyAt is due.
// schedule.scheduleJob("32 * * * * *", runEnqueuer("verify:domains", verifyCustomDomains));
