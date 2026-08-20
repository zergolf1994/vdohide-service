import { InferSchemaType, model, models, Schema, type Model } from "mongoose";
import { randomString } from "@/core/utils";
import { MediaType } from "@/core/enums";
import { v4 as uuidv4 } from "uuid";

const mediaMetadataSchema = new Schema(
    {
        size: { type: Schema.Types.Mixed, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
        duration: { type: Number, default: 0 },
        directUrl: { type: String },
        sourceIndex: { type: Number },
        sourceCodec: { type: String },
        codec: { type: String },
        language: { type: String },
        title: { type: String },
        isDefault: { type: Boolean },
        isForced: { type: Boolean },
        channels: { type: Number },
        sampleRate: { type: Number },
        bitrate: { type: Number },
        mediaLayout: { type: String, enum: ["muxed", "separated"] },
    },
    {
        _id: false
    }
);
//ถ้าไม่มี userId / fileId ไฟล์ของระบบ
const mediaSchema = new Schema(
    {
        _id: { type: String, required: true, default: uuidv4 },
        type: { type: String, enum: Object.values(MediaType), default: MediaType.VIDEO },
        fileName: { type: String },
        mimeType: { type: String },
        resolution: { type: String, index: true },
        storageId: { type: String, index: true, ref: "Storage" },
        slug: { type: String, unique: true, default: () => randomString(11) },
        path: { type: String },
        sourceHash: { type: String, index: true },
        // fileId: 1:1 relationship กับ File
        fileId: { type: String, ref: "File", index: true },
        // userId: 1:1 relationship กับ User (user อัพโหลดไฟล์ เช่น รูปโปรไฟล์)
        // userId: { type: String, ref: "User", index: true },
        clonedFrom: { type: String, ref: "Media", index: true },
        metadata: mediaMetadataSchema,
        prewarm: {
            type: Map,
            of: new Schema({
                data: new Schema({
                    total: { type: Number, default: 0 },
                    hit: { type: Number, default: 0 },
                    miss: { type: Number, default: 0 },
                    expired: { type: Number, default: 0 },
                    failed: { type: Number, default: 0 },
                }, { _id: false }),
                prewarmAt: { type: Date },
            }, { _id: false }),
        },
        deletedAt: { type: Date }
    },
    {
        timestamps: true,
        versionKey: false,
        collection: "medias",
    }
);

mediaSchema.index({ fileId: 1, resolution: 1, type: 1, deletedAt: 1 });
mediaSchema.index({ type: 1, resolution: 1, deletedAt: 1, _id: 1 }); // cleanup originals aggregation
mediaSchema.index({ fileId: 1, type: 1, fileName: 1, deletedAt: 1 }); // clone media repair
mediaSchema.index({ fileId: 1, type: 1, "metadata.sourceIndex": 1, deletedAt: 1 }); // separated audio/subtitle tracks
mediaSchema.index({ createdAt: -1 }); // admin medias page — sort by createdAt
mediaSchema.index({ deletedAt: 1 }); // admin overview — countDocuments

export type MediaSchemaType = InferSchemaType<typeof mediaSchema>;
export const MediaModel: Model<MediaSchemaType> =
    (models?.Media as Model<MediaSchemaType>) ||
    model<MediaSchemaType>("Media", mediaSchema);
