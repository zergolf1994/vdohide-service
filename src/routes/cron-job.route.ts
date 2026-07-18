import { Router, type Request, type Response } from 'express';
import { getDownloadOriginal } from '@/services/cron-job/get-download-original.service';
import { getTransferPending } from '@/services/cron-job/get-transfer-pending.service';
import { releaseStaleJobs } from '@/services/cron-job/release-stale-jobs.service';

const router = Router();

router.get('/download-original', async (req: Request, res: Response) => {
    try {
        const result = await getDownloadOriginal();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/transfer-pending', async (req: Request, res: Response) => {
    try {
        const result = await getTransferPending();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/release-stale-jobs', async (req: Request, res: Response) => {
    try {
        const result = await releaseStaleJobs();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});
// router.get('/import', importFiles);

export default router;