export interface IParents {
    creatorId?: string;
    spaceId?: string;
    fileSlug?: string;
    parentId?: string;
    inTrash?: boolean;
}

export interface IFolder {
    _id: string;
    name: string;
    slug: string;
    parentId?: string;
    type?: string;
    creatorId?: string;
    trash?: boolean;
    expanded?: boolean
}

export interface ITreeFolder extends IFolder {
    children: ITreeFolder[];
}

export interface ITreeInput {
    folders: IFolder[];
    parentId?: string;
}

export interface IBreadcrumbItem extends IFolder {
    last?: boolean
}

// New types for enhanced features
export interface IBreadcrumbOptions {
    fileId: string;
    includeFile?: boolean;
}

export interface IBreadcrumbResult {
    id: string;
    name: string;
    type: string;
    slug?: string;
}

export interface IBreadcrumbOptions {
    fileId: string;
    includeFile?: boolean;
}

export interface IEnhancedBreadcrumbOptions extends IBreadcrumbOptions {
    includeLinks?: boolean; // เพิ่ม links สำหรับ navigation
    separateCurrentItem?: boolean; // แยก current item ออกจาก breadcrumb path
}

export interface IDeleteFolderOptions {
    folderId: string;
    userId: string;
    permanently?: boolean; // true = hard delete, false = soft delete to trash
}

export interface IDeleteResult {
    deletedCount: number;
    deletedFiles: string[];
    success: boolean;
    error?: string;
}

export interface IMoveFileOptions {
    fileId: string;
    targetParentId?: string;
    userId: string;
}

export interface IFolderListOptions {
    creatorId?: string;
    spaceId?: string;
    excludeFileId?: string; // ไม่แสดงโฟลเดอร์ที่จะย้าย และ children ของมัน
    inTrash?: boolean;
}

export interface IFolderForMove {
    _id: string;
    name: string;
    type: string;
    parentId?: string;
    level: number; // ระดับความลึก สำหรับการแสดงผล
    path: string; // เช่น "Space > Folder 1 > Folder 2"
    disabled?: boolean; // ไม่สามารถเลือกได้ (เช่น เป็น child ของไฟล์ที่จะย้าย)
    children?: IFolderForMove[]; // เพิ่ม children สำหรับ hierarchical structure
}

export interface IBreadcrumbLink {
    _id?: string; // เพิ่ม _id field
    name: string;
    link?: string;
    last?: boolean;
    slug?: string;
    type?: string;
    creatorId?: string;
}

export interface IBreadcrumb extends IBreadcrumbLink {
    subitem?: IBreadcrumbLink[]
}