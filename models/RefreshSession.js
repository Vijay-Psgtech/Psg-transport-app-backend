import mongoose from 'mongoose';

const refreshSessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: String, required: true, unique: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

refreshSessionSchema.index({ user: 1 });

export default mongoose.model('RefreshSession', refreshSessionSchema);