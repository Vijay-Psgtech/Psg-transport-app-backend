import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
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

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
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
  .then(() => app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
