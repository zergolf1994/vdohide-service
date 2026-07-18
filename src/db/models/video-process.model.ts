import { Schema, model, models, InferSchemaType, type Model } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { VideoProcessStatus, VIDEO_PROCESS_OPEN_STATUSES, WorkerType } from "@/core/enums";

// ─── video_process = คิว + ตัวงาน ในตัวเดียวกัน ─────────────────────
// enqueuer สร้างเป็น status=pending → Go worker (server-download) claim เป็น processing
//
// ⚠ ชื่อ field ต้องตรงกับ Go struct ที่อ่าน/เขียนอยู่ (fileId, processType, file_name,
//   timeline, overallPercent ...) ไม่งั้นเติมคิวไปแล้ว worker หยิบไม่เจอ / อ่าน field ผิด
//   ของใหม่ที่เพิ่มเพื่อ queue: priority, claimedAt (Go จะปรับมารองรับทีหลัง)
// ───────────────────────────────────────────────────────────────────
const videoProcessSchema = new Schema(
    {
        _id: { type: String, required: true, default: uuidv4 },

        // download/transcode → ชี้ File | (prewarm ค่อยว่ากันแยกทีหลัง)
        fileId: { type: String, ref: "File", index: true },
        spaceId: { type: String, ref: "Workspace", index: true },
        slug: { type: String, index: true },

        // ต้อง match กับ worker.type — จ่ายงานให้เฉพาะ worker ชนิดเดียวกัน
        processType: { type: String, enum: Object.values(WorkerType), default: WorkerType.DOWNLOAD },
        status: {
            type: String,
            enum: Object.values(VideoProcessStatus),
            default: VideoProcessStatus.PENDING,
        },

        // สูง = ได้ทำก่อน (enqueuer ใช้จัดลำดับคิว)
        priority: { type: Number, default: 5 },

        workerId: { type: String, index: true },
        // เฉพาะงาน transfer — enqueuer เลือก storage ปลายทาง (balance) แล้วประทับไว้
        // worker claim เฉพาะงานที่ targetStorageId = STORAGE_ID ของเครื่องตัวเอง
        targetStorageId: { type: String, ref: "Storage" },
        // worker เซ็ตตอน claim — reaper ใช้จับงานค้าง (worker ตายคาไว้)
        claimedAt: { type: Date },
        // fail แล้วรอ retry (backoff) — worker จะไม่ claim จนกว่าถึงเวลา
        // ครบ MaxRetries (3) → failed ถาวร + file ถูก mark error
        nextRetryAt: { type: Date },

        // progress ที่ Go เขียนระหว่างทำงาน (แกนของ progress bar ฝั่ง admin)
        overallPercent: { type: Number },
        timeline: { type: Schema.Types.Mixed },

        // snake_case ตาม bson tag ของ Go — ห้ามเปลี่ยนเป็น camelCase
        file_name: { type: String },
        file_size: { type: Number },
        resolution: { type: String },
        sourceType: { type: String },
        m3u8_url: { type: String },

        resolutions: [{ type: String }],
        completed: [{ type: String }],

        error: { type: String },
        errorCategory: { type: String },
        retryCount: { type: Number, default: 0 },
    },
    { timestamps: true, versionKey: false, collection: "video_process" }
);

// worker claim: findOneAndUpdate({processType, status: pending}, sort {priority:-1, createdAt:1})
// ลำดับ key ต้องตรงกับ sort เป๊ะ ไม่งั้น mongo in-memory sort แล้วช้าขึ้นตามคิวที่ยาว
videoProcessSchema.index({ processType: 1, status: 1, priority: -1, createdAt: 1 });

// transfer claim: เพิ่ม targetStorageId ใน filter (worker หยิบเฉพาะงานของ storage ตัวเอง)
videoProcessSchema.index({ processType: 1, status: 1, targetStorageId: 1, priority: -1, createdAt: 1 });

// นับงานของ worker แต่ละตัว (slot) + reaper
videoProcessSchema.index({ workerId: 1, status: 1 });
// reaper: {status: processing, claimedAt < cutoff}
videoProcessSchema.index({ status: 1, claimedAt: 1 });

// กันเติมคิวซ้ำไฟล์เดิม — enqueuer เช็คก่อน insert อยู่แล้ว แต่ check-then-act มีช่องว่างเสมอ
// (loop รอบก่อนยังไม่จบแล้วรอบใหม่เริ่มทับ) index นี้คือตัวรับประกันจริง insert ซ้ำได้ E11000
// partial เฉพาะงานที่ยังค้าง — จบแล้ว fileId เดิมเข้าคิวใหม่ได้ (retry / re-encode)
videoProcessSchema.index(
    { fileId: 1, processType: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: VIDEO_PROCESS_OPEN_STATUSES } },
    }
);

export type VideoProcessSchemaType = InferSchemaType<typeof videoProcessSchema>;

export const VideoProcessModel: Model<VideoProcessSchemaType> =
    (models?.VideoProcess as Model<VideoProcessSchemaType>) ||
    model<VideoProcessSchemaType>("VideoProcess", videoProcessSchema);
