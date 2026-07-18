import { UserRole } from "../enums";

export type ResultUserData = {
    _id?: string;
    email?: string;
    name?: string;
    image?: string;
    isMe?: boolean;
    role?: string
};

interface IPrefs {
    [key: string]: unknown;
}

export type ResultUser = {
    _id: string;
    name: string;
    email: string;
    role: UserRole;
    image?: string;
    prefs?: IPrefs;
    date: Date;
};

export interface StorageUsageCellProps {
    storage?: {
        used?: number;
        total?: number;
        percent?: number;
    };
}

export interface BalanceCellProps {
    balance?: number;
    currency?: string;
}