import { InferSchemaType, model, models, Schema, type Model } from "mongoose";

// Partial schema used by workspace cleanup. Indexes are owned by packages/db.
const workspaceMemberSchema = new Schema(
    {
        _id: { type: String, required: true },
        spaceId: { type: String, required: true },
    },
    {
        timestamps: false,
        versionKey: false,
        collection: "workspace_members",
        strict: false,
    }
);

export type WorkspaceMemberSchemaType = InferSchemaType<typeof workspaceMemberSchema>;

export const WorkspaceMemberModel: Model<WorkspaceMemberSchemaType> =
    (models?.WorkspaceMember as Model<WorkspaceMemberSchemaType>) ||
    model<WorkspaceMemberSchemaType>("WorkspaceMember", workspaceMemberSchema);
