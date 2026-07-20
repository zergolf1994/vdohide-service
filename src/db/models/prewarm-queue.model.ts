import { Schema, model, models, InferSchemaType, type Model } from "mongoose";
import { v4 as uuidv4 } from "uuid";

// ─── prewarm_queue = คิวแยกของงาน prewarm (ไม่ปน video_process) ─────
// enqueuer สร้าง pending รายชิ้น media → worker-prewarm claim เป็น processing
// → warm เสร็จบันทึกผลลง medias.prewarm.{pop} แล้ว "ลบ doc ทิ้ง"
// (คิวนี้เก็บเฉพาะงานค้าง — สถานะถาวรอยู่บน media ไม่ใช่ที่นี่)
//
// ⚠ ชื่อ field ต้องตรงกับ Go struct ของ worker-prewarm
// ───────────────────────────────────────────────────────────────────
const prewarmQueueSchema = new Schema(
    {
        _id: { type: String, required: true, default: uuidv4 },

        mediaId: { type: String, ref: "Media", required: true },
        fileId: { type: String, ref: "File", index: true },
        slug: { type: String }, // file slug — ใช้ประกอบ URL master/sprite
        mediaSlug: { type: String }, // media slug — ใช้ประกอบ URL video.m3u8

        type: { type: String }, // video | thumbnail
        resolution: { type: String },
        // storage ของ media (ข้อมูลประกอบ + ใช้คุมโควตา firstWarm ต่อ storage)
        storageId: { type: String, ref: "Storage" },
        // true = media ยังไม่เคย warm บน pop นี้ — warm ครั้งแรก CF MISS ดูด
        // จาก origin จริง enqueuer จำกัดงานค้างต่อ storage ด้วย field นี้
        firstWarm: { type: Boolean },
        pop: { type: String, required: true }, // edge ที่งานนี้จะ warm (เช่น fra, sin)
        kind: { type: String, default: "new" }, // new | reprewarm

        // เฉพาะงาน new ที่ storage ของ media มี worker ผูกอยู่ — worker ที่ตั้ง
        // STORAGE_ID จะ claim งาน new เฉพาะของ storage ตัวเอง
        // (งาน reprewarm ไม่ประทับ — worker ไหนก็หยิบได้)
        targetStorageId: { type: String, ref: "Storage" },

        status: { type: String, default: "pending" }, // pending | processing
        workerId: { type: String },
        claimedAt: { type: Date },
        nextRetryAt: { type: Date },
        error: { type: String },
        retryCount: { type: Number, default: 0 },
    },
    { timestamps: true, versionKey: false, collection: "prewarm_queue" }
);

// media หนึ่งชิ้นมีงานค้างได้ pop ละ 1 งาน (doc ถูกลบเมื่อเสร็จ ไม่ต้อง partial)
prewarmQueueSchema.index({ mediaId: 1, pop: 1 }, { unique: true });

// worker claim: findOneAndUpdate({pop, status: pending, ...}, sort {createdAt: 1})
prewarmQueueSchema.index({ pop: 1, status: 1, createdAt: 1 });

export type PrewarmQueue = InferSchemaType<typeof prewarmQueueSchema>;

export const PrewarmQueueModel: Model<PrewarmQueue> =
    models?.PrewarmQueue || model<PrewarmQueue>("PrewarmQueue", prewarmQueueSchema);
