'use strict';

require('dotenv').config();
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

async function createApp(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  if (production && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) throw new Error('Production requires SESSION_SECRET containing at least 32 characters.');
  if (production && !env.DATABASE_URL) throw new Error('Production requires DATABASE_URL for PostgreSQL.');
  if (production && env.SEED_DEMO === 'true') throw new Error('Disable SEED_DEMO before starting production.');
  if (production && (!env.APP_URL || !env.APP_URL.startsWith('https://'))) throw new Error('Production requires a public HTTPS APP_URL.');
  if (production && env.VNPAY_TMN_CODE && env.VNPAY_HASH_SECRET && (!env.VNPAY_URL || /sandbox/i.test(env.VNPAY_URL))) {
    throw new Error('Production requires the live VNPAY_URL supplied in your merchant agreement.');
  }
  if (production) {
    const {providerConfig}=require('./server/wallet-payments');
    for (const [provider,keys] of [['momo',['MOMO_PARTNER_CODE','MOMO_ACCESS_KEY','MOMO_SECRET_KEY']],['zalopay',['ZALOPAY_APP_ID','ZALOPAY_KEY1','ZALOPAY_KEY2']]]) {
      if (keys.every(key=>env[key]) && !providerConfig(provider,env).configured) throw new Error('Production requires valid live '+provider.toUpperCase()+' merchant configuration.');
    }
  }
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    const directory = path.resolve(options.dataDir || env.DATA_DIR || path.join(__dirname, 'data'));
    fs.mkdirSync(directory, { recursive: true });
    const secretFile = path.join(directory, '.session-secret');
    if (fs.existsSync(secretFile)) sessionSecret = fs.readFileSync(secretFile, 'utf8').trim();
    else {
      sessionSecret = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(secretFile, sessionSecret, { mode: 0o600, flag: 'wx' });
    }
  }
  const { createApi } = require('./server/app');
  const api = await createApi({ ...options, env });
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'], fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
      frameAncestors: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: production ? [] : null,
    } },
    strictTransportSecurity: production, crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      // Wallet IPNs authenticate the provider signature inside the handler and
      // cannot use browser origin or customer cookies as their authentication.
      if (req.method==='POST' && /^\/payments\/(momo|zalopay)\/ipn\/?$/.test(req.path)) return next();
      const origin = req.get('origin');
      const expectedOrigin = env.APP_URL ? new URL(env.APP_URL).origin : `${req.protocol}://${req.get('host')}`;
      if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expectedOrigin)) {
        return res.status(403).json({ error: 'Yêu cầu không cùng nguồn với website.', code: 'INVALID_ORIGIN' });
      }
    }
    next();
  });
  if (!options.disableRateLimit) {
    app.use('/api', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false,
      message: { error: 'Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau một phút.' } }));
    app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false,
      message: { error: 'Vui lòng chờ trước khi thử đăng nhập lại.' } }));
    app.use('/api/bookings', rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false,
      message: { error: 'Vui lòng chờ trước khi tra cứu hoặc đặt vé tiếp.' } }));
  }
  app.use(session({
    name: 'ticket4t.sid', secret: sessionSecret,
    store: api.sessionStore, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 7 * 24 * 60 * 60_000 },
  }));
  app.use('/api', api.router);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy API.', code: 'NOT_FOUND' }));
  // Only these browser bundles and their licenses are public. Reject the whole
  // vendor prefix before static files and the admin SPA can handle a miss.
  const vendorAssets = new Map([
    ['/admin/vendor/chart.umd.js', ['chart.js/dist/chart.umd.js', 'application/javascript']],
    ['/admin/vendor/papaparse.min.js', ['papaparse/papaparse.min.js', 'application/javascript']],
    ['/admin/vendor/chart.LICENSE.md', ['chart.js/LICENSE.md', 'text/plain']],
    ['/admin/vendor/papaparse.LICENSE', ['papaparse/LICENSE', 'text/plain']],
  ]);
  app.use((req, res, next) => {
    let decodedPath = req.path;
    try { decodedPath = decodeURIComponent(decodedPath); } catch {}
    if (!/^\/admin\/vendor(?:\/|$)/i.test(req.path) && !/^\/admin\/vendor(?:\/|$)/i.test(decodedPath)) return next();
    const asset = vendorAssets.get(req.path);
    if (!asset || !['GET', 'HEAD'].includes(req.method)) return res.status(404).type('text').send('Không tìm thấy thư viện.');
    res.type(asset[1]);
    res.sendFile(path.join(__dirname, 'node_modules', asset[0]), { maxAge: production ? '1d' : 0 }, error => {
      if (error) next(error);
    });
  });
  app.use(express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'deny', maxAge: production ? '1d' : 0 }));
  app.get(['/admin', '/admin/*', '/dashboard'], (req, res) => {
    res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public/admin/index.html'));
  });
  app.get(['/', '/search-trip', '/trips/*', '/bookings/*', '/tai-khoan/*', '/nha-xe', '/about'], (req, res) => {
    res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public/app/index.html'));
  });
  app.use((req, res) => res.status(404).type('text').send('Không tìm thấy trang. Trở về trang chủ: /'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON không hợp lệ.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Dữ liệu vượt quá dung lượng cho phép.' });
    console.error('Request error:', production ? error.message : error);
    res.status(500).json({ error: 'Có lỗi hệ thống. Vui lòng thử lại.', code: 'INTERNAL_ERROR' });
  });
  app.locals.api = api;
  return { app, api, close: () => api.close() };
}

async function start() {
  const runtime = await createApp();
  const port = Number(process.env.PORT) || 3000;
  const server = runtime.app.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Ticket4T đang chạy: http://localhost:${port}`);
    console.log(`Quản trị: http://localhost:${port}/admin`);
    console.log(process.env.NODE_ENV === 'production' ? 'Chế độ vận hành PostgreSQL.' : 'Chế độ phát triển. Dữ liệu minh họa được đánh dấu trong ứng dụng.');
  });
  server.on('error', async error => {
    console.error(error.code === 'EADDRINUSE' ? `Cổng ${port} đã được sử dụng. Đổi PORT trong .env.` : error.message);
    await runtime.close(); process.exitCode = 1;
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(async () => { await runtime.close(); process.exit(0); });
    const timer = setTimeout(() => process.exit(1), 10_000); timer.unref();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  return { ...runtime, server };
}

if (require.main === module) start().catch(error => { console.error('Không thể khởi động:', error.message); process.exitCode = 1; });
module.exports = { createApp, start };
