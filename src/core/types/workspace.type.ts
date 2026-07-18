import { MemberRole, MemberStatus, PlanType, WorkspaceStatus } from "../enums";
import { ResultUser } from "./user.type";

export type ResultSpaceData = {
    _id?: string;
    name?: string;
    slug?: string;
    image?: string;
};

export type ResultWorkspace = {
    _id?: string;
    status?: WorkspaceStatus;
    name?: string;
    slug?: string;
    creator?: ResultUser;
    capacity?: {
        used: number;
        heartbeatAt: Date;
    };
    plan?: {
        planType: PlanType;
        price: number;
        adsEnabled: boolean;
        expiresAt: Date;
        downgradeAt: Date;
        pendingStorage: number;
    };
    member?: ResultMember;
    metadata?: {
        customerId: string;
        allowRequestToJoin: boolean;
        autoApproveJoinRequest: boolean;
        deletedAt: Date;
        deletedBy: string;
    };
    limits?: {
        storage: number;
        domains: number;
        members: number;
    };
    date?: Date;
};

export type ResultMember = {
    _id?: string;
    status: MemberStatus;
    role: MemberRole;
    invitedBy?: string | null;
    name?: string;
    email?: string;
    image?: string;
    isMe?: boolean;
    displayName?: string;
    date?: Date;
};

export interface WorkspaceItem {
    _id: string;
    name: string;
    slug: string;
    permission: string;
    plan: string;
    image?: string;
    isDefault: boolean;
}