import { FileModel, WorkspaceModel } from "@/db/models";

// จำนวน workspace ที่นับต่อรอบ — เล็กพอให้ไม่ pin DB แม้ space มีไฟล์เยอะ
const BATCH_SIZE = 5;

// cron: คำนวณพื้นที่ใช้งานจริงของแต่ละ workspace → workspaces.capacity.used
// นับจากผลรวม files.size ของไฟล์ที่ยังไม่ถูกลบถาวร (รวมไฟล์ในถังขยะ —
// ยังกินพื้นที่อยู่จนกว่าจะถูก purge) — คำนวณจากข้อมูลจริงทุกครั้ง ไม่ใช่
// $inc สะสม เลยไม่มีปัญหา drift (นับพลาดครั้งเดียวเพี้ยนตลอด)
//
// ── rolling batch ── ไม่ aggregate ทั้ง collection (10M+ doc) ต่อรอบ แต่หยิบ
// ทีละ BATCH_SIZE workspace ที่ capacity.heartbeatAt "เก่าสุด" มานับก่อน
// (ไม่เคยนับ = ไม่มี heartbeatAt → มาก่อน, tiebreak ด้วย createdAt เก่ากว่า)
// นับแล้ว set heartbeatAt=now → รอบถัดไปไปต่อท้ายคิวเอง หมุนครบทุก space
// ⇒ นับเฉพาะไฟล์ของ 10 space นั้นผ่าน index spaceId ไม่สแกนทั้ง collection
export const updateWorkspaceUsage = async () => {
    try {
        // 1. หยิบ workspace ที่ค้าง/เก่าสุดมา BATCH_SIZE ตัว
        const batch = await WorkspaceModel.find({}, { _id: 1 })
            .sort({ "capacity.heartbeatAt": 1, createdAt: 1 })
            .limit(BATCH_SIZE)
            .lean();

        if (batch.length === 0) {
            return { message: "No workspaces" };
        }

        const ids = batch.map((w: any) => String(w._id));

        // 2. รวมขนาดไฟล์ "เฉพาะ" space ในชุดนี้ (ใช้ index spaceId — ไม่สแกนทั้ง collection)
        const usage = await FileModel.aggregate([
            {
                $match: {
                    spaceId: { $in: ids },
                    "metadata.deletedAt": { $exists: false },
                },
            },
            {
                $group: {
                    _id: "$spaceId",
                    // doc จริงเก็บขนาดที่ metadata.size (top-level size เป็นของ schema เก่า)
                    used: { $sum: { $convert: { input: "$metadata.size", to: "long", onError: 0, onNull: 0 } } },
                },
            },
        ]);

        const usedById = new Map<string, number>(
            (usage as any[]).map((u) => [String(u._id), Number(u.used) || 0])
        );

        // 3. set ทุก ws ในชุด (ไม่มีไฟล์ = used 0) + heartbeat=now → เลื่อนไปท้ายคิว
        const now = new Date();
        const ops = ids.map((id) => ({
            updateOne: {
                filter: { _id: id },
                update: { $set: { "capacity.used": usedById.get(id) ?? 0, "capacity.heartbeatAt": now } },
            },
        }));

        const result = await WorkspaceModel.bulkWrite(ops, { ordered: false });

        return {
            message: "Success",
            data: {
                batch: ids.length,
                updated: result.modifiedCount ?? 0,
                withFiles: usedById.size,
            },
        };
    } catch (error) {
        console.error("updateWorkspaceUsage -> Error:", error);
        return { message: "Internal server error" };
    }
};
