import { DomainStatus } from '@/core/enums';
import { InferSchemaType, model, models, Schema, type Model } from 'mongoose';

// Partial schema for read-only access from vdohide-service.
// Indexes are owned by the main vdohide repository and must not be declared here.
const customDomainSchema = new Schema(
    {
        _id: { type: String, required: true },
        enable: { type: Boolean, default: false },
        name: { type: String, required: true },
        status: { type: String, enum: Object.values(DomainStatus) },
    },
    {
        timestamps: false,
        versionKey: false,
        collection: 'custom_domains',
        strict: false,
    }
);

export type CustomDomainSchemaType = InferSchemaType<typeof customDomainSchema>;

export const CustomDomainModel: Model<CustomDomainSchemaType> =
    (models?.CustomDomain as Model<CustomDomainSchemaType>) ||
    model<CustomDomainSchemaType>('CustomDomain', customDomainSchema);
