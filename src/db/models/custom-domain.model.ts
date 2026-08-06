import { DomainStatus } from '@/core/enums';
import { InferSchemaType, model, models, Schema, type Model } from 'mongoose';

// Partial schema for domain verification and workspace cleanup.
// Indexes are owned by the main vdohide repository and must not be declared here.
const customDomainSchema = new Schema(
    {
        _id: { type: String, required: true },
        enable: { type: Boolean, default: false },
        name: { type: String, required: true },
        status: { type: String, enum: Object.values(DomainStatus) },
        spaceId: { type: String },
        slug: { type: String, required: true },
        dns: {
            type: new Schema(
                {
                    retryCount: { type: Number, default: 0 },
                    lastCheckedAt: { type: Date },
                    lastVerified: { type: Date },
                    nextVerifyAt: { type: Date },
                    checkLockedUntil: { type: Date },
                    reason: { type: String },
                },
                { _id: false }
            ),
        },
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
