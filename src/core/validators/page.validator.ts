import { z } from "zod";

export const pageSchema = z.object({
    page: z.union([z.string(), z.number()]).optional().transform(val => val ? Math.max(Number(val), 1) : 1).default(1),
    per_page: z.union([z.string(), z.number()]).optional().transform(val => val ? Math.min(Math.max(Number(val), 10), 100) : 10).default(20),
    q: z.string().optional(),
    sort: z.string().optional(),
})

export type PageType = z.infer<typeof pageSchema>