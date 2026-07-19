import { Schema, model, models, InferSchemaType, type Model } from "mongoose";

// ─── video_process_history = ที่เก็บงานที่จบแล้ว (archived) ─────────
// cron archive:processes ย้าย completed ที่เก่ากว่า 5 นาทีมาลงที่นี่
// เพื่อให้คิวหลัก (video_process) เหลือแต่งาน active — enqueuer scan เร็ว
//
// ⚠ schema นี้ต้องตรงกับ vdohide monorepo (packages/db) — mongoose สร้าง
//   index ตอน start ถ้าสอง repo นิยามไม่ตรงกัน index จะตีกัน (บทเรียน
//   จาก refId_1_type_1 เก่าที่ block คิวทั้งระบบ)
const videoProcessHistorySchema = new Schema(
    {
        _id: { type: String, required: true },
        // เก็บโครงเดียวกับ video_process เดิมทั้ง doc (ไม่ validate ซ้ำ —
        // ข้อมูลถูก validate มาแล้วตอนอยู่คิวหลัก)
        archivedAt: { type: Date, required: true },
    },
    {
        timestamps: false,
        versionKey: false,
        collection: "video_process_history",
        strict: false, // รับทุก field จาก doc เดิม (fileId, timeline, ...)
    }
);

// ประวัติหมดอายุเอง 30 วันหลังย้ายเข้า — ไม่ต้องมี cron ลบเพิ่ม
videoProcessHistorySchema.index({ archivedAt: 1 }, { expireAfterSeconds: 2592000 });

// หน้า admin ดูประวัติ: filter ตาม processType/status เรียงใหม่สุดก่อน
videoProcessHistorySchema.index({ processType: 1, archivedAt: -1 });
videoProcessHistorySchema.index({ fileId: 1 });

export type VideoProcessHistorySchemaType = InferSchemaType<typeof videoProcessHistorySchema>;

export const VideoProcessHistoryModel: Model<VideoProcessHistorySchemaType> =
    (models?.VideoProcessHistory as Model<VideoProcessHistorySchemaType>) ||
    model<VideoProcessHistorySchemaType>("VideoProcessHistory", videoProcessHistorySchema);
