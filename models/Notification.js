import mongoose from 'mongoose';

const pushDeliverySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['queued', 'processing', 'delivered', 'failed', 'skipped'],
      default: 'skipped',
    },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lockedAt: Date,
    deliveredAt: Date,
    lastError: { type: String, trim: true, maxlength: 1000 },
  },
  { _id: false, versionKey: false }
);

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    category: {
      type: String,
      enum: ['vehicle_request', 'assignment', 'trip_sheet', 'advance', 'system', 'compliance'],
      required: true,
      index: true,
    },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
    pushDelivery: {
      type: pushDeliverySchema,
      select: false,
      default: () => ({ status: 'skipped' }),
    },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ 'pushDelivery.status': 1, 'pushDelivery.nextAttemptAt': 1, createdAt: 1 });

export default mongoose.model('Notification', notificationSchema);