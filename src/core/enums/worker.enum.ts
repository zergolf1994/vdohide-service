// ชนิดงาน — ใช้ทั้ง worker.type และ video_process.processType (ต้อง match กันถึงจะจ่ายงานถูก)
export enum WorkerType {
    DOWNLOAD = "download",
    PREWARM = "prewarm",
    TRANSCODE = "transcode",
    TRANSFER = "transfer",
    SPRITESHEET = "spritesheet",
}

// สถานะที่ worker (Go) รายงานมาเอง — ตรงกับ heartbeat ฝั่ง server-download
//   idle = ว่าง, busy = กำลังทำ 1 งาน, paused = disk เต็ม (enable=false ด้วย), offline = ขาด heartbeat
// ⚠ ตัวตัดสินว่ารับงานได้ไหมคือ enable + heartbeatAt สด ไม่ใช่ status นี้
export enum WorkerStatus {
    IDLE = "idle",
    BUSY = "busy",
    PAUSED = "paused",
    OFFLINE = "offline",
}
