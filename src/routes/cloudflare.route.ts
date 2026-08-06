import {
    getM3u8RefererBlockRule,
    getSegmentRefererBlockRule,
} from '@/services/cloudflare';
import { Router, type Request, type Response } from 'express';

const router = Router();

router.get('/m3u8-referer-block-rule', async (_req: Request, res: Response) => {
    try {
        const result = await getM3u8RefererBlockRule();

        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Request-Domain', result.requestHostname);
        res.setHeader('X-Allowed-Domain-Count', String(result.allowedDomains.length));
        res.setHeader('X-Rule-Character-Count', String(result.rule.length));
        res.type('text/plain');

        return res.status(200).send(`${result.rule}\n`);
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error
                ? error.message
                : 'Failed to build Cloudflare referer block rule',
        });
    }
});

router.get('/segment-referer-block-rule', async (_req: Request, res: Response) => {
    try {
        const result = await getSegmentRefererBlockRule();

        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Allowed-Domain-Count', String(result.allowedDomains.length));
        res.setHeader('X-Rule-Character-Count', String(result.rule.length));
        res.type('text/plain');

        return res.status(200).send(`${result.rule}\n`);
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error
                ? error.message
                : 'Failed to build Cloudflare segment referer block rule',
        });
    }
});

export default router;
