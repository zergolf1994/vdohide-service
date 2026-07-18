import { Schema, model, models, InferSchemaType, type Model } from "mongoose";
import { v4 as uuidv4 } from "uuid";

const starredSchema = new Schema(
    {
        _id: { type: String, required: true, default: uuidv4 },
        userId: { type: String, ref: "User", index: true, required: true },
        fileId: { type: String, ref: "File", index: true, required: true },
    },
    { timestamps: true, versionKey: false, collection: "starred" }
);


starredSchema.index({ userId: 1, fileId: 1 }, { unique: true });


export type StarredSchemaType = InferSchemaType<typeof starredSchema>;

export const StarredModel: Model<StarredSchemaType> =
    (models?.Starred as Model<StarredSchemaType>) ||
    model<StarredSchemaType>("Starred", starredSchema);
