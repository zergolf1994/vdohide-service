export const UserRole = {
    USER: "user",
    ADMIN: "admin",
    SUPER_ADMIN: "super_admin",
    DEVELOPER: "developer",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];