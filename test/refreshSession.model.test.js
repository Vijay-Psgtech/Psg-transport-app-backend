import assert from 'node:assert/strict';
import test from 'node:test';
import RefreshSession from '../models/RefreshSession.js';

test('refresh sessions enforce unique token hashes and expire by TTL', () => {
  const indexes = RefreshSession.schema.indexes();

  assert.ok(indexes.some(([keys, options]) => keys.sessionId === 1 && options.unique === true));
  assert.ok(indexes.some(([keys, options]) => keys.tokenHash === 1 && options.unique === true));
  assert.ok(indexes.some(([keys, options]) => keys.expiresAt === 1 && options.expireAfterSeconds === 0));
});
