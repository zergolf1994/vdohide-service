export enum StorageType {
    LOCAL = "local",
    S3 = "s3",
}

export enum StorageStatus {
    ONLINE = "online",
    OFFLINE = "offline",
    ERROR = "error",
    MAINTENANCE = "maintenance",
}

export enum StorageDrainState {
    IDLE = "idle",
    REQUESTED = "requested",
    DRAINING = "draining",
    CANCELLING = "cancelling",
    BLOCKED = "blocked",
    COMPLETED = "completed",
}

export enum StorageAccept {
    // บทบาท (Role)
    UPLOAD = "upload",     // รับอัพโหลดไฟล์
    STORAGE = "storage",   // เก็บไฟล์ที่ประมวลผลแล้ว
    TEMP = "temp",         // เก็บไฟล์ชั่วคราว (ระหว่างประมวลผล)
    // ประเภทไฟล์ (Type)
    VIDEO = "video",
    IMAGE = "image",
    OTHER = "other",
}
