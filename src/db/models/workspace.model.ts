import { Schema, model, models, InferSchemaType, type Model } from "mongoose";

// ─── workspaces (partial schema) ─────────────────────────────────────
// vdohide-service แตะแค่ capacity (cron update-workspace-usage) —
// schema เต็ม + index ทั้งหมดเป็นของ vdohide monorepo (packages/db)
// ⚠ ห้ามประกาศ index ที่นี่ — กัน index ตีกันข้าม repo
const workspaceSchema = new Schema(
    {
        _id: { type: String, required: true },
        capacity: {
            type: new Schema(
                {
                    used: { type: Schema.Types.Mixed, default: 0 }, // ไบต์ที่ใช้ไปแล้ว
                    heartbeatAt: { type: Date, default: Date.now }, // เวลาอัปเดตล่าสุด
                },
                { _id: false }
            ),
        },
    },
    {
        timestamps: false,
        versionKey: false,
        collection: "workspaces",
        strict: false, // doc จริงมี field อื่นอีกมาก — ไม่ validate ที่นี่
    }
);

export type WorkspaceSchemaType = InferSchemaType<typeof workspaceSchema>;

export const WorkspaceModel: Model<WorkspaceSchemaType> =
    (models?.Workspace as Model<WorkspaceSchemaType>) ||
    model<WorkspaceSchemaType>("Workspace", workspaceSchema);
