import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import VehicleAssignment from '../models/VehicleAssignment.js';
import TripSheet from '../models/TripSheet.js';

test('assignments record status history and accept direct assignments', () => {
  const actor = new mongoose.Types.ObjectId();
  const vehicle = new mongoose.Types.ObjectId();
  const driver = new mongoose.Types.ObjectId();
  const assignment = new VehicleAssignment({
    type: 'availability',
    status: 'assigned',
    vehicle,
    driver,
    assignedBy: actor,
    history: [{
      toStatus: 'assigned',
      changedBy: actor,
      vehicle,
      driver,
    }],
  });

  assert.equal(assignment.validateSync(), undefined);
  assert.equal(assignment.history.length, 1);
  assert.equal(assignment.history[0].toStatus, 'assigned');
});

test('request assignments require a valid start and end window', () => {
  const requester = new mongoose.Types.ObjectId();
  const assignment = new VehicleAssignment({
    type: 'request',
    status: 'pending',
    requestedBy: requester,
    startAt: new Date('2026-12-02T10:00:00.000Z'),
    endAt: new Date('2026-12-02T09:00:00.000Z'),
    purpose: 'Institution visit',
    pickupLocation: 'Main campus',
    destination: 'Coimbatore',
    passengerCount: 4,
  });

  const validation = assignment.validateSync();
  assert.equal(validation.errors.endAt.kind, 'user defined');
});

test('trip sheets support idempotency keys and enforce odometer direction', () => {
  const sheet = new TripSheet({
    assignment: new mongoose.Types.ObjectId(),
    driver: new mongoose.Types.ObjectId(),
    vehicle: new mongoose.Types.ObjectId(),
    startOdometer: 500,
    endOdometer: 450,
    submittedAt: new Date(),
    idempotencyKey: 'trip-submit-123',
  });

  const validation = sheet.validateSync();
  assert.equal(validation.errors.endOdometer.kind, 'user defined');
});