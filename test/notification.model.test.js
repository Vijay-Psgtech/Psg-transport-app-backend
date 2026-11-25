import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import Notification from '../models/Notification.js';

test('notifications accept workflow categories and unread state', () => {
  const notification = new Notification({
    recipient: new mongoose.Types.ObjectId(),
    title: 'Vehicle request assigned',
    body: 'Vehicle TN01AB1234 has been assigned.',
    category: 'assignment',
  });
  assert.equal(notification.validateSync(), undefined);
  assert.equal(notification.readAt, null);
});

test('notifications reject unknown categories', () => {
  const notification = new Notification({
    recipient: new mongoose.Types.ObjectId(),
    title: 'Unknown',
    body: 'Unknown category',
    category: 'unknown',
  });
  assert.equal(notification.validateSync().errors.category.kind, 'enum');
});
