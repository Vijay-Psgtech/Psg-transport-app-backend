import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import AdvanceRequest from '../models/AdvanceRequest.js';

function validAdvance() {
  const id = new mongoose.Types.ObjectId();
  return new AdvanceRequest({
    assignment: new mongoose.Types.ObjectId(),
    driver: new mongoose.Types.ObjectId(),
    vehicle: new mongoose.Types.ObjectId(),
    destination: 'Coimbatore',
    distanceKm: 125.5,
    requestedAmount: 5000,
    requestReceipt: { reference: `ADV-${id.toString()}`, issuedAt: new Date() },
  });
}

test('advance requests store request receipts and supported workflow states', () => {
  for (const status of ['pending', 'approved', 'rejected', 'acknowledged']) {
    const request = validAdvance();
    request.status = status;
    assert.equal(request.validateSync(), undefined, `${status} should be accepted`);
  }
});

test('advance requests reject invalid amounts, distances, and states', () => {
  const request = validAdvance();
  request.requestedAmount = 0;
  request.distanceKm = -1;
  request.status = 'paid';

  const validation = request.validateSync();
  assert.equal(validation.errors.requestedAmount.kind, 'min');
  assert.equal(validation.errors.distanceKm.kind, 'min');
  assert.equal(validation.errors.status.kind, 'enum');
});
