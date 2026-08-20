import { Schema, model, models, InferSchemaType, type Model } from "mongoose";
import { IngestMigrationState, IngestSourceType, IngestStatus } from "@/core/enums";
import { v4 as uuidv4 } from "uuid";

const ingestSchema = new Schema(
    {
        _id: { type: String, required: true, default: uuidv4 },
        // ว่างตอนสร้าง (สถานะ uploading) — จะถูก set ตอน save สร้าง File เสร็จ
        fileId: { type: String, ref: "File", index: true },
        storageId: { type: String, ref: "Storage", index: true },
        fileName: { type: String, required: true },
        status: {
            type: String,
            enum: Object.values(IngestStatus),
            default: IngestStatus.UPLOADING,
            index: true,
        },
        size: { type: Number, default: 0 },
        mimeType: { type: String },
        path: { type: String }, // path on storage (e.g. uploads/uuid.mp4)
        uploadedBy: { type: String, ref: "User" },
        sourceType: {
            type: String,
            enum: Object.values(IngestSourceType),
            default: IngestSourceType.UPLOAD,
        },
        migrationId: { type: String, index: true },
        migrationState: {
            type: String,
            enum: Object.values(IngestMigrationState),
        },
        sourceMediaId: { type: String, ref: "Media" },
        sourceStorageId: { type: String, ref: "Storage", index: true },
        sourcePath: { type: String },
        // processed asset contract used when durable S3 falls back to Temp
        mediaType: { type: String },
        resolution: { type: String },
        mediaMetadata: { type: Schema.Types.Mixed },
        installTarget: { type: String, enum: ["local"] },

        // ─── ปลายทางที่ resolve ไว้ตอนขอ upload URL ───────────────────
        // เก็บที่นี่เพราะ /save รับแค่ ingestId แล้วอ่านทุกอย่างจาก ingest
        // (resolve ตอน provider ทีเดียว ไม่ต้องส่ง slug มาซ้ำตอน save)
        spaceId: { type: String, ref: "Workspace", index: true },
        parentId: { type: String, ref: "File", index: true },
        // fingerprint ของ content — ใช้เป็น File.metadata.sourceHash (กันไฟล์ซ้ำ)
        sourceHash: { type: String, index: true },
        // "profile" = avatar (ไฟล์ระดับ user ไม่ผูก workspace) / ปกติเป็น undefined
        purpose: { type: String },
        // path บน UI ปลายทาง — ส่งกลับเป็น `page` ให้ client นำทางหลังอัพเสร็จ
        relativePath: { type: String },
        deletedAt: { type: Date }
    },
    {
        timestamps: true,
        versionKey: false,
        collection: "ingests",
    }
);

ingestSchema.index({ fileId: 1, status: 1 });
ingestSchema.index({ deletedAt: 1 });
ingestSchema.index(
    { migrationId: 1, sourceMediaId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            sourceType: IngestSourceType.MIGRATION,
            deletedAt: { $exists: false },
        },
    }
);

export type IngestSchemaType = InferSchemaType<typeof ingestSchema>;
export const IngestModel: Model<IngestSchemaType> =
    (models?.Ingest as Model<IngestSchemaType>) ||
    model<IngestSchemaType>("Ingest", ingestSchema);
