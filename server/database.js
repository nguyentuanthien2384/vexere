"use strict";

const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS locations (id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL, image TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operators (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id), from_id TEXT NOT NULL REFERENCES locations(id), to_id TEXT NOT NULL REFERENCES locations(id), date TEXT NOT NULL, departure_time TEXT NOT NULL, departure_at TEXT NOT NULL, price INTEGER NOT NULL, total_seats INTEGER NOT NULL, type TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'managed', data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS trips_search_idx ON trips(from_id,to_id,date,active);
CREATE INDEX IF NOT EXISTS trips_operator_idx ON trips(operator_id,date);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', operator_id TEXT REFERENCES operators(id), verified INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, auth_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bookings (code TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), user_id TEXT REFERENCES users(id), phone TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL, payment_status TEXT NOT NULL DEFAULT 'pending', payment_method TEXT NOT NULL, total INTEGER NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings(user_id,created_at);
CREATE INDEX IF NOT EXISTS bookings_trip_idx ON bookings(trip_id,status);
CREATE TABLE IF NOT EXISTS reserved_seats (trip_id TEXT NOT NULL REFERENCES trips(id), seat TEXT NOT NULL, booking_code TEXT NOT NULL REFERENCES bookings(code), PRIMARY KEY(trip_id,seat));
CREATE TABLE IF NOT EXISTS seat_holds (hash TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), owner_key TEXT NOT NULL, expires_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS seat_holds_expiry_idx ON seat_holds(expires_at,trip_id);
CREATE TABLE IF NOT EXISTS hold_seats (trip_id TEXT NOT NULL REFERENCES trips(id), seat TEXT NOT NULL, hold_hash TEXT NOT NULL REFERENCES seat_holds(hash), PRIMARY KEY(trip_id,seat));
CREATE TABLE IF NOT EXISTS promotions (code TEXT PRIMARY KEY, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (code TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), phone TEXT NOT NULL, email TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL, total INTEGER NOT NULL, coupon_code TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id,created_at);
CREATE TABLE IF NOT EXISTS promotion_uses (id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES promotions(code), booking_code TEXT REFERENCES bookings(code), order_code TEXT REFERENCES orders(code), phone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS promotion_uses_customer_idx ON promotion_uses(code,phone,status);
CREATE TABLE IF NOT EXISTS payments (reference TEXT PRIMARY KEY, booking_code TEXT NOT NULL REFERENCES bookings(code), provider TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS booking_events (id TEXT PRIMARY KEY, booking_code TEXT NOT NULL REFERENCES bookings(code), actor TEXT NOT NULL, event TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_audit_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operator_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_events(created_at,id);
CREATE INDEX IF NOT EXISTS admin_audit_operator_idx ON admin_audit_events(operator_id,created_at);
CREATE TABLE IF NOT EXISTS auth_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), purpose TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, booking_code TEXT UNIQUE NOT NULL REFERENCES bookings(code), operator_id TEXT NOT NULL REFERENCES operators(id), user_id TEXT NOT NULL REFERENCES users(id), rating INTEGER NOT NULL, title TEXT NOT NULL, comment TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_outbox (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at TEXT NOT NULL);
`;

async function openDatabase({env = process.env, dataDir} = {}) {
  if (env.DATABASE_URL) {
    const {Pool} = require('pg');
    const pool = new Pool({connectionString: env.DATABASE_URL, max: 12,
      ssl: env.PG_SSL === 'true' ? {rejectUnauthorized: env.PG_SSL_REJECT_UNAUTHORIZED !== 'false'} : undefined});
    const bind = (sql) => { let n = 0; return sql.replace(/\?/g, () => '$' + (++n)); };
    const api = (client) => ({
      dialect: 'postgres',
      async all(sql, params = []) { return (await client.query(bind(sql), params)).rows; },
      async get(sql, params = []) { return (await client.query(bind(sql), params)).rows[0]; },
      async run(sql, params = []) { return client.query(bind(sql), params); },
    });
    const db = {...api(pool), async transaction(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(api(client)); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }, async close() { await pool.end(); }};
    await pool.query(SCHEMA);
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1; ALTER TABLE users ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1; ALTER TABLE bookings ADD COLUMN IF NOT EXISTS order_code TEXT; ALTER TABLE bookings ADD COLUMN IF NOT EXISTS promo_code TEXT;');
    return db;
  }
  const {DatabaseSync} = require('node:sqlite');
  const directory = path.resolve(dataDir || env.DATA_DIR || path.join(process.cwd(), 'data'));
  fs.mkdirSync(directory, {recursive: true});
  const filename = env.SQLITE_FILE || path.join(directory, 'ticket4t.sqlite');
  const connection = new DatabaseSync(filename);
  connection.function('vi_lower',{deterministic:true},value => String(value || '').toLocaleLowerCase('vi'));
  connection.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;');
  connection.exec(SCHEMA);
  const userColumns=connection.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!userColumns.includes('auth_version')) connection.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1');
  if (!userColumns.includes('active')) connection.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  const bookingColumns=connection.prepare('PRAGMA table_info(bookings)').all().map(column => column.name);
  if (!bookingColumns.includes('order_code')) connection.exec('ALTER TABLE bookings ADD COLUMN order_code TEXT');
  if (!bookingColumns.includes('promo_code')) connection.exec('ALTER TABLE bookings ADD COLUMN promo_code TEXT');
  const api = {
    dialect: 'sqlite', filename,
    async all(sql, params = []) { return connection.prepare(sql).all(...params); },
    async get(sql, params = []) { return connection.prepare(sql).get(...params); },
    async run(sql, params = []) { return connection.prepare(sql).run(...params); },
  };
  // A promise mutex prevents overlapping async transactions on the same SQLite connection.
  let tail = Promise.resolve();
  return {...api, transaction(fn) {
    const work = tail.then(async () => {
      connection.exec('BEGIN IMMEDIATE');
      try { const result = await fn(api); connection.exec('COMMIT'); return result; }
      catch (error) { connection.exec('ROLLBACK'); throw error; }
    });
    tail = work.catch(() => {});
    return work;
  }, async close() { await tail; connection.close(); }};
}

class DatabaseSessionStore extends session.Store {
  constructor(db) { super(); this.db = db; }
  get(sid, callback) {
    this.db.get('SELECT data FROM sessions WHERE sid=? AND expires_at>?', [sid, new Date().toISOString()])
      .then(row => callback(null, row ? JSON.parse(row.data) : null), callback);
  }
  set(sid, value, callback = () => {}) {
    const expiry = value.cookie?.expires ? new Date(value.cookie.expires) : new Date(Date.now() + 86400000);
    this.db.transaction(tx => tx.run('INSERT INTO sessions(sid,data,expires_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at', [sid, JSON.stringify(value), expiry.toISOString()])).then(() => callback(), callback);
  }
  destroy(sid, callback = () => {}) { this.db.transaction(tx => tx.run('DELETE FROM sessions WHERE sid=?', [sid])).then(() => callback(), callback); }
  touch(sid, value, callback = () => {}) { this.set(sid, value, callback); }
}

module.exports = {openDatabase, DatabaseSessionStore};
