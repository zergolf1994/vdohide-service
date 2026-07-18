

export type ResultMedia = {
    _id?: string;
    type?: string;
    fileName?: string;
    resolution?: string;
    size?: number;
    path?: string;
    mimeType?: string;
    storage?: {
        name: string;
    };
    file?: {
        name: string;
        slug: string;
    };
    metadata?: {
        [key: string]: any;
    }
    prewarm: {
        [key: string]: PrewarmItem;
    }
    date?: Date;
};

export type PrewarmItem = {
    data: {
        total: number;
        hit: number;
        miss: number;
        expired: number;
        failed: number;
    },
    prewarmAt?: Date;
}