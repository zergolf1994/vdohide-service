import { InferSchemaType, model, models, Schema, type Model } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { StorageType, StorageStatus, StorageAccept, StorageDrainState } from "@/core/enums";

// ─── Local Storage Config ────────────────────────────────────────────
// สำหรับ Nginx VOD server ที่เข้าถึงผ่าน SSH
const localConfigSchema = new Schema(
    {
        host: { type: String, required: true },
        port: { type: Number, default: 8888 },
        path: { type: String, default: "/home/files" },
        ssh: {
            username: { type: String },
            password: { type: String },
            port: { type: Number, default: 22 },
        },
    },
    { _id: false }
);

// ─── S3-Compatible Storage Config ────────────────────────────────────
// รองรับ AWS S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces ฯลฯ
const s3ConfigSchema = new Schema(
    {
        endpoint: { type: String },
        region: { type: String, default: "auto" },
        bucket: { type: String, required: true },
        prefix: { type: String, default: "" },
        accessKeyId: { type: String, required: true },
        secretAccessKey: { type: String, required: true },
        forcePathStyle: { type: Boolean, default: false },
    },
    { _id: false }
);

// ─── Main Storage Schema ─────────────────────────────────────────────
const storageSchema = new Schema(
    {
        _id: { type: String, default: uuidv4 },
        name: { type: String, required: true, unique: true },
        enable: { type: Boolean, required: true, default: false },
        type: {
            type: String,
            required: true,
            enum: Object.values(StorageType),
            default: StorageType.LOCAL,
        },
        status: {
            type: String,
            required: true,
            enum: Object.values(StorageStatus),
            default: StorageStatus.OFFLINE,
        },
        drainState: {
            type: String,
            required: true,
            enum: Object.values(StorageDrainState),
            default: StorageDrainState.IDLE,
        },
        drainTempStorageId: { type: String, ref: "Storage" },
        drainRequestedAt: { type: Date },
        drainCompletedAt: { type: Date },
        drainError: { type: String },

        // Discriminated config — ใช้ field ตาม type
        // type = "local" → ใช้ local config
        // type = "s3"    → ใช้ s3 config
        local: { type: localConfigSchema },
        s3: { type: s3ConfigSchema },
        publicUrl: { type: String },
        accepts: [{ type: String, enum: Object.values(StorageAccept) }],

        // Metadata & Stats
        heartbeatAt: { type: Date },
        capacity: {
            total: { type: Schema.Types.Mixed, default: 0 },
            used: { type: Schema.Types.Mixed, default: 0 },
            free: { type: Schema.Types.Mixed, default: 0 },
            percentage: { type: Number, default: 0 },
        },
    },
    {
        timestamps: true,
        versionKey: false,
        collection: "storages",
    }
);

// ─── Indexes ─────────────────────────────────────────────────────────
storageSchema.index({ type: 1, status: 1 });
storageSchema.index({ type: 1, drainState: 1 });

export type StorageSchemaType = InferSchemaType<typeof storageSchema>;
export const StorageModel: Model<StorageSchemaType> =
    (models?.Storage as Model<StorageSchemaType>)
    || model<StorageSchemaType>("Storage", storageSchema);
