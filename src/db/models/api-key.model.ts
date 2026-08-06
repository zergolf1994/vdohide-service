import { InferSchemaType, model, models, Schema, type Model } from "mongoose";

// Partial schema used by workspace cleanup. Indexes are owned by packages/db.
const apiKeySchema = new Schema(
    {
        _id: { type: String, required: true },
        spaceId: { type: String, required: true },
    },
    {
        timestamps: false,
        versionKey: false,
        collection: "api_keys",
        strict: false,
    }
);

export type ApiKeySchemaType = InferSchemaType<typeof apiKeySchema>;

export const ApiKeyModel: Model<ApiKeySchemaType> =
    (models?.ApiKey as Model<ApiKeySchemaType>) ||
    model<ApiKeySchemaType>("ApiKey", apiKeySchema);
