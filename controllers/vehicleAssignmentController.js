import mongoose from 'mongoose';
import VehicleAssignment from '../models/VehicleAssignment.js';
import TripSheet from '../models/TripSheet.js';
import Vehicle from '../models/Vehicle.js';
import User from '../models/User.js';
import { ROLES } from '../constants/roles.js';
import { VEHICLE_TYPES } from '../constants/vehicle.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { createNotification, notifyFleetManagers } from '../utils/notifications.js';
import withAssignmentResourceLocks from '../utils/withAssignmentResourceLocks.js';

const isManager = (user) => [ROLES.ADMIN, ROLES.TRANSPORT_OFFICER].includes(user.role);
const assignmentPopulate = [
  { path: 'vehicle', select: 'regNo make model vehicleType seatingCapacity' },
  { path: 'driver', select: 'name phone' },
  { path: 'requestedBy', select: 'name phone email' },
  { path: 'assignedBy', select: 'name' },
];

function licenseValidThrough(expiry, endAt = new Date()) {
  if (!expiry) return false;
  const endOfExpiryDate = new Date(expiry);
  endOfExpiryDate.setUTCHours(23, 59, 59, 999);
  return endOfExpiryDate >= endAt;
}

function getWindow(startValue, endValue) {
  const startAt = new Date(startValue);
  const endAt = new Date(endValue);
  if (!startValue || !endValue || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw new ApiError(400, 'A valid start and end time are required');
  }
  if (endAt <= startAt) throw new ApiError(400, 'End time must be after start time');
  if (startAt <= new Date()) throw new ApiError(400, 'Start time must be in the future');
  return { startAt, endAt };
}

function assignmentOverlapFilter(startAt, endAt) {
  if (!startAt && !endAt) return {};
  return {
    $or: [
      { startAt: { $exists: false }, endAt: { $exists: false } },
      {
        $and: [
          { startAt: { $exists: true, $lte: endAt } },
          { endAt: { $exists: true, $gte: startAt } },
        ],
      },
    ],
  };
}

async function getAvailableOptions(startAt, endAt, passengerCount, preferredVehicleType) {
  const busy = await VehicleAssignment.find({
    status: 'assigned',
    ...(startAt && endAt ? assignmentOverlapFilter(startAt, endAt) : {}),
  }).select('vehicle driver');
  const busyVehicleIds = busy.map((item) => String(item.vehicle));
  const busyDriverIds = busy.map((item) => String(item.driver));

  const [vehicles, drivers] = await Promise.all([
    Vehicle.find({
      status: 'active',
      _id: { $nin: busyVehicleIds },
      ...(passengerCount && { seatingCapacity: { $gte: passengerCount } }),
      ...(preferredVehicleType && { vehicleType: preferredVehicleType }),
    })
      .select('regNo make model vehicleType seatingCapacity')
      .sort('regNo'),
    User.find({
      role: ROLES.DRIVER,
      isActive: true,
      _id: { $nin: busyDriverIds },
    })
      .select('name phone driverProfile.licenseExpiry')
      .sort('name'),
  ]);
  return { vehicles, drivers: drivers.filter((driver) => licenseValidThrough(driver.driverProfile?.licenseExpiry, endAt)) };
}

async function assertAvailable(vehicleId, driverId, startAt, endAt, passengerCount, preferredVehicleType, excludeAssignmentId) {
  if (!mongoose.isValidObjectId(vehicleId)) throw new ApiError(400, 'Select a valid fleet vehicle');
  if (!mongoose.isValidObjectId(driverId)) throw new ApiError(400, 'Select a valid driver');
  if (startAt && endAt && endAt <= startAt) throw new ApiError(400, 'End time must be after start time');
  if (startAt && startAt <= new Date()) throw new ApiError(400, 'Cannot assign a vehicle after the requested start time');
  const assignmentWindowEnd = endAt || new Date();
  const [vehicle, driver] = await Promise.all([
    Vehicle.findOne({ _id: vehicleId, status: 'active' })
      .select('regNo seatingCapacity vehicleType'),
    User.findOne({ _id: driverId, role: ROLES.DRIVER, isActive: true }).select('name driverProfile.licenseExpiry'),
  ]);
  if (!vehicle) throw new ApiError(400, 'Select an active fleet vehicle');
  if (!driver) throw new ApiError(400, 'Select an active driver');
  if (preferredVehicleType && vehicle.vehicleType !== preferredVehicleType) {
    throw new ApiError(400, 'The selected vehicle does not match the requested vehicle type');
  }
  if (passengerCount && vehicle.seatingCapacity < passengerCount) {
    throw new ApiError(400, `The selected vehicle has only ${vehicle.seatingCapacity} seats`);
  }

  const expiry = driver.driverProfile?.licenseExpiry;
  if (!licenseValidThrough(expiry, assignmentWindowEnd)) {
    throw new ApiError(400, `${driver.name}'s driving licence is not valid through the requested assignment`);
  }

  const vehicleConflictFilter = {
    status: 'assigned',
    vehicle: vehicleId,
    ...(excludeAssignmentId && { _id: { $ne: excludeAssignmentId } }),
  };
  if (startAt && endAt) Object.assign(vehicleConflictFilter, assignmentOverlapFilter(startAt, endAt));
  const activeVehicleAssignment = await VehicleAssignment.findOne(vehicleConflictFilter).populate('vehicle', 'regNo');
  if (activeVehicleAssignment) {
    throw new ApiError(409, `Vehicle ${activeVehicleAssignment.vehicle?.regNo || ''} already has an active assignment`.trim());
  }
  const driverConflictFilter = {
    status: 'assigned',
    driver: driverId,
    ...(excludeAssignmentId && { _id: { $ne: excludeAssignmentId } }),
  };
  if (startAt && endAt) Object.assign(driverConflictFilter, assignmentOverlapFilter(startAt, endAt));
  const activeDriverAssignment = await VehicleAssignment.findOne(driverConflictFilter).populate('driver', 'name');
  if (activeDriverAssignment) {
    throw new ApiError(409, `Driver ${activeDriverAssignment.driver?.name || ''} already has an active assignment`.trim());
  }

  return { vehicle, driver };
}

// GET /api/vehicle-assignments/availability?startAt=&endAt= (optional request window)
export const getAssignmentAvailability = asyncHandler(async (req, res) => {
  let startAt;
  let endAt;
  if (req.query.startAt || req.query.endAt) ({ startAt, endAt } = getWindow(req.query.startAt, req.query.endAt));
  const passengerCount = req.query.passengerCount === undefined ? undefined : Number(req.query.passengerCount);
  if (passengerCount !== undefined && (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 100)) {
    throw new ApiError(400, 'Passenger count must be between 1 and 100');
  }
  const preferredVehicleType = req.query.vehicleType;
  if (preferredVehicleType && !VEHICLE_TYPES.includes(preferredVehicleType)) {
    throw new ApiError(400, 'Vehicle type is invalid');
  }
  res.json({ data: await getAvailableOptions(startAt, endAt, passengerCount, preferredVehicleType) });
});

// GET /api/vehicle-assignments?page=&limit=&status=
export const listVehicleAssignments = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const filter = {};
  if (['pending', 'assigned', 'rejected', 'cancelled', 'completed'].includes(req.query.status)) {
    filter.status = req.query.status;
  }
  if (['availability', 'request'].includes(req.query.type)) {
    filter.type = req.query.type;
  }
  if (req.query.from || req.query.to) {
    const dateFilter = {};
    for (const [key, value, suffix] of [
      ['from', req.query.from, 'T00:00:00.000Z'],
      ['to', req.query.to, 'T23:59:59.999Z'],
    ]) {
      if (!value) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new ApiError(400, `The ${key} date must use YYYY-MM-DD format`);
      }
      const date = new Date(`${value}${suffix}`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new ApiError(400, `The ${key} date is invalid`);
      }
      dateFilter[key === 'from' ? '$gte' : '$lte'] = date;
    }
    if (dateFilter.$gte && dateFilter.$lte && dateFilter.$gte > dateFilter.$lte) {
      throw new ApiError(400, 'The start date must be on or before the end date');
    }
    filter.$or = [
      { startAt: dateFilter },
      { startAt: { $exists: false }, createdAt: dateFilter },
    ];
  }
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  if (search) {
    const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [vehicleIds, userIds] = await Promise.all([
      Vehicle.find({ $or: [{ regNo: expression }, { make: expression }, { model: expression }] }).distinct('_id'),
      User.find({ $or: [{ name: expression }, { phone: expression }] }).distinct('_id'),
    ]);
    const searchConditions = [
      { vehicle: { $in: vehicleIds } },
      { driver: { $in: userIds } },
      { requestedBy: { $in: userIds } },
      { purpose: expression },
      { pickupLocation: expression },
      { destination: expression },
    ];
    if (mongoose.isValidObjectId(search)) searchConditions.push({ _id: search });
    filter.$and = [{ $or: searchConditions }];
  }
  if (req.user.role === ROLES.TRANSPORT_USER) {
    filter.type = 'request';
    filter.requestedBy = req.user._id;
  } else if (!isManager(req.user)) {
    throw new ApiError(403, 'You do not have permission to view vehicle assignments', 'FORBIDDEN');
  }

  const [data, total] = await Promise.all([
    VehicleAssignment.find(filter)
      .populate(assignmentPopulate)
      .sort({ startAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VehicleAssignment.countDocuments(filter),
  ]);
  res.json({ data, pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) } });
});

// GET /api/vehicle-assignments/my-trips?page=&limit=
export const listDriverTrips = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const filter = { driver: req.user._id, status: { $in: ['assigned', 'completed'] } };

  const [data, total] = await Promise.all([
    VehicleAssignment.find(filter)
      .populate(assignmentPopulate)
      .sort({ status: 1, startAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VehicleAssignment.countDocuments(filter),
  ]);
  res.json({ data, pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) } });
});

// POST /api/vehicle-assignments
export const createVehicleAssignment = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.TRANSPORT_USER) {
    const { startAt, endAt } = getWindow(req.body.startAt, req.body.endAt);
    const idempotencyKey =
      (typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'].trim().slice(0, 100)) ||
      (typeof req.body.idempotencyKey === 'string' ? req.body.idempotencyKey.trim().slice(0, 100) : undefined);
    if (req.body.preferredVehicleType && !VEHICLE_TYPES.includes(req.body.preferredVehicleType)) {
      throw new ApiError(400, 'Vehicle type is invalid');
    }
    if (idempotencyKey) {
      const existing = await VehicleAssignment.findOne({ requestedBy: req.user._id, idempotencyKey });
      if (existing) return res.status(200).json({ data: existing, duplicate: true });
    }
    let assignment;
    try {
      assignment = await VehicleAssignment.create({
        type: 'request',
        status: 'pending',
        requestedBy: req.user._id,
        ...(idempotencyKey && { idempotencyKey }),
        startAt,
        endAt,
        purpose: req.body.purpose,
        preferredVehicleType: req.body.preferredVehicleType || undefined,
        pickupLocation: req.body.pickupLocation,
        destination: req.body.destination,
        passengerCount: req.body.passengerCount,
        notes: req.body.notes,
      });
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        const existing = await VehicleAssignment.findOne({ requestedBy: req.user._id, idempotencyKey });
        if (existing) return res.status(200).json({ data: existing, duplicate: true });
      }
      throw error;
    }
    await assignment.populate(assignmentPopulate);
    await notifyFleetManagers({
      title: 'New vehicle request',
      body: `${req.user.name} requested transport to ${req.body.destination}.`,
      category: 'vehicle_request',
      data: { route: '/vehicle-assignments', assignmentId: String(assignment._id) },
    });
    return res.status(201).json({ data: assignment });
  }

  if (!isManager(req.user)) throw new ApiError(403, 'You do not have permission to create assignments', 'FORBIDDEN');
  let startAt;
  let endAt;
  if (req.body.startAt || req.body.endAt) ({ startAt, endAt } = getWindow(req.body.startAt, req.body.endAt));
  const { vehicle, driver, assignment } = await withAssignmentResourceLocks(
    [`vehicle:${req.body.vehicle}`, `driver:${req.body.driver}`],
    async () => {
      const { vehicle, driver } = await assertAvailable(req.body.vehicle, req.body.driver, startAt, endAt);
      let assignment;
      try {
        assignment = await VehicleAssignment.create({
          type: 'availability',
          status: 'assigned',
          vehicle: vehicle._id,
          driver: driver._id,
          assignedBy: req.user._id,
          ...(startAt && endAt && { startAt, endAt }),
          purpose: req.body.purpose,
          notes: req.body.notes,
          history: [{
            toStatus: 'assigned',
            changedBy: req.user._id,
            vehicle: vehicle._id,
            driver: driver._id,
          }],
        });
      } catch (error) {
        if (error?.code === 11000) {
          throw new ApiError(409, 'Vehicle or driver was assigned concurrently. Refresh availability and try again.');
        }
        throw error;
      }
      return { vehicle, driver, assignment };
    }
  );
  await assignment.populate(assignmentPopulate);
  await createNotification({
    recipient: driver._id,
    title: 'New trip assignment',
    body: `Vehicle ${vehicle.regNo} has been assigned to you.`,
    category: 'assignment',
    data: { route: '/trips', assignmentId: String(assignment._id) },
  });
  res.status(201).json({ data: assignment });
});

// GET /api/vehicle-assignments/:id/trip-sheets?page=&limit=
export const listTripSheets = asyncHandler(async (req, res) => {
  const assignment = await VehicleAssignment.findById(req.params.id);
  if (!assignment) throw new ApiError(404, 'Vehicle assignment not found');
  if (!isManager(req.user) && !assignment.driver?.equals(req.user._id)) {
    throw new ApiError(403, 'You do not have permission to view these trip sheets', 'FORBIDDEN');
  }
  await assignment.populate([
    { path: 'vehicle', select: 'regNo make model vehicleType seatingCapacity' },
    { path: 'driver', select: 'name phone' },
  ]);

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const filter = { assignment: assignment._id };
  const [data, total] = await Promise.all([
    TripSheet.find(filter)
      .populate('vehicle', 'regNo make model')
      .populate('driver', 'name phone')
      .sort({ submittedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    TripSheet.countDocuments(filter),
  ]);
  res.json({
    assignment,
    data,
    pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) },
  });
});

// POST /api/vehicle-assignments/:id/trip-sheets
export const submitTripSheet = asyncHandler(async (req, res) => {
  const { startOdometer, endOdometer, fuelConsumed, notes } = req.body;
  const isOdometer = (value) => Number.isInteger(value) && value >= 0 && value <= 99999999;
  if (!isOdometer(startOdometer) || !isOdometer(endOdometer)) {
    throw new ApiError(400, 'Enter valid start and end odometer readings in kilometres');
  }
  if (endOdometer < startOdometer) {
    throw new ApiError(400, 'End odometer must be greater than or equal to start odometer');
  }
  if (fuelConsumed !== undefined && (!Number.isFinite(fuelConsumed) || fuelConsumed < 0 || fuelConsumed > 100000)) {
    throw new ApiError(400, 'Fuel consumed must be between 0 and 100,000 litres');
  }
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 1000)) {
    throw new ApiError(400, 'Trip notes must be 1,000 characters or fewer');
  }

  const idempotencyKey =
    (typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'].trim().slice(0, 100)) ||
    (typeof req.body.idempotencyKey === 'string' ? req.body.idempotencyKey.trim().slice(0, 100) : undefined);
  if (idempotencyKey) {
    const existing = await TripSheet.findOne({
      driver: req.user._id,
      assignment: req.params.id,
      idempotencyKey,
    });
    if (existing) return res.status(200).json({ data: existing, duplicate: true });
  }

  const assignment = await VehicleAssignment.findOne({
    _id: req.params.id,
    driver: req.user._id,
    status: 'assigned',
  }).select('vehicle startAt endAt');
  if (!assignment) {
    throw new ApiError(404, 'Assigned trip not found or it has already been completed');
  }
  if (assignment.startAt && assignment.endAt) {
    const submittedAt = new Date();
    if (submittedAt < assignment.startAt || submittedAt > assignment.endAt) {
      throw new ApiError(400, 'Trip sheets must be submitted within the assigned trip window');
    }
  }
  const previousSheet = await TripSheet.findOne({ assignment: assignment._id })
    .sort({ submittedAt: -1 })
    .select('endOdometer submittedAt');
  if (previousSheet && startOdometer < previousSheet.endOdometer) {
    throw new ApiError(400, `Start odometer cannot be lower than the previous entry (${previousSheet.endOdometer} km)`);
  }
  let tripSheet;
  try {
    tripSheet = await TripSheet.create({
      assignment: assignment._id,
      driver: req.user._id,
      vehicle: assignment.vehicle,
      startOdometer,
      endOdometer,
      ...(fuelConsumed !== undefined && { fuelConsumed }),
      ...(notes?.trim() && { notes: notes.trim() }),
      submittedAt: new Date(),
      ...(idempotencyKey && { idempotencyKey }),
    });
  } catch (error) {
    if (error?.code === 11000 && idempotencyKey) {
      const existing = await TripSheet.findOne({
        driver: req.user._id,
        assignment: assignment._id,
        idempotencyKey,
      });
      if (existing) return res.status(200).json({ data: existing, duplicate: true });
    }
    throw error;
  }
  await notifyFleetManagers({
    title: 'Trip sheet submitted',
    body: `${req.user.name} submitted a trip sheet for assignment ${assignment._id}.`,
    category: 'trip_sheet',
    data: { route: '/vehicle-assignments', assignmentId: String(assignment._id) },
  });
  res.status(201).json({ data: tripSheet });
});

// PATCH /api/vehicle-assignments/:id/assign
export const assignVehicleRequest = asyncHandler(async (req, res) => {
  let assignment = await VehicleAssignment.findOne({ _id: req.params.id, type: 'request', status: 'pending' });
  if (!assignment) throw new ApiError(404, 'Pending vehicle request not found');
  const { vehicle, driver, updatedAssignment } = await withAssignmentResourceLocks(
    [`vehicle:${req.body.vehicle}`, `driver:${req.body.driver}`],
    async () => {
      const { vehicle, driver } = await assertAvailable(
        req.body.vehicle,
        req.body.driver,
        assignment.startAt,
        assignment.endAt,
        assignment.passengerCount,
        assignment.preferredVehicleType,
        assignment._id
      );
      let updatedAssignment;
      try {
        updatedAssignment = await VehicleAssignment.findOneAndUpdate(
          { _id: assignment._id, type: 'request', status: 'pending' },
          {
            $set: {
              vehicle: vehicle._id,
              driver: driver._id,
              assignedBy: req.user._id,
              status: 'assigned',
            },
            $push: {
              history: {
                fromStatus: 'pending',
                toStatus: 'assigned',
                changedBy: req.user._id,
                vehicle: vehicle._id,
                driver: driver._id,
                changedAt: new Date(),
              },
            },
          },
          { new: true, runValidators: true }
        );
      } catch (error) {
        if (error?.code === 11000) {
          throw new ApiError(409, 'Vehicle or driver was assigned concurrently. Refresh availability and try again.');
        }
        throw error;
      }
      if (!updatedAssignment) throw new ApiError(409, 'This request was already assigned or changed');
      return { vehicle, driver, updatedAssignment };
    }
  );
  assignment = updatedAssignment;
  await assignment.populate(assignmentPopulate);
  await createNotification({
    recipient: assignment.driver,
    title: 'Vehicle request assigned',
    body: `${vehicle.regNo} has been assigned to your trip to ${assignment.destination}.`,
    category: 'assignment',
    data: { route: '/trips', assignmentId: String(assignment._id) },
  });
  await createNotification({
    recipient: assignment.requestedBy,
    title: 'Vehicle request approved',
    body: `Your request has been assigned vehicle ${vehicle.regNo}.`,
    category: 'vehicle_request',
    data: { route: '/vehicle-requests', assignmentId: String(assignment._id) },
  });
  res.json({ data: assignment });
});

// PATCH /api/vehicle-assignments/:id/status { status }
export const updateVehicleAssignmentStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  let assignment = await VehicleAssignment.findById(req.params.id);
  if (!assignment) throw new ApiError(404, 'Vehicle assignment not found');

  if (req.user.role === ROLES.TRANSPORT_USER) {
    if (assignment.requestedBy?.equals(req.user._id) && assignment.status === 'cancelled' && status === 'cancelled') {
      return res.json({ data: assignment, duplicate: true });
    }
    if (!assignment.requestedBy?.equals(req.user._id) || assignment.status !== 'pending' || status !== 'cancelled') {
      throw new ApiError(403, 'You can only cancel your own pending vehicle requests', 'FORBIDDEN');
    }
  } else if (!isManager(req.user)) {
    throw new ApiError(403, 'You do not have permission to update vehicle assignments', 'FORBIDDEN');
  } else if (!['rejected', 'cancelled', 'completed'].includes(status)) {
    throw new ApiError(400, 'Status must be rejected, cancelled, or completed');
  } else if (status === 'rejected' && assignment.status !== 'pending') {
    throw new ApiError(400, 'Only pending requests can be rejected');
  } else if (status === 'completed' && assignment.status !== 'assigned') {
    throw new ApiError(400, 'Only assigned trips can be completed');
  }

  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : undefined;
  const previousStatus = assignment.status;
  const filter = { _id: assignment._id, status: previousStatus };
  const updatedAssignment = await VehicleAssignment.findOneAndUpdate(
    filter,
    {
      $set: { status },
      $push: {
        history: {
          fromStatus: previousStatus,
          toStatus: status,
          changedBy: req.user._id,
          reason,
          vehicle: assignment.vehicle,
          driver: assignment.driver,
          changedAt: new Date(),
        },
      },
    },
    { new: true, runValidators: true }
  );
  if (!updatedAssignment) throw new ApiError(409, 'This assignment changed before the status update completed');
  assignment = updatedAssignment;
  await assignment.populate(assignmentPopulate);
  if (assignment.requestedBy) {
    const title = status === 'rejected'
      ? 'Vehicle request rejected'
      : status === 'completed'
        ? 'Trip completed'
        : 'Vehicle request cancelled';
    const body = status === 'completed'
      ? `Your trip to ${assignment.destination || 'the requested destination'} was completed.`
      : `Your vehicle request status changed to ${status}.`;
    await createNotification({
      recipient: assignment.requestedBy,
      title,
      body,
      category: 'vehicle_request',
      data: { route: '/vehicle-requests', assignmentId: String(assignment._id) },
    });
  }
  if (assignment.driver && status === 'completed') {
    await createNotification({
      recipient: assignment.driver,
      title: 'Trip completed',
      body: `Your trip assignment ${assignment._id} was marked completed.`,
      category: 'assignment',
      data: { route: '/trips', assignmentId: String(assignment._id) },
    });
  }
  res.json({ data: assignment });
});