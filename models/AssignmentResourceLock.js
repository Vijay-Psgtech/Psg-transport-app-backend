import mongoose from 'mongoose';

const assignmentResourceLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

assignmentResourceLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('AssignmentResourceLock', assignmentResourceLockSchema);