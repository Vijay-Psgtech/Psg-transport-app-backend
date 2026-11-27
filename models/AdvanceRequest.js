import mongoose from 'mongoose';

const { Schema } = mongoose;

const advanceRequestSchema = new Schema(
  {
    assignment: { type: Schema.Types.ObjectId, ref: 'VehicleAssignment', required: true, index: true },
    driver: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    destination: { type: String, trim: true, maxlength: 160, required: true },
    distanceKm: { type: Number, min: 0.1, max: 999999, required: true },
    requestedAmount: { type: Number, min: 1, max: 100000000, required: true },
    purpose: { type: String, trim: true, maxlength: 500 },
    proof: {
      filename: String,
      mimeType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'] },
    },
    requestReceipt: {
      reference: { type: String, required: true, unique: true },
      issuedAt: { type: Date, required: true },
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'acknowledged'],
      default: 'pending',
      index: true,
    },
    review: {
      reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      reviewedAt: Date,
      decision: { type: String, enum: ['approved', 'rejected'] },
      approvedAmount: { type: Number, min: 1, max: 100000000 },
      note: { type: String, trim: true, maxlength: 500 },
    },
    acknowledgement: {
      acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      acknowledgedAt: Date,
      paidAmount: { type: Number, min: 1, max: 100000000 },
      note: { type: String, trim: true, maxlength: 500 },
      receiptReference: String,
    },
    idempotencyKey: { type: String, trim: true, maxlength: 100 },
  },
  { timestamps: true }
);

advanceRequestSchema.index({ driver: 1, createdAt: -1 });
advanceRequestSchema.index({ status: 1, createdAt: -1 });
advanceRequestSchema.index(
  { driver: 1, assignment: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } }, name: 'uniq_advance_idempotency_scope' }
);

export default mongoose.model('AdvanceRequest', advanceRequestSchema);