import { randomString } from "@/core/utils";
import { FileStatus, FileType } from "@/core/enums";
import { Schema, model, models, InferSchemaType, type Model } from "mongoose";
import { v4 as uuidv4 } from "uuid";

// ─── File Metadata ───────────────────────────────────────────────────
const fileMetadataSchema = new Schema(
    {
        description: { type: String },
        views: { type: Schema.Types.Mixed },
        duration: { type: Number },
        highest: { type: Number },
        mimeType: { type: String },
        size: { type: Schema.Types.Mixed },
        trashedAt: { type: Date },
        trashedBy: { type: String, ref: "User" },
        deletedAt: { type: Date },
        deletedBy: { type: String, ref: "User" },
        source: { type: String },
        sourceType: { type: String },
        sourceHash: { type: String, index: true },
        playlist: { type: String },
        purpose: { type: String },
    },
    {
        _id: false
    }
);


const fileSchema = new Schema(
    {
        _id: { type: String, required: true, default: uuidv4 },
        status: { type: String, enum: Object.values(FileStatus), default: FileStatus.WAITING },
        type: { type: String, enum: Object.values(FileType), default: FileType.VIDEO },
        name: { type: String, required: true },
        creatorId: { type: String, ref: "User", index: true },
        parentId: { type: String, ref: "File", index: true },
        spaceId: { type: String, ref: "Workspace", index: true },
        slug: { type: String, unique: true, default: () => randomString(11) },
        clonedFrom: { type: String, ref: "File" },
        metadata: { type: fileMetadataSchema },
    },
    { timestamps: true, versionKey: false, collection: "files" }
);

fileSchema.index({ spaceId: 1, type: 1 });
fileSchema.index({ spaceId: 1, parentId: 1 });
fileSchema.index({ spaceId: 1, status: 1 });
fileSchema.index({ creatorId: 1, spaceId: 1 });
fileSchema.index({ slug: 1, spaceId: 1 });

// Admin queries — ไม่ scope ด้วย spaceId
fileSchema.index({ parentId: 1, "metadata.trashedAt": 1, createdAt: -1 }); // admin files page
fileSchema.index({ "metadata.trashedAt": 1, "metadata.deletedAt": 1, createdAt: -1 }); // admin trash + delete-permanent
fileSchema.index({ clonedFrom: 1, "metadata.deletedAt": 1, "metadata.trashedAt": 1, createdAt: 1 }); // clone promotion/repair

export type FileSchemaType = InferSchemaType<typeof fileSchema>;

export const FileModel: Model<FileSchemaType> =
    (models?.File as Model<FileSchemaType>) ||
    model<FileSchemaType>("File", fileSchema);
