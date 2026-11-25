import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvironment } from '../config/env.js';

const validEnvironment = {
  MONGO_URI: 'mongodb://127.0.0.1:27017/psg_transport',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

test('reports all required settings when they are missing', () => {
  assert.throws(
    () => validateEnvironment({}),
    /MONGO_URI, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET/
  );
});

test('accepts a database URI and two distinct secrets of at least 32 characters', () => {
  assert.doesNotThrow(() => validateEnvironment(validEnvironment));
});

test('rejects short JWT secrets', () => {
  assert.throws(
    () => validateEnvironment({ ...validEnvironment, JWT_ACCESS_SECRET: 'short' }),
    /JWT_ACCESS_SECRET must contain at least 32 characters/
  );
});

test('rejects identical access and refresh secrets', () => {
  assert.throws(
    () => validateEnvironment({
      ...validEnvironment,
      JWT_REFRESH_SECRET: validEnvironment.JWT_ACCESS_SECRET,
    }),
    /must be different values/
  );
});

test('rejects unsupported refresh-cookie SameSite policies', () => {
  assert.throws(
    () => validateEnvironment({ ...validEnvironment, REFRESH_COOKIE_SAME_SITE: 'invalid' }),
    /REFRESH_COOKIE_SAME_SITE must be strict, lax, or none/
  );
});
