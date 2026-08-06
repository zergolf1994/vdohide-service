import { getCachePurgeUrls } from '@/services/media';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

const router = Router();

const cachePurgeUrlsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(50),
});

router.get('/cache-purge-urls', async (req: Request, res: Response) => {
    try {
        const query = cachePurgeUrlsQuerySchema.parse(req.query);
        const result = await getCachePurgeUrls(query);

        if (result.data.nextPage) {
            res.setHeader('X-Next-Page', String(result.data.nextPage));
        }

        res.setHeader('X-Page', String(result.data.page));
        res.setHeader('X-Limit', String(result.data.limit));
        res.setHeader('X-Has-More', String(result.data.hasMore));
        res.setHeader('X-URL-Count', String(result.data.count));
        res.type('text/plain');

        const body = result.data.urls.length > 0
            ? `${result.data.urls.join('\n')}\n`
            : '';

        return res.status(200).send(body);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.issues });
        }

        return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to build cache purge URLs',
        });
    }
});

export default router;
