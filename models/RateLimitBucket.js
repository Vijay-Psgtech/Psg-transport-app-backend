import mongoose from 'mongoose';

const rateLimitBucketSchema = new mongoose.Schema(
  {
    _id: { type: String },
    totalHits: { type: Number, required: true, min: 0 },
    resetTime: { type: Date, required: true },
  },
  { versionKey: false }
);

rateLimitBucketSchema.index({ resetTime: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('RateLimitBucket', rateLimitBucketSchema);