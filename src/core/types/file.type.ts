import { FileStatus, FileType, MemberRole } from "../enums";
import { ResultDomainData } from "./domain.type";
import { IBreadcrumbLink } from "./parent.type";
import { ResultUserData } from "./user.type";

export type PageNameClient = "workspace" | "files" | "folder" | "trash" | "delete-permanent" | "search" | "starred" | "recent" | "gallery";

export type ResultFile = {
    _id?: string;
    status?: FileStatus;
    type?: FileType;
    name?: string;
    slug?: string;
    mimeType?: string;
    size?: number;
    highest?: number;
    starred?: boolean;
    creator?: ResultUserData;
    permission?: MemberRole;
    breadcrumb?: IBreadcrumbLink[];
    spaceId?: string;
    parentId?: string;
    parent?: {
        _id: string;
        name: string;
        url: string;
    };
    medias?: Array<{
        type?: string;
        resolution?: string;
        size?: number;
        path?: string;
        mimeType?: string;
    }>
    domains?: ResultDomainData[];
    date?: Date;
};

export type FileSearchFilters = {
    isDir: boolean;
    isTrash: boolean;
    isFile: boolean;
    withSlug: string | undefined;
    withId: string | undefined;
    withStatus: string | undefined;
    // exact file type จาก URL param (option B) — folder|video|image
    withType?: string;
};

export interface MoveFileInput {
    fileIds: string[];
    targetFolderId?: string;
}

export interface CloneFileInput {
    /** รองรับทั้งไฟล์เดียวและหลายไฟล์ */
    fileIds: string[];
    /** folder ปลายทาง (undefined = root) */
    targetFolderId?: string;
    /** space ปลายทาง (บังคับ) */
    targetSpaceId: string;
    /** ชื่อไฟล์ที่ต้องการ (ถ้าไม่ระบุจะใช้ชื่อเดิม + "(สำเนา)") */
    name?: string;
}