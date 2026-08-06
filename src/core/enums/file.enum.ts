export enum FileType {
    FOLDER = "folder",
    VIDEO = "video",
    IMAGE = "image",
    OTHER = "other",
}

export enum FileStatus {
    WAITING = "waiting",
    PROCESSING = "processing",
    READY = "ready",
    READY_ORIGINAL = "ready_original",
    ERROR = "error",
    QUEUE = "queue",
}

export enum MediaType {
    VIDEO = "video",
    AUDIO = "audio",
    SUBTITLE = "subtitle",
    THUMBNAIL = "thumbnail",
    IMAGE = "image",
    DOCUMENT = "document",
    OTHER = "other",
}

export enum IngestSourceType {
    UPLOAD = "upload",
    REMOTE = "remote",
    GDRIVE = "gdrive",
    S3_IMPORT = "s3_import",
    // สร้างโดย worker (download/HLS) = ไฟล์ผลลัพธ์บน S3 temp รอ transfer ลง storage
    PROCESSED = "processed",
    MIGRATION = "migration",
}

export enum IngestMigrationState {
    STAGED = "staged",
    INSTALLED = "installed",
    CLEANED = "cleaned",
}

export enum IngestStatus {
    UPLOADING = "uploading",
    COMPLETED = "completed",
    FAILED = "failed",
}
// resolution ของ video media — ต้อง match กับ Go workers (media.enum.go)
export enum Resolution {
    ORIGINAL = "original",
    R1080 = "1080",
    R720 = "720",
    R480 = "480",
    R360 = "360",
}
