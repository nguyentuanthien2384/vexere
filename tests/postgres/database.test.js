'use strict';

const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {openDatabase, DatabaseSessionStore} = require('../../server/database');

let db;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Run through npm run test:postgres');
  db = await openDatabase({env: {DATABASE_URL: process.env.TEST_DATABASE_URL, PG_SSL: process.env.PG_SSL, PG_SSL_REJECT_UNAUTHORIZED: process.env.PG_SSL_REJECT_UNAUTHORIZED}});
  assert.equal(db.dialect, 'postgres');
});
after(async () => { if (db) await db.close(); });

test('[IT-PG-001] PostgreSQL commit persists data and failed transaction rolls back every write', async () => {
  await db.transaction(tx => tx.run('INSERT INTO settings(key,value) VALUES(?,?)', ['commit', 'saved']));
  assert.equal((await db.get('SELECT value FROM settings WHERE key=?', ['commit'])).value, 'saved');
  await assert.rejects(db.transaction(async tx => {
    await tx.run('INSERT INTO settings(key,value) VALUES(?,?)', ['rollback', 'temporary']);
    await tx.run('INSERT INTO settings(key,value) VALUES(?,?)', ['commit', 'duplicate']);
  }), error => error.code === '23505');
  assert.equal(await db.get('SELECT value FROM settings WHERE key=?', ['rollback']), undefined);
  assert.equal((await db.get('SELECT value FROM settings WHERE key=?', ['commit'])).value, 'saved');
});

test('[IT-PG-002] a concurrent unique-key race has one winner and leaves the pool usable', async () => {
  const results = await Promise.allSettled(Array.from({length: 8}, () => db.transaction(tx => tx.run('INSERT INTO settings(key,value) VALUES(?,?)', ['race', 'winner']))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === '23505'));
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM settings WHERE key=?', ['race'])).n), 1);
});

test('[IT-PG-003] session upsert, expired-session rejection and destroy use the real PostgreSQL store', async () => {
  const store = new DatabaseSessionStore(db);
  const call = (method, ...args) => new Promise((resolve, reject) => store[method](...args, (error, value) => error ? reject(error) : resolve(value)));
  const value = {cookie: {expires: new Date(Date.now() + 60000)}, userId: 'test-user'};
  await call('set', 'session', value);
  assert.equal((await call('get', 'session')).userId, 'test-user');
  await call('touch', 'session', {...value, userId: 'updated'});
  assert.equal((await call('get', 'session')).userId, 'updated');
  await call('set', 'expired', {cookie: {expires: new Date(0)}});
  assert.equal(await call('get', 'expired'), null);
  await call('destroy', 'session');
  assert.equal(await call('get', 'session'), null);
});
