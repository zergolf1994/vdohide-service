export const PlanType = {
    HOBBY: "hobby",
    PRO: "pro",
    ENTERPRISE: "enterprise",
} as const;
export type PlanType = (typeof PlanType)[keyof typeof PlanType];

export const WorkspaceStatus = {
    PENDING: "pending",
    ACTIVE: "active",
    INACTIVE: "inactive",
    DELETED: "deleted",
} as const;
export type WorkspaceStatus = (typeof WorkspaceStatus)[keyof typeof WorkspaceStatus];

export const MemberRole = {
    OWNER: "owner",
    ADMIN: "admin",
    EDITOR: "editor",
    VIEWER: "viewer",
} as const;
export type MemberRole = (typeof MemberRole)[keyof typeof MemberRole];

export const MemberStatus = {
    PENDING: "pending",
    ACTIVE: "active",
    KICKED: "kicked",
    REJECTED: "rejected",
    LEAVE: "leave",
} as const;
export type MemberStatus = (typeof MemberStatus)[keyof typeof MemberStatus];