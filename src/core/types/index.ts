export interface MongoFilterCondition {
    $and?: Array<Record<string, unknown>>;
    [key: string]: unknown;
}
export interface ResultActions {
    error?: boolean;
    message: string;
    dataId?: string[];
    page?: string;
    data?: Record<string, unknown>;
}

export type TFunction = (key: string, opts?: Record<string, unknown>) => string

export * from "./parent.type";
export * from "./file.type";
export * from "./media.type";