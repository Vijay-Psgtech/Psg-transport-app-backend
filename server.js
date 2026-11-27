import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import connectDB from './config/db.js';
import { validateEnvironment } from './config/env.js';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import vehicleAssignmentRoutes from './routes/vehicleAssignmentRoutes.js';
import serviceHistoryRoutes from './routes/serviceHistoryRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import advanceRequestRoutes from './routes/advanceRequestRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import migrateIdempotencyIndexes from './config/migrateIdempotencyIndexes.js';
import { startNotificationWorker, stopNotificationWorker } from './utils/notifications.js';
import { log } from './utils/logger.js';

validateEnvironment();

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: (process.env.CLIENT_URL || 'http://localhost:5173,http://localhost:8081,http://127.0.0.1:8081')
      .split(',')
      .map((s) => s.trim()),
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));
else {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      log('info', 'http_request_completed', {
        method: req.method,
        route: `${req.baseUrl}${req.route?.path || req.path}`,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });
}

app.get('/api/health', (_req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unavailable',
    database: ready ? 'connected' : 'disconnected',
    uptimeSeconds: Math.floor(process.uptime()),
  });
});
app.get('/api/health/ready', (_req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
});
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/vehicle-assignments', vehicleAssignmentRoutes);
app.use('/api/service-history', serviceHistoryRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/advance-requests', advanceRequestRoutes);
app.use('/api/notifications', notificationRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
connectDB()
  .then(async () => {
    await migrateIdempotencyIndexes();
    startNotificationWorker();
    const server = app.listen(PORT, () => log('info', 'api_listening', { port: PORT }));
    server.on('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        log('error', 'api_port_in_use', { port: PORT, guidance: 'Stop the other API process or set PORT to a free port.' });
      } else {
        log('error', 'api_listen_failed', { message: err.message });
      }

      stopNotificationWorker();
      try {
        await mongoose.disconnect();
      } catch (disconnectError) {
        log('error', 'database_disconnect_failed', { message: disconnectError.message });
      }
      process.exit(1);
    });
    const shutdown = async (signal) => {
      log('info', 'api_shutdown_started', { signal });
      stopNotificationWorker();
      server.close(async () => {
        await mongoose.disconnect();
        process.exit(0);
      });
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  })
  .catch((err) => {
    log('error', 'startup_failed', { message: err.message });
    process.exit(1);
  });