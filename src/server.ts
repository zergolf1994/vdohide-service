import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import dbConnect from '@/db/conn/mongoose';
import ApiRoutes from '@/routes';
// import '@/schedule'
import { ensureVideoProcessQueueIndex } from '@/db/models/video-process.model';

// Load environment variables
dotenv.config();

const app = express();
// global.dirCached = path.resolve(".cached");

// Database connection
async function initializeDatabase() {
    try {
        await dbConnect();
        await ensureVideoProcessQueueIndex();
        console.log('✅ Database connection established');
    } catch (error) {
        console.error('❌ Database connection failed:', error);
        process.exit(1);
    }
}

// Initialize database connection
initializeDatabase();

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve other static files from public directory without long cache
app.use(express.static(path.resolve('public')));

// Use API routes
app.use(ApiRoutes);

// Error handler
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('❌ Error:', error);

    // MongoDB errors
    if (error.name === 'ValidationError') {
        return res.status(400).json({
            error: 'Validation Error',
            message: error.message,
            details: error.errors
        });
    }

    if (error.name === 'CastError') {
        return res.status(400).json({
            error: 'Invalid ID format',
            message: 'Invalid ObjectId format'
        });
    }

    // File upload errors
    if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
            error: 'File too large',
            message: `File size exceeds 50MB limit`
        });
    }

    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({
            error: 'Invalid field name',
            message: 'Expected field name "file"'
        });
    }

    return res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

const PORT = process.env.HTTP_PORT || 80

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🔄 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🔄 SIGINT received, shutting down gracefully...');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Health check: http://${PORT !== "80" ? `localhost:${PORT}` : "localhost"}/health`);
});
