// วงจรชีวิตงานในคิว — pending คือ "อยู่ในคิวรอ worker หยิบ"
//   pending → processing → completed | failed | cancelled
export enum VideoProcessStatus {
    PENDING = "pending",
    PROCESSING = "processing",
    COMPLETED = "completed",
    FAILED = "failed",
    CANCELLED = "cancelled",
}

// งานที่ยัง "ค้าง" (ยังไม่จบ) — ใช้ 2 ที่ที่ต้องตรงกันเสมอ:
//   1. partial unique index บน {fileId, processType} (กันเติมคิวซ้ำไฟล์เดิม)
//   2. ตอน enqueuer หา fileId ที่ยังค้างเพื่อตัดออกก่อน insert
// แก้ตรงนี้แล้วต้อง rebuild index ไม่งั้น index คุมคนละชุดกับโค้ด
export const VIDEO_PROCESS_OPEN_STATUSES: VideoProcessStatus[] = [
    VideoProcessStatus.PENDING,
    VideoProcessStatus.PROCESSING,
];
