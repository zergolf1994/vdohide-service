import { FileStatus, FileType, VideoProcessStatus, VIDEO_PROCESS_OPEN_STATUSES, WorkerType } from "@/core/enums";
import { paged, pageLimit, sorted } from "@/core/utils";
import { PageType } from "@/core/validators";
import { FileModel } from "@/db/models";
import { PipelineStage } from "mongoose";

export const getFiles = async ({ query }: { query: PageType }) => {
    try {
        const { limit, skip } = pageLimit(query)
        const sort: Record<string, 1 | -1> = sorted(query.sort || "createdAt.desc");

        const pipeline: PipelineStage[] = [
            {
                $match: {
                    status: FileStatus.WAITING,
                    type: FileType.VIDEO
                }
            },
            {
                $facet: {
                    total: [{ $count: "count" }],
                    rows: [
                        { $sort: sort },
                        { $skip: skip },
                        { $limit: limit },
                        {
                            $project: {
                                _id: 1
                            }
                        }
                    ]
                }
            },
            {
                $project: {
                    total: { $arrayElemAt: ["$total.count", 0] },
                    rows: 1,
                },
            },
        ]

        const result = await FileModel.aggregate(pipeline)
        const { rows, total } = result.at(0) || { rows: [], total: 0 }
        return {
            rows,
            pager: paged({ count: total, ...query })
        }
    } catch (error) {
        return { rows: [], pager: undefined }
    }
}

export const getFilesNeededDownload = async ({
    limit,
    sort = { createdAt: 1 },
    filter = {}
}: {
    limit: number,
    sort?: Record<string, 1 | -1>,
    filter?: Record<string, any>
}) => {
    try {
        const pipeline: PipelineStage[] = [
            {
                $match: {
                    status: FileStatus.WAITING,
                    type: FileType.VIDEO,
                    clonedFrom: { $exists: false },
                    ...filter
                }
            },
            {
                $lookup: {
                    from: "video_process",
                    let: { fid: { $toString: "$_id" } },
                    pipeline: [
                        {
                            $match: {
                                $expr: { $eq: ["$fileId", "$$fid"] },
                                processType: WorkerType.DOWNLOAD,
                                // ค้าง (pending/processing) + cancelled — admin ยกเลิกแล้ว
                                // ห้ามเติมคิวซ้ำเอง จนกว่า admin จะกด retry ที่ doc เดิม
                                // (failed ไม่ต้องใส่ — terminal fail พลิก file → error ออกจาก
                                // pool waiting ไปแล้ว)
                                status: { $in: [...VIDEO_PROCESS_OPEN_STATUSES, VideoProcessStatus.CANCELLED] },
                            }
                        },
                        { $limit: 1 },
                    ],
                    as: "queued",
                }
            },
            { $match: { queued: { $size: 0 } } },
            {
                $facet: {
                    total: [{ $count: "count" }],
                    rows: [
                        { $sort: sort },
                        { $limit: limit },
                        {
                            $project: {
                                _id: 0,
                                fileId: "$$ROOT._id",
                                spaceId: 1,
                                slug: 1
                            }
                        }
                    ]
                }
            },
            {
                $project: {
                    total: { $arrayElemAt: ["$total.count", 0] },
                    rows: 1,
                },
            },
        ]

        const result = await FileModel.aggregate(pipeline)
        const { rows, total } = result.at(0) || { rows: [], total: 0 }
        return {
            count: total,
            data: rows,
        }
    } catch (error) {
        console.error("getFilesNeededDownload -> Error:", error);
        return { count: 0, data: [] }
    }
}