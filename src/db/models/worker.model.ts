import { Schema, model, models, InferSchemaType, type Model } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { WorkerStatus, WorkerType } from "@/core/enums";

// ข้อมูลเครื่องที่ worker (Go) รายงานมาทุก heartbeat — ไว้โชว์ใน admin เท่านั้น
const workerSystemInfoSchema = new Schema(
    {
        diskTotal: { type: Number },
        diskUsed: { type: Number },
        diskFree: { type: Number },
        memTotal: { type: Number },
        memUsed: { type: Number },
        cpuPercent: { type: Number },
    },
    { _id: false }
);

// ─── workers ── match กับ heartbeat ของ server-download (Go) ─────────
// Go upsert by workerId ทุก 1 นาที: hostname, ip, pid, type, status, enable,
// activeJobs, maxJobs(=1), system, heartbeatAt
const workerSchema = new Schema(
    {
        _id: { type: String, required: true, default: uuidv4 },
        workerId: { type: String, unique: true }, // "type_hostname@pid" ที่ Go ตั้ง
        hostname: { type: String },
        ip: { type: String },
        // เฉพาะ worker ชนิด transfer — local storage ที่เครื่องนั้นดูแล (Go เขียนจาก STORAGE_ID)
        storageId: { type: String, ref: "Storage" },
        pid: { type: Number }, // Go เขียนเป็น int
        enable: { type: Boolean, default: false },
        type: { type: String, enum: Object.values(WorkerType), default: WorkerType.DOWNLOAD },
        status: { type: String, enum: Object.values(WorkerStatus), default: WorkerStatus.OFFLINE },

        // ⚠ counter ที่ Go เขียนไว้ — เชื่อเป็นตัวเลขคร่าวๆ ได้ แต่ตอนนับ slot จริง
        //   enqueuer ควรนับจาก video_process (count processing) ไม่ใช่ค่านี้
        activeJobs: { type: Number, default: 0 },
        maxJobs: { type: Number, default: 1 }, // Go ตั้ง 1 (1 worker = 1 งาน)

        system: { type: workerSystemInfoSchema },
        // ตัวชี้ขาดว่า worker ยังมีชีวิต — heartbeat เก่า = ตาย ไม่นับ slot
        heartbeatAt: { type: Date },
    },
    { timestamps: true, versionKey: false, collection: "workers" }
);

// หา worker ที่รับงานชนิดนี้ได้และยังสด: {type, enable: true, heartbeatAt: {$gte: now - ttl}}
workerSchema.index({ type: 1, enable: 1, heartbeatAt: -1 });

export type WorkerSchemaType = InferSchemaType<typeof workerSchema>;

export const WorkerModel: Model<WorkerSchemaType> =
    (models?.Worker as Model<WorkerSchemaType>) ||
    model<WorkerSchemaType>("Worker", workerSchema);
