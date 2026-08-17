import { Router, type Request, type Response } from 'express';
import { getDownloadOriginal } from '@/services/cron-job/get-download-original.service';
import { getTransferPending } from '@/services/cron-job/get-transfer-pending.service';
import { getSpritesheetPending } from '@/services/cron-job/get-spritesheet-pending.service';
import { getPrewarmPending } from '@/services/cron-job/get-prewarm-pending.service';
import { getTranscodePending } from '@/services/cron-job/get-transcode-pending.service';
import { releaseStaleJobs } from '@/services/cron-job/release-stale-jobs.service';
import { cleanupDeletedIngests } from '@/services/cron-job/cleanup-deleted-ingests.service';
import { cleanupDeletedMedias } from '@/services/cron-job/cleanup-deleted-medias.service';
import { cleanupDeletedFiles } from '@/services/cron-job/cleanup-deleted-files.service';
import { archiveCompletedProcesses } from '@/services/cron-job/archive-completed-processes.service';
import { updateWorkspaceUsage } from '@/services/cron-job/update-workspace-usage.service';
import { cleanupOriginalMedia, cleanupOriginalMediaFull } from '@/services/cron-job/cleanup-original-media.service';
import { getStorageDrainPending } from '@/services/cron-job/get-storage-drain-pending.service';
import { cleanupDeletedWorkspaces } from '@/services/cron-job/cleanup-deleted-workspaces.service';
import { verifyCustomDomains } from '@/services/cron-job/verify-custom-domains.service';
import { repairOrphanedCloneGroups } from '@/services/cron-job/promote-clone-successors.service';

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

router.get('/storage-drain-pending', async (req: Request, res: Response) => {
    try {
        const result = await getStorageDrainPending();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/transcode-pending', async (req: Request, res: Response) => {
    try {
        const result = await getTranscodePending();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/spritesheet-pending', async (req: Request, res: Response) => {
    try {
        const result = await getSpritesheetPending();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/prewarm-pending', async (req: Request, res: Response) => {
    try {
        const result = await getPrewarmPending();
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
// ?full=1[&cursor=<lastId>] = full sweep เก็บตกของเก่า (ยิงซ้ำตาม nextCursor)
router.get('/cleanup-original-media', async (req: Request, res: Response) => {
    try {
        const result = req.query.full === '1'
            ? await cleanupOriginalMediaFull(String(req.query.cursor ?? ''))
            : await cleanupOriginalMedia();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/update-workspace-usage', async (req: Request, res: Response) => {
    try {
        const result = await updateWorkspaceUsage();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/archive-completed-processes', async (req: Request, res: Response) => {
    try {
        const result = await archiveCompletedProcesses();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/cleanup-deleted-ingests', async (req: Request, res: Response) => {
    try {
        const result = await cleanupDeletedIngests();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/cleanup-deleted-medias', async (req: Request, res: Response) => {
    try {
        const result = await cleanupDeletedMedias();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/cleanup-deleted-files', async (req: Request, res: Response) => {
    try {
        const result = await cleanupDeletedFiles();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/cleanup-deleted-workspaces', async (req: Request, res: Response) => {
    try {
        const result = await cleanupDeletedWorkspaces();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/repair-orphaned-clones', async (req: Request, res: Response) => {
    try {
        const result = await repairOrphanedCloneGroups();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});

router.get('/verify-custom-domains', async (req: Request, res: Response) => {
    try {
        const result = await verifyCustomDomains();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});


router.get('/transcode', async (req: Request, res: Response) => {
    try {
        const result = await getTranscodePending();
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});
// router.get('/import', importFiles);

export default router;
