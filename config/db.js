import mongoose from 'mongoose';
import { log } from '../utils/logger.js';

export default async function connectDB() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  mongoose.set('strictQuery', true);
  const conn = await mongoose.connect(process.env.MONGO_URI);
  log('info', 'mongodb_connected', { host: conn.connection.host, database: conn.connection.name });
}