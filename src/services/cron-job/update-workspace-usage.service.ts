import { FileModel, WorkspaceModel } from "@/db/models";

// cron: คำนวณพื้นที่ใช้งานจริงของแต่ละ workspace → workspaces.capacity.used
// นับจากผลรวม files.size ของไฟล์ที่ยังไม่ถูกลบถาวร (รวมไฟล์ในถังขยะ —
// ยังกินพื้นที่อยู่จนกว่าจะถูก purge) — คำนวณจากข้อมูลจริงทุกครั้ง ไม่ใช่
// $inc สะสม เลยไม่มีปัญหา drift (นับพลาดครั้งเดียวเพี้ยนตลอด)
export const updateWorkspaceUsage = async () => {
    try {
        const usage = await FileModel.aggregate([
            {
                $match: {
                    spaceId: { $type: "string", $ne: "" },
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

        const now = new Date();
        const ops = (usage as any[]).map((u) => ({
            updateOne: {
                filter: { _id: u._id },
                update: { $set: { "capacity.used": u.used, "capacity.heartbeatAt": now } },
            },
        }));

        let updated = 0;
        if (ops.length > 0) {
            const result = await WorkspaceModel.bulkWrite(ops, { ordered: false });
            updated = result.modifiedCount ?? 0;
        }

        // workspace ที่ไม่เหลือไฟล์เลย (เพิ่งลบหมด) → used = 0
        const usedIds = (usage as any[]).map((u) => u._id);
        const zeroed = await WorkspaceModel.updateMany(
            {
                ...(usedIds.length > 0 ? { _id: { $nin: usedIds } } : {}),
                "capacity.used": { $nin: [0, null] },
            },
            { $set: { "capacity.used": 0, "capacity.heartbeatAt": now } }
        );

        return {
            message: "Success",
            data: {
                workspaces: usage.length,
                updated,
                zeroed: zeroed.modifiedCount ?? 0,
            },
        };
    } catch (error) {
        console.error("updateWorkspaceUsage -> Error:", error);
        return { message: "Internal server error" };
    }
};
