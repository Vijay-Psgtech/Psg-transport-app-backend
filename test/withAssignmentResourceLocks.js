import { randomUUID } from 'node:crypto';
import AssignmentResourceLock from '../models/AssignmentResourceLock.js';
import ApiError from './ApiError.js';
import { log } from './logger.js';

const LOCK_TTL_MS = 60 * 1000;

export default async function withAssignmentResourceLocks(resourceIds, operation) {
  const owner = randomUUID();
  const keys = [...new Set(resourceIds.filter(Boolean).map((value) => String(value).toLowerCase()))]
    .map((id) => id.startsWith('vehicle:') || id.startsWith('driver:') ? id : `resource:${id}`)
    .sort();
  const acquired = [];

  try {
    for (const key of keys) {
      try {
        await AssignmentResourceLock.findOneAndUpdate(
          {
            _id: key,
            $or: [{ expiresAt: { $lte: new Date() } }, { owner }],
          },
          { $set: { owner, expiresAt: new Date(Date.now() + LOCK_TTL_MS) } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        acquired.push(key);
      } catch (error) {
        if (error.code === 11000) {
          throw new ApiError(409, 'Vehicle or driver availability is being updated. Refresh and try again.');
        }
        throw error;
      }
    }

    return await operation();
  } finally {
    if (acquired.length) {
      try {
        await AssignmentResourceLock.deleteMany({ _id: { $in: acquired }, owner });
      } catch (error) {
        log('error', 'assignment_lock_release_failed', { message: error.message, resources: acquired.length });
      }
    }
  }
}