import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import ServiceRecord from '../models/ServiceRecord.js';
import { SERVICE_TYPES } from '../constants/serviceHistory.js';

test('service records accept categories used by the web and Expo clients', () => {
  for (const serviceType of SERVICE_TYPES) {
    const record = new ServiceRecord({
      vehicle: new mongoose.Types.ObjectId(),
      serviceType,
      serviceDate: new Date(),
      odometer: 0,
      workDescription: 'Routine inspection',
      createdBy: new mongoose.Types.ObjectId(),
    });

    assert.equal(record.validateSync(), undefined, `${serviceType} should be accepted`);
  }
});

test('service records reject unknown categories', () => {
  const record = new ServiceRecord({
    vehicle: new mongoose.Types.ObjectId(),
    serviceType: 'unknown',
    serviceDate: new Date(),
    odometer: 0,
    workDescription: 'Routine inspection',
    createdBy: new mongoose.Types.ObjectId(),
  });

  assert.equal(record.validateSync().errors.serviceType.kind, 'enum');
});
