import { Router } from 'express';
import pkg from '../../package.json';
import { isConnected } from '@/db/conn/mongoose';
import filesRoutes from './file.route';
import cronJobRoutes from './cron-job.route';
import mediaRoutes from './media.route';
import cloudflareRoutes from './cloudflare.route';

const router = Router();

router.use('/file', filesRoutes);
router.use('/cron-job', cronJobRoutes);
router.use('/media', mediaRoutes);
router.use('/cloudflare', cloudflareRoutes);

// Health check endpoint
router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        message: pkg.name,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: isConnected() ? 'Connected' : 'Disconnected'
    });
});
// 404 handler - handle all unmatched routes
router.use((req, res, next) => {
    res.status(404).json({
        error: 'Endpoint not found',
        message: `Cannot ${req.method} ${req.originalUrl}`,
        availableEndpoints: ['/health']
    });
});

export default router;
