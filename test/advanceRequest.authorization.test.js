import assert from 'node:assert/strict';
import test from 'node:test';
import router from '../routes/advanceRequestRoutes.js';

function routeGuard(method, path) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route should be registered`);
  return layer.route.stack[0].handle;
}

function authorizeRole(guard, role) {
  let called = false;
  let error;
  guard({ user: { role } }, {}, (nextError) => {
    called = true;
    error = nextError;
  });
  assert.equal(called, true);
  return error;
}

test('transport officers can list requests and retrieve proof images', () => {
  assert.equal(authorizeRole(routeGuard('get', '/'), 'transport_officer'), undefined);
  assert.equal(authorizeRole(routeGuard('get', '/:id/proof'), 'transport_officer'), undefined);
});

test('transport officers can review and acknowledge advances, but drivers cannot', () => {
  for (const path of ['/:id/review', '/:id/acknowledge']) {
    const guard = routeGuard('patch', path);
    assert.equal(authorizeRole(guard, 'transport_officer'), undefined);
    assert.equal(authorizeRole(guard, 'driver')?.statusCode, 403);
  }
});
