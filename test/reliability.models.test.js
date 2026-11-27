import assert from 'node:assert/strict';
import test from 'node:test';
import AssignmentResourceLock from '../models/AssignmentResourceLock.js';
import AdvanceRequest from '../models/AdvanceRequest.js';
import Notification from '../models/Notification.js';
import RateLimitBucket from '../models/RateLimitBucket.js';
import TripSheet from '../models/TripSheet.js';
import VehicleAssignment from '../models/VehicleAssignment.js';
import withAssignmentResourceLocks from '../utils/withAssignmentResourceLocks.js';

function assertScopedUniqueIndex(Model, name, keyFields) {
  const index = Model.schema.indexes().find(([, options]) => options.name === name);
  assert.ok(index, `${name} should be declared`);
  assert.equal(index[1].unique, true);
  assert.deepEqual(Object.keys(index[0]), keyFields);
  assert.deepEqual(index[1].partialFilterExpression, { idempotencyKey: { $type: 'string' } });
}

test('idempotency indexes scope duplicate keys to their owner and operation', () => {
  assertScopedUniqueIndex(TripSheet, 'uniq_trip_idempotency_scope', ['driver', 'assignment', 'idempotencyKey']);
  assertScopedUniqueIndex(AdvanceRequest, 'uniq_advance_idempotency_scope', ['driver', 'assignment', 'idempotencyKey']);
  assertScopedUniqueIndex(VehicleAssignment, 'uniq_request_idempotency_scope', ['requestedBy', 'idempotencyKey']);
});

test('notification outbox records durable retry and ticket-acceptance states', () => {
  const notification = new Notification({
    recipient: '507f1f77bcf86cd799439011',
    title: 'Assignment updated',
    body: 'Your trip was assigned.',
    category: 'assignment',
    pushDelivery: { status: 'queued', attempts: 2 },
  });
  assert.equal(notification.validateSync(), undefined);
  assert.equal(notification.pushDelivery.status, 'queued');
  notification.pushDelivery.status = 'delivered';
  notification.pushDelivery.deliveredAt = new Date();
  assert.equal(notification.validateSync(), undefined);
  notification.pushDelivery.status = 'unknown';
  assert.equal(notification.validateSync().errors['pushDelivery.status'].kind, 'enum');
});

test('shared rate-limit buckets and assignment locks expire through MongoDB TTL indexes', () => {
  assert.ok(RateLimitBucket.schema.indexes().some(([, options]) => options.expireAfterSeconds === 0));
  assert.ok(AssignmentResourceLock.schema.indexes().some(([, options]) => options.expireAfterSeconds === 0));
});

test('assignment resource locks reject overlapping reservation attempts and release acquired locks', async () => {
  const originalFindOneAndUpdate = AssignmentResourceLock.findOneAndUpdate;
  const originalDeleteMany = AssignmentResourceLock.deleteMany;
  const lockedResources = new Set();
  let releaseFirstOperation;
  let firstOperationStarted;
  const firstStarted = new Promise((resolve) => { firstOperationStarted = resolve; });
  const releaseGate = new Promise((resolve) => { releaseFirstOperation = resolve; });
  AssignmentResourceLock.findOneAndUpdate = async (filter) => {
    if (lockedResources.has(filter._id)) throw Object.assign(new Error('Duplicate resource lock'), { code: 11000 });
    lockedResources.add(filter._id);
    return {};
  };
  AssignmentResourceLock.deleteMany = async (filter) => {
    filter._id.$in.forEach((key) => lockedResources.delete(key));
    return {};
  };

  try {
    const first = withAssignmentResourceLocks(['vehicle:ABC', 'driver:XYZ'], async () => {
      firstOperationStarted();
      await releaseGate;
      return 'reserved';
    });
    await firstStarted;
    await assert.rejects(
      withAssignmentResourceLocks(['vehicle:abc', 'driver:other'], async () => 'must not reserve'),
      (error) => error.statusCode === 409
    );
    releaseFirstOperation();
    assert.equal(await first, 'reserved');
    assert.equal(lockedResources.size, 0);
  } finally {
    releaseFirstOperation();
    AssignmentResourceLock.findOneAndUpdate = originalFindOneAndUpdate;
    AssignmentResourceLock.deleteMany = originalDeleteMany;
  }
});