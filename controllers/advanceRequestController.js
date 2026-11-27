import { access } from 'node:fs/promises';
import mongoose from 'mongoose';
import AdvanceRequest from '../models/AdvanceRequest.js';
import VehicleAssignment from '../models/VehicleAssignment.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { advanceProofPath, removeAdvanceProofFile } from '../utils/advanceProofFiles.js';
import { FLEET_MANAGERS } from '../constants/roles.js';
import { createNotification, notifyFleetManagers } from '../utils/notifications.js';

const populated = [
  { path: 'assignment', select: 'type purpose pickupLocation destination startAt endAt status' },
  { path: 'driver', select: 'name phone email' },
  { path: 'vehicle', select: 'regNo make model vehicleType' },
  { path: 'review.reviewedBy', select: 'name' },
  { path: 'acknowledgement.acknowledgedBy', select: 'name' },
];

const numberInRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

function requireManager(req) {
  if (!FLEET_MANAGERS.includes(req.user.role)) {
    throw new ApiError(403, 'Only fleet managers can review and acknowledge advances', 'FORBIDDEN');
  }
}

async function findAccessible(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Advance request ID is invalid');
  const advance = await AdvanceRequest.findById(req.params.id);
  if (!advance) throw new ApiError(404, 'Advance request not found');
  if (!FLEET_MANAGERS.includes(req.user.role) && !advance.driver.equals(req.user._id)) {
    throw new ApiError(403, 'You do not have permission to view this advance request', 'FORBIDDEN');
  }
  return advance;
}

export const listAdvanceRequests = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const filter = FLEET_MANAGERS.includes(req.user.role) ? {} : { driver: req.user._id };
  if (['pending', 'approved', 'rejected', 'acknowledged'].includes(req.query.status)) {
    filter.status = req.query.status;
  }
  const [data, total] = await Promise.all([
    AdvanceRequest.find(filter)
      .populate(populated)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AdvanceRequest.countDocuments(filter),
  ]);
  res.status(200).json({ data, pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) } });
});

export const createAdvanceRequest = asyncHandler(async (req, res) => {
  let uploadedProof = req.file?.filename;
  const idempotencyKey =
    (typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'].trim().slice(0, 100)) ||
    (typeof req.body.idempotencyKey === 'string' ? req.body.idempotencyKey.trim().slice(0, 100) : undefined);
  try {
    const { assignmentId, destination, distanceKm, requestedAmount, purpose } = req.body;
    if (!mongoose.isValidObjectId(assignmentId)) throw new ApiError(400, 'Select a valid assigned trip');
    if (idempotencyKey) {
      const existing = await AdvanceRequest.findOne({
        driver: req.user._id,
        assignment: assignmentId,
        idempotencyKey,
      });
      if (existing) {
        if (uploadedProof) await removeAdvanceProofFile(uploadedProof);
        uploadedProof = undefined;
        return res.status(200).json({ data: existing, duplicate: true });
      }
    }
    if (typeof destination !== 'string' || !destination.trim() || destination.trim().length > 160) {
      throw new ApiError(400, 'Destination is required and must be 160 characters or fewer');
    }
    const distance = Number(distanceKm);
    if (!numberInRange(distance, 0.1, 999999)) throw new ApiError(400, 'Distance must be between 0.1 and 999,999 km');
    const amount = Number(requestedAmount);
    if (!Number.isInteger(amount) || !numberInRange(amount, 1, 100000000)) {
      throw new ApiError(400, 'Advance amount must be a whole number between ₹1 and ₹10,00,00,000');
    }
    if (purpose !== undefined && (typeof purpose !== 'string' || purpose.length > 500)) {
      throw new ApiError(400, 'Purpose must be 500 characters or fewer');
    }

    const assignment = await VehicleAssignment.findOne({
      _id: assignmentId,
      driver: req.user._id,
      status: 'assigned',
    }).select('vehicle');
    if (!assignment?.vehicle) throw new ApiError(404, 'Assigned trip not found or it is no longer active');

    const existing = await AdvanceRequest.findOne({
      assignment: assignment._id,
      status: { $in: ['pending', 'approved', 'acknowledged'] },
    }).select('_id');
    if (existing) throw new ApiError(409, 'An advance request for this trip is already awaiting completion');

    const requestId = new mongoose.Types.ObjectId();
    const issuedAt = new Date();
    const request = await AdvanceRequest.create({
      _id: requestId,
      assignment: assignment._id,
      driver: req.user._id,
      vehicle: assignment.vehicle,
      ...(idempotencyKey && { idempotencyKey }),
      destination: destination.trim(),
      distanceKm: distance,
      requestedAmount: amount,
      purpose: purpose?.trim() || undefined,
      ...(req.file && { proof: { filename: req.file.filename, mimeType: req.file.mimetype } }),
      requestReceipt: {
        reference: `ADV-${requestId.toString().slice(-10).toUpperCase()}`,
        issuedAt,
      },
    });
    uploadedProof = undefined;
    await request.populate(populated);
    await notifyFleetManagers({
      title: 'New advance request',
      body: `${req.user.name} requested ₹${amount.toLocaleString('en-IN')} for ${destination.trim()}.`,
      category: 'advance',
      data: { route: '/advances', advanceId: String(requestId) },
    });
    res.status(201).json({ data: request });
  } catch (error) {
    if (error?.code === 11000 && idempotencyKey) {
      const existing = await AdvanceRequest.findOne({
        driver: req.user._id,
        assignment: req.body.assignmentId,
        idempotencyKey,
      }).populate(populated);
      if (existing) {
        if (uploadedProof) {
          await removeAdvanceProofFile(uploadedProof);
          uploadedProof = undefined;
        }
        return res.status(200).json({ data: existing, duplicate: true });
      }
    }
    if (uploadedProof) {
      try {
        await removeAdvanceProofFile(uploadedProof);
      } catch (cleanupError) {
        console.error('Unable to remove unclaimed advance proof upload:', cleanupError);
      }
    }
    throw error;
  }
});

export const reviewAdvanceRequest = asyncHandler(async (req, res) => {
  requireManager(req);
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Advance request ID is invalid');
  const { decision, approvedAmount, note } = req.body;
  if (!['approved', 'rejected'].includes(decision)) {
    throw new ApiError(400, 'Decision must be approved or rejected');
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
    throw new ApiError(400, 'Review note must be 500 characters or fewer');
  }
  const existing = await AdvanceRequest.findById(req.params.id);
  if (!existing) throw new ApiError(404, 'Advance request not found');
  if (existing.status !== 'pending') throw new ApiError(409, 'Only pending advances can be reviewed');

  const amount = approvedAmount === undefined || approvedAmount === '' ? existing.requestedAmount : Number(approvedAmount);
  if (decision === 'approved' && (!Number.isInteger(amount) || !numberInRange(amount, 1, 100000000))) {
    throw new ApiError(400, 'Approved amount must be a whole number between ₹1 and ₹10,00,00,000');
  }
  const request = await AdvanceRequest.findOneAndUpdate(
    { _id: existing._id, status: 'pending' },
    {
      $set: {
        status: decision,
        review: {
          reviewedBy: req.user._id,
          reviewedAt: new Date(),
          decision,
          ...(decision === 'approved' && { approvedAmount: amount }),
          ...(note?.trim() && { note: note.trim() }),
        },
      },
    },
    { new: true, runValidators: true }
  );
  if (!request) throw new ApiError(409, 'This advance was already reviewed');
  await request.populate(populated);
  await createNotification({
    recipient: request.driver,
    title: decision === 'approved' ? 'Advance approved' : 'Advance rejected',
    body: decision === 'approved'
      ? `Your advance was approved for ₹${amount.toLocaleString('en-IN')}.`
      : `Your advance request was rejected${note?.trim() ? `: ${note.trim()}` : '.'}`,
    category: 'advance',
    data: { route: '/advances', advanceId: String(request._id) },
  });
  res.json({ data: request });
});

export const acknowledgeAdvancePayment = asyncHandler(async (req, res) => {
  requireManager(req);
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Advance request ID is invalid');
  const { paidAmount, note } = req.body;
  const existing = await AdvanceRequest.findById(req.params.id);
  if (!existing) throw new ApiError(404, 'Advance request not found');
  if (existing.status !== 'approved') throw new ApiError(409, 'Only approved advances can be acknowledged');
  const amount = paidAmount === undefined || paidAmount === '' ? existing.review.approvedAmount : Number(paidAmount);
  if (!Number.isInteger(amount) || !numberInRange(amount, 1, 100000000)) {
    throw new ApiError(400, 'Paid amount must be a whole number between ₹1 and ₹10,00,00,000');
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
    throw new ApiError(400, 'Acknowledgement note must be 500 characters or fewer');
  }

  const request = await AdvanceRequest.findOneAndUpdate(
    { _id: existing._id, status: 'approved' },
    {
      $set: {
        status: 'acknowledged',
        acknowledgement: {
          acknowledgedBy: req.user._id,
          acknowledgedAt: new Date(),
          paidAmount: amount,
          ...(note?.trim() && { note: note.trim() }),
          receiptReference: `PAY-${existing._id.toString().slice(-10).toUpperCase()}`,
        },
      },
    },
    { new: true, runValidators: true }
  );
  if (!request) throw new ApiError(409, 'This advance was already acknowledged or changed');
  await request.populate(populated);
  await createNotification({
    recipient: request.driver,
    title: 'Advance payment acknowledged',
    body: `₹${amount.toLocaleString('en-IN')} was recorded as paid.`,
    category: 'advance',
    data: { route: '/advances', advanceId: String(request._id) },
  });
  res.json({ data: request });
});

export const getAdvanceProof = asyncHandler(async (req, res) => {
  const request = await findAccessible(req);
  if (!request.proof?.filename || !request.proof.mimeType) throw new ApiError(404, 'No proof image was uploaded');
  const filePath = advanceProofPath(request.proof.filename);
  try {
    await access(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ApiError(404, 'Proof image file not found');
    throw error;
  }
  res.type(request.proof.mimeType).set('X-Content-Type-Options', 'nosniff').sendFile(filePath);
});