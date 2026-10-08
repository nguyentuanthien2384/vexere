'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../index');

test('production refuses an incomplete deployment before touching a database', async () => {
  await assert.rejects(createApp({ env: { NODE_ENV: 'production' } }), /SESSION_SECRET/);
  await assert.rejects(createApp({ env: { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(48) } }), /DATABASE_URL/);
  await assert.rejects(createApp({ env: { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(48), DATABASE_URL: 'postgres://unused', SEED_DEMO: 'true' } }), /SEED_DEMO/);
  await assert.rejects(createApp({ env: { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(48), DATABASE_URL: 'postgres://unused', APP_URL: 'http://example.com' } }), /HTTPS/);
});

test('web boundary rejects cross-site writes and keeps secrets and legacy maintenance URLs inaccessible', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket4t-web-'));
  const runtime = await createApp({ env: { NODE_ENV: 'test', SESSION_SECRET: 'test-secret-'.repeat(5), SEED_DEMO: 'false' }, dataDir, seedDemo: false, disableRateLimit: true });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve)); await runtime.close();
    const cleanupTarget = path.resolve(dataDir);
    assert.ok(cleanupTarget.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(cleanupTarget).startsWith('ticket4t-web-'));
    await fs.rm(cleanupTarget, { recursive: true, force: true });
  });
  const crossSite = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(crossSite.status, 403);
  for (const endpoint of ['/.env', '/config/config.json', '/data/ticket4t.sqlite', '/createTables', '/syncPassword']) {
    const response = await fetch(base + endpoint);
    assert.equal(response.status, 404, endpoint);
  }
  const malformed = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-powered-by'), null);
  const adminData = await fetch(base + '/api/admin/bookings');
  assert.ok([401, 403].includes(adminData.status));
});
