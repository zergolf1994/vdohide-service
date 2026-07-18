import { getFiles } from '@/services/file';
import { pageSchema } from '@/core/validators';
import { Router, type Request, type Response } from 'express';

const router = Router();

router.get('/all', async (req: Request, res: Response) => {
    try {
        const query = pageSchema.parse(req.query);
        const result = await getFiles({ query });
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error });
    }
});
// router.get('/import', importFiles);

export default router;