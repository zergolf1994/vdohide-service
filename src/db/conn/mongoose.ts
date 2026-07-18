import mongoose, { PipelineStage, type Connection, type ConnectOptions } from "mongoose";

type Cached = { conn: Connection | null; promise: Promise<Connection> | null };

// เก็บ cache ไว้บน globalThis (รองรับ HMR)
type G = typeof globalThis & { __mongoose?: Cached };
const g = globalThis as G;
g.__mongoose ??= { conn: null, promise: null };
const cached = g.__mongoose;

const baseOptions: ConnectOptions = {
    bufferCommands: false,
    maxPoolSize: 20,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    connectTimeoutMS: 10_000,
    family: 4,
    maxIdleTimeMS: 120_000,        // เพิ่มจาก 30s → 2 นาที ป้องกัน idle timeout
    heartbeatFrequencyMS: 10_000,  // ping MongoDB ทุก 10 วินาที keep-alive
};

export async function dbConnect(opts: Partial<ConnectOptions> = {}): Promise<Connection> {
    if (cached.conn && cached.conn.readyState === 1) return cached.conn;

    if (!cached.promise) {
        const uri = process.env.DATABASE_URL;
        if (!uri) throw new Error("DATABASE_URL is not set");

        // ชื่อ database มาจาก connection string ใน DATABASE_URL เท่านั้น
        const options: ConnectOptions = { ...baseOptions, ...opts };

        if (process.env.NODE_ENV === "development") {
            console.log("🔄 Connecting to MongoDB...");
        }

        cached.promise = mongoose.connect(uri, options).then(m => {
            if (process.env.NODE_ENV === "development") {
                console.log("✅ Connected to MongoDB via Mongoose");
            }
            return m.connection;
        });
    }

    try {
        cached.conn = await cached.promise;
    } catch (err) {
        cached.promise = null;
        throw err;
    }
    return cached.conn;
}

export async function dbDisconnect(): Promise<void> {
    if (cached.conn) {
        await mongoose.disconnect();
        cached.conn = null;
        cached.promise = null;
    }
}

export function isConnected(): boolean {
    return mongoose.connection.readyState === 1;
}

export { mongoose, type PipelineStage };
export default dbConnect;
