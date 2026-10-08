'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createApp } = require('../index');
const { addDays } = require('../server/catalog');

// Run against a fresh isolated database. Never reuse the live application's data directory.
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket4t-admin-ui-'));
  const output = path.resolve('artifacts/screenshots');
  await fs.mkdir(output, { recursive: true });
  let runtime, server, browser, fixtures;
  const failures = [], browserErrors = [];
  let passed = 0;

  async function json(response, expectedStatus = 200) {
    const data = await response.json();
    assert.equal(response.status(), expectedStatus, JSON.stringify(data));
    return data;
  }
  async function login(page, email = 'admin@ticket4t.vn', password = 'Admin@12345') {
    await page.goto(base + '/admin');
    await page.locator('#login-form').waitFor({ state: 'visible' });
    await page.fill('#login-form [name="email"]', email);
    await page.fill('#login-form [name="password"]', password);
    await page.locator('#login-form [type="submit"]').click();
    await page.locator('#portal').waitFor({ state: 'visible' });
    await page.locator('.stats-grid').first().waitFor();
  }
  async function go(page, name, ready = '#filters') {
    await page.locator(`#sidebar [data-page="${name}"]`).click();
    await page.locator(ready).first().waitFor();
    assert.equal(await page.locator('#page-title').innerText(), ({ trips: 'Chuyến xe', bookings: 'Đơn đặt vé', users: 'Tài khoản', operators: 'Nhà xe', import: 'Nhập lịch trình', audit: 'Nhật ký vận hành', dashboard: 'Tổng quan' })[name]);
  }
  async function filter(page, values, endpoint) {
    for (const [name, value] of Object.entries(values)) {
      const input = page.locator(`#filters [name="${name}"]`);
      if (await input.evaluate(element => element.tagName === 'SELECT')) await input.selectOption(value);
      else await input.fill(value);
    }
    const loaded = page.waitForResponse(response => response.url().includes('/api/admin/' + endpoint) && response.request().method() === 'GET');
    await page.locator('#filters [type="submit"]').click();
    const data = await (await loaded).json();
    await page.locator('#filters').waitFor();
    await page.locator('#content .loading').waitFor({ state: 'hidden' });
    return data;
  }
  async function save(page, endpoint, status = 200) {
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/' + endpoint && !['GET', 'HEAD'].includes(response.request().method()));
    await page.locator('#editor-form [type="submit"]').click();
    const response = await saved;
    const data = await response.json();
    assert.equal(response.status(), status, JSON.stringify(data));
    if (status < 300) await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
    else await page.locator('#editor-error').filter({ hasText: /\S/ }).waitFor();
    return data;
  }
  async function finishRendering(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function screenshot(page, filename, fullPage = true) {
    await page.screenshot({ path: path.join(output, filename), fullPage, animations: 'disabled' });
  }
  async function check(name, callback, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => browserErrors.push(name + ': ' + error.message));
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to|Uncaught/i.test(message.text())) browserErrors.push(name + ': ' + message.text()); });
    page.on('response', response => { if (response.status() === 404 && !response.url().includes('/api/') && !response.url().endsWith('/favicon.ico')) browserErrors.push('Missing asset: ' + response.url()); });
    try {
      await callback(page, context);
      passed++;
      console.log('PASS ' + name);
    } catch (error) {
      failures.push(name + ': ' + error.message);
      console.error('FAIL ' + name + ': ' + error.stack);
      await screenshot(page, 'admin-failure-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png').catch(() => {});
    } finally { await context.close(); }
  }

  let base, date, laterDate, operator, staff, trips, booked;
  try {
    runtime = await createApp({ env: { NODE_ENV: 'development', SEED_DEMO: 'true', SESSION_SECRET: 'isolated-admin-ui-tests-only-'.repeat(3) }, dataDir, seedDays: 6, disableRateLimit: true });
    server = runtime.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
    fixtures = await browser.newContext();
    await json(await fixtures.request.post(base + '/api/auth/login', { data: { email: 'admin@ticket4t.vn', password: 'Admin@12345' } }));
    const bootstrap = await json(await fixtures.request.get(base + '/api/bootstrap'));
    date = addDays(bootstrap.today, 2); laterDate = addDays(bootstrap.today, 3);
    operator = (await json(await fixtures.request.post(base + '/api/admin/operators', { data: { name: 'Nhà xe QA quản trị', phone: '0901234567', email: 'qa-operator@example.test', description: 'Kho vé kiểm thử trong cơ sở dữ liệu tạm.' } }), 201)).operator;
    staff = (await json(await fixtures.request.post(base + '/api/admin/users', { data: { fullName: 'Nhân viên QA quản trị', email: 'qa-staff@example.test', phone: '0901111222', password: 'Operator@12345', role: 'operator', operatorId: operator.id } }), 201)).user;
    const tripBody = (extra = {}) => ({ operatorId: operator.id, from: 'ho-chi-minh', to: 'da-lat', date, departureTime: '18:00', durationMinutes: 360, price: 250000, totalSeats: 9, type: 'limousine', pickupPoints: ['Văn phòng QA'], dropoffPoints: ['Bến xe QA'], amenities: ['Điều hòa'], policies: ['Có mặt trước 30 phút'], provenance: 'Nguồn lịch trình QA do nhà xe xác nhận', ...extra });
    trips = [];
    for (let index = 0; index < 18; index++) trips.push((await json(await fixtures.request.post(base + '/api/admin/trips', { data: tripBody({ departureTime: `${String(6 + Math.floor(index / 3)).padStart(2, '0')}:${String((index % 3) * 20).padStart(2, '0')}` }) }), 201)).trip);
    const guest = await browser.newContext();
    booked = [];
    for (let index = 0; index < 3; index++) booked.push((await json(await guest.request.post(base + '/api/bookings', { data: { tripId: trips[index].id, seats: ['A01'], fullName: 'Hành khách QA ' + index, phone: '0902222333', email: 'qa-passenger@example.test', pickup: trips[index].pickupPoints[0], dropoff: trips[index].dropoffPoints[0], paymentMethod: 'cash' } }), 201)).booking);
    await guest.close();

    await check('login permission and all navigation icons', async page => {
      await page.goto(base + '/admin');
      await page.fill('#login-form [name="email"]', 'khach@ticket4t.vn');
      await page.fill('#login-form [name="password"]', 'Khach@12345');
      await page.locator('#login-form [type="submit"]').click();
      await page.locator('#login-error').filter({ hasText: /quyền/ }).waitFor();
      assert.ok(await page.locator('#portal').isHidden(), 'Customer cannot enter staff portal');
      await login(page);
      assert.ok(await page.locator('#sidebar .nav-button .ticket-icon').count() >= 8, 'Every navigation item has its SVG icon');
      assert.equal(await page.locator('#sidebar .nav-button:visible').count(), await page.locator('#sidebar .nav-button:visible .ticket-icon').count());
      await screenshot(page, 'admin-dashboard-desktop.png');
      await page.locator('#logout-button').click();
      await page.locator('#login-screen').waitFor({ state: 'visible' });
      assert.ok(await page.locator('#portal').isHidden());
    });

    await check('operator scope and restricted hashes', async (page, context) => {
      await login(page, staff.email, 'Operator@12345');
      for (const name of ['users', 'operators', 'promotions']) assert.equal(await page.locator(`#sidebar [data-page="${name}"]:visible`).count(), 0);
      const data = await json(await context.request.get(base + '/api/admin/trips?limit=100'));
      assert.equal(data.total, 18); assert.ok(data.trips.every(trip => trip.operatorId === operator.id));
      const bookings = await json(await context.request.get(base + '/api/admin/bookings'));
      assert.ok(bookings.bookings.every(booking => booking.trip.operatorId === operator.id));
      assert.equal((await context.request.get(base + '/api/admin/users')).status(), 403);
      assert.equal((await context.request.get(base + '/api/admin/promotions')).status(), 403);
      await page.goto(base + '/admin#users');
      await page.locator('.stats-grid').first().waitFor();
      assert.equal(await page.locator('#page-title').innerText(), 'Tổng quan');
      await screenshot(page, 'admin-operator-desktop.png');
    });

    await check('trip filter pagination and refresh preserve state', async page => {
      await login(page); await go(page, 'trips');
      const results = await filter(page, { operator: operator.id, date, from: 'ho-chi-minh', to: 'da-lat', type: 'limousine' }, 'trips');
      assert.equal(results.total, 18); assert.equal(await page.locator('[data-action="edit-trip"]').count(), 15);
      const next = page.waitForResponse(response => response.url().includes('/api/admin/trips?') && new URL(response.url()).searchParams.get('page') === '2');
      await page.locator('[data-paginate="2"]').click(); await next;
      await page.getByText('Trang 2 / 2', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-action="edit-trip"]').count(), 3);
      assert.equal(await page.locator('#filters [name="operator"]').inputValue(), operator.id);
      const refreshed = page.waitForResponse(response => response.url().includes('/api/admin/trips?') && new URL(response.url()).searchParams.get('page') === '2');
      await page.locator('#page-actions [data-action="refresh"]').click(); await refreshed;
      await page.getByText('Trang 2 / 2', { exact: true }).waitFor();
      assert.equal(await page.locator('#filters [name="date"]').inputValue(), date);
      let invalidSearchRequests = 0;
      const countSearch = request => { if (new URL(request.url()).pathname === '/api/admin/trips') invalidSearchRequests++; };
      page.on('request', countSearch);
      await page.selectOption('#filters [name="from"]', 'da-lat');
      await page.locator('#filters [type="submit"]').click();
      await page.locator('#toast-stack').getByText('Điểm đi và điểm đến phải khác nhau.', { exact: true }).waitFor();
      assert.equal(invalidSearchRequests, 0);
      assert.equal(await page.locator('[data-action="edit-trip"]').count(), 3);
      assert.ok(await page.getByText('Trang 2 / 2', { exact: true }).isVisible());
      page.off('request', countSearch);
      await filter(page, { from: 'da-lat', to: 'ho-chi-minh' }, 'trips');
      await page.getByText('Chưa có chuyến phù hợp', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-action="edit-trip"]').count(), 0);
      await page.locator('[data-action="reset-filters"]').click();
      await page.locator('[data-action="edit-trip"]').first().waitFor();
      assert.equal(await page.locator('#filters [name="operator"]').inputValue(), '');
      await screenshot(page, 'admin-trips-desktop.png');
    });

    await check('create edit clone stop trip and booked trip protection', async page => {
      await login(page); await go(page, 'trips');
      await page.locator('[data-action="new-trip"]').click();
      await page.selectOption('#editor-form [name="operatorId"]', operator.id);
      await page.selectOption('#editor-form [name="from"]', 'ho-chi-minh'); await page.selectOption('#editor-form [name="to"]', 'da-lat');
      await page.fill('#editor-form [name="date"]', laterDate); await page.fill('#editor-form [name="departureTime"]', '19:45');
      await page.fill('#editor-form [name="pickupPoints"]', 'Văn phòng tạo mới'); await page.fill('#editor-form [name="dropoffPoints"]', 'Điểm trả tạo mới');
      await page.fill('#editor-form [name="provenance"]', 'Biên bản kiểm thử QA được xác nhận');
      const created = (await save(page, 'trips', 201)).trip;
      await filter(page, { operator: operator.id, date: laterDate }, 'trips');
      await page.locator(`[data-action="edit-trip"][data-id="${created.id}"]`).click();
      await page.fill('#editor-form [name="price"]', '280000');
      assert.equal((await save(page, 'trips/' + created.id)).trip.price, 280000);
      await page.locator(`[data-action="duplicate-trip"][data-id="${created.id}"]`).click();
      await page.fill('#editor-form [name="date"]', laterDate); await page.fill('#editor-form [name="departureTime"]', '20:45');
      const cloned = (await save(page, 'trips/' + created.id + '/duplicate', 201)).trip;
      assert.notEqual(cloned.id, created.id); assert.equal(cloned.source, 'managed'); assert.equal(cloned.price, 280000);
      await page.locator(`[data-action="delete-trip"][data-id="${cloned.id}"]`).click();
      const stopped = page.waitForResponse(response => response.url().endsWith('/api/admin/trips/' + cloned.id) && response.request().method() === 'DELETE');
      await page.click('#confirm-submit'); assert.equal((await stopped).status(), 200); await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
      assert.equal(Number((await runtime.api.db.get('SELECT active FROM trips WHERE id=?', [cloned.id])).active), 0);
      assert.equal((await fixtures.request.get(base + '/api/trips/' + cloned.id)).status(), 404, 'Stopped trips leave the public catalog');
      await filter(page, { date }, 'trips');
      await page.locator(`[data-action="edit-trip"][data-id="${trips[0].id}"]`).click();
      assert.ok(await page.locator('#editor-form [name="price"]').isDisabled(), 'A booked trip locks its fare in the editor');
      const protectedEdit = await fixtures.request.patch(base + '/api/admin/trips/' + trips[0].id, { data: { price: 260000 } });
      assert.equal((await json(protectedEdit, 409)).code, 'HAS_BOOKINGS');
      await page.fill('#editor-form [name="amenities"]', 'Điều hòa\nNước uống QA');
      const changed = (await save(page, 'trips/' + trips[0].id)).trip;
      assert.ok(changed.amenities.includes('Nước uống QA'), 'A booked trip permits safe descriptive changes');
      assert.equal(changed.price, 250000);
      assert.equal((await json(await fixtures.request.get(base + '/api/trips/' + trips[0].id))).price, 250000);
    });

    await check('manifest passenger and keyboard close', async page => {
      await login(page); await go(page, 'trips'); await filter(page, { operator: operator.id, date }, 'trips');
      await page.locator(`[data-action="manifest"][data-id="${trips[0].id}"]`).click();
      await page.locator('.manifest-table').waitFor();
      assert.match(await page.locator('#manifest-content').innerText(), /Hành khách QA 0/); assert.match(await page.locator('#manifest-content').innerText(), /A01/);
      assert.ok(await page.locator('[data-action="print-manifest"]').isEnabled());
      await screenshot(page, 'admin-manifest-desktop.png', false);
      await page.keyboard.press('Escape'); await page.locator('#manifest-dialog').waitFor({ state: 'hidden' });
    });

    await check('staff account create disable reenable change role invalidate sessions', async (page, context) => {
      await login(page); await go(page, 'users');
      await page.locator('[data-action="new-user"]').click();
      await page.fill('#editor-form [name="fullName"]', 'Nhân viên UI QA'); await page.fill('#editor-form [name="email"]', 'qa-ui-staff@example.test');
      await page.fill('#editor-form [name="phone"]', '0903333444'); await page.fill('#editor-form [name="password"]', 'Operator@12345');
      await page.selectOption('#editor-form [name="operatorId"]', operator.id);
      const user = (await save(page, 'users', 201)).user;
      const employee = await browser.newContext();
      try {
        await json(await employee.request.post(base + '/api/auth/login', { data: { email: user.email, password: 'Operator@12345' } }));
        await filter(page, { q: user.email, role: 'operator' }, 'users');
        assert.equal(await page.locator('[data-action="edit-user"]').count(), 1);
        await page.locator(`[data-action="edit-user"][data-id="${user.id}"]`).click();
        await page.uncheck('#editor-form [name="active"]'); assert.equal((await save(page, 'users/' + user.id)).user.active, false);
        assert.equal((await employee.request.get(base + '/api/admin/stats')).status(), 403, 'Disabling staff revokes the existing session');
        assert.equal((await json(await employee.request.get(base + '/api/auth/me'))).user, null);
        assert.equal((await employee.request.post(base + '/api/auth/login', { data: { email: user.email, password: 'Operator@12345' } })).status(), 401);
        await page.locator(`[data-action="edit-user"][data-id="${user.id}"]`).click(); await page.check('#editor-form [name="active"]');
        assert.equal((await save(page, 'users/' + user.id)).user.active, true);
        await json(await employee.request.post(base + '/api/auth/login', { data: { email: user.email, password: 'Operator@12345' } }));
        await page.locator(`[data-action="edit-user"][data-id="${user.id}"]`).click(); await page.selectOption('#editor-form [name="role"]', 'customer');
        assert.ok(await page.locator('#editor-form [name="operatorId"]').isHidden());
        const changed = (await save(page, 'users/' + user.id)).user; assert.equal(changed.role, 'customer'); assert.equal(changed.operatorId, null);
        assert.equal((await employee.request.get(base + '/api/admin/stats')).status(), 403, 'A role change invalidates staff sessions');
        assert.equal((await json(await employee.request.get(base + '/api/auth/me'))).user, null);
        await json(await employee.request.post(base + '/api/auth/login', { data: { email: user.email, password: 'Operator@12345' } }));
        assert.equal((await employee.request.get(base + '/api/admin/stats')).status(), 403, 'A customer cannot manage staff API');
      } finally { await employee.close(); }
      await filter(page, { q: user.email, role: 'customer' }, 'users');
      await screenshot(page, 'admin-users-desktop.png');
      const admin = (await json(await context.request.get(base + '/api/admin/users'))).users.find(item => item.role === 'admin');
      assert.equal((await context.request.patch(base + '/api/admin/users/' + admin.id, { data: { active: false } })).status(), 403, 'Portal cannot disable administrator credentials');
    });

    await check('operator create edit stop without deleting history', async page => {
      await login(page); await go(page, 'operators', '.operator-card');
      await page.locator('[data-action="new-operator"]').click();
      await page.fill('#editor-form [name="name"]', 'Nhà xe UI QA'); await page.fill('#editor-form [name="phone"]', '0904444555');
      await page.fill('#editor-form [name="email"]', 'qa-ui-operator@example.test');
      const created = (await save(page, 'operators', 201)).operator;
      await page.locator(`[data-action="edit-operator"][data-id="${created.id}"]`).click(); await page.fill('#editor-form [name="description"]', 'Đã cập nhật mô tả QA');
      assert.equal((await save(page, 'operators/' + created.id)).operator.description, 'Đã cập nhật mô tả QA');
      await page.locator(`[data-action="delete-operator"][data-id="${created.id}"]`).click();
      const stopped = page.waitForResponse(response => response.url().endsWith('/api/admin/operators/' + created.id) && response.request().method() === 'DELETE');
      await page.click('#confirm-submit'); assert.equal((await stopped).status(), 200); await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
      const operators = (await json(await fixtures.request.get(base + '/api/admin/operators'))).operators;
      assert.equal(operators.find(item => item.id === created.id).active, false);
    });

    await check('JSON CSV invalid imports are atomic and valid imports persist', async page => {
      const staleOperator = (await json(await fixtures.request.post(base + '/api/admin/operators', { data: { name: 'Nhà xe QA đổi trạng thái', phone: '0905555666' } }), 201)).operator;
      await login(page); await go(page, 'import', '#import-form');
      await page.fill('#import-form [name="sourceReference"]', 'Kho vé UI QA đã xác nhận');
      const before = Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM trips')).n);
      await page.fill('#import-form [name="schedule"]', JSON.stringify([tripBody(), tripBody({ price: -1 })]));
      await page.locator('[data-action="preview-import"]').click(); await page.locator('#import-preview.error').waitFor();
      assert.match(await page.locator('#import-preview').innerText(), /Chuyến 2/);
      await page.locator('#import-form [type="submit"]').click(); await finishRendering(page);
      assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM trips')).n), before);
      await page.fill('#import-form [name="schedule"]', JSON.stringify([tripBody(), tripBody({ date: '2026-02-30' })]));
      await page.locator('[data-action="preview-import"]').click(); await page.locator('#import-preview.error').waitFor();
      assert.match(await page.locator('#import-preview').innerText(), /ngày hợp lệ/);
      // Another administrator can deactivate a provider after this page loads its catalog.
      // Both rows pass the stale browser catalog; server revalidation must reject all rows.
      await json(await fixtures.request.delete(base + '/api/admin/operators/' + staleOperator.id));
      await page.fill('#import-form [name="schedule"]', JSON.stringify([tripBody(), tripBody({ operatorId: staleOperator.id })]));
      const invalid = page.waitForResponse(response => response.url().endsWith('/api/admin/import') && response.request().method() === 'POST');
      await page.locator('#import-form [type="submit"]').click(); assert.equal((await invalid).status(), 400);
      assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM trips')).n), before, 'One invalid server row rolls back the whole import');
      await page.fill('#import-form [name="schedule"]', 'operatorId,from,to,date,date\nqa,ho-chi-minh,da-lat,' + laterDate + ',' + laterDate);
      await page.locator('[data-action="preview-import"]').click(); assert.match(await page.locator('#import-preview').innerText(), /trùng/);
      await page.fill('#import-form [name="schedule"]', JSON.stringify([tripBody({ date: laterDate }), tripBody({ date: laterDate, departureTime: '21:30' })]));
      const imported = page.waitForResponse(response => response.url().endsWith('/api/admin/import') && response.request().method() === 'POST');
      await page.locator('#import-form [type="submit"]').click(); assert.equal((await json(await imported, 201)).imported, 2);
      await page.locator('#filters').waitFor(); assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM trips')).n), before + 2);
      await go(page, 'import', '#import-form');
      await page.fill('#import-form [name="sourceReference"]', 'Kho vé CSV UI QA xác nhận');
      const csv = 'operatorId,from,to,date,departureTime,durationMinutes,price,totalSeats,type,pickupPoints,dropoffPoints,amenities,policies\r\n' + `${operator.id},ho-chi-minh,da-lat,${laterDate},22:00,360,250000,9,limousine,"Văn phòng, QA|Điểm đón 2",Bến xe QA,Điều hòa,Có mặt sớm`;
      await page.fill('#import-form [name="schedule"]', csv); await page.locator('[data-action="preview-import"]').click();
      await page.locator('#import-preview:not(.error)').waitFor();
      const csvImport = page.waitForResponse(response => response.url().endsWith('/api/admin/import') && response.request().method() === 'POST');
      await page.locator('#import-form [type="submit"]').click(); assert.equal((await json(await csvImport, 201)).imported, 1);
      assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM trips')).n), before + 3);
    });

    await check('cash exact amount unique receipt and refund confirmation', async page => {
      await login(page); await go(page, 'bookings'); await filter(page, { q: booked[0].code }, 'bookings');
      await page.locator(`[data-action="cash-receipt"][data-id="${booked[0].code}"]`).click();
      await page.fill('#editor-form [name="reference"]', 'QA-CASH-UNIQUE-001');
      assert.equal(await page.locator('#editor-form [name="cashConfirmed"]').count(), 1, 'Receipt requires explicit full cash collection confirmation');
      await page.check('#editor-form [name="cashConfirmed"]');
      assert.equal((await save(page, 'bookings/' + booked[0].code + '/cash-receipt')).booking.paymentStatus, 'paid');
      assert.equal(Number((await runtime.api.db.get("SELECT amount FROM payments WHERE reference='cash:QA-CASH-UNIQUE-001'")).amount), booked[0].total);
      await filter(page, { q: booked[1].code }, 'bookings');
      await page.locator(`[data-action="cash-receipt"][data-id="${booked[1].code}"]`).click(); await page.fill('#editor-form [name="reference"]', 'QA-CASH-UNIQUE-001'); await page.check('#editor-form [name="cashConfirmed"]');
      assert.equal((await save(page, 'bookings/' + booked[1].code + '/cash-receipt', 409)).code, 'DUPLICATE_RECEIPT');
      assert.equal((await fixtures.request.post(base + '/api/admin/bookings/' + booked[1].code + '/cash-receipt', { data: { reference: 'QA-WRONG-AMOUNT', amount: 1 } })).status(), 400);
      assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM payments WHERE reference=?', ['cash:QA-WRONG-AMOUNT'])).n), 0, 'Rejected amount cannot insert a payment');
      await page.keyboard.press('Escape'); await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
      await filter(page, { q: booked[0].code }, 'bookings'); await page.locator(`[data-action="cancel-booking"][data-id="${booked[0].code}"]`).click();
      const cancelled = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings/' + booked[0].code) && response.request().method() === 'PATCH');
      await page.click('#confirm-submit'); assert.equal((await cancelled).status(), 200); await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
      await page.locator(`[data-action="refund-receipt"][data-id="${booked[0].code}"]`).click();
      assert.equal(await page.locator('#editor-form [name="amount"]').inputValue(), String(booked[0].total));
      assert.ok(await page.locator('#editor-form [name="amount"]').evaluate(element => element.readOnly));
      await page.fill('#editor-form [name="reference"]', 'QA-REFUND-UNIQUE-001'); await page.check('#editor-form [name="receiptConfirmed"]');
      assert.equal((await save(page, 'bookings/' + booked[0].code + '/refund-receipt')).booking.paymentStatus, 'refunded');
      const events = (await json(await fixtures.request.get(base + '/api/admin/bookings/' + booked[0].code + '/events'))).events;
      assert.ok(events.some(event => event.event === 'cash_received')); assert.ok(events.some(event => event.event === 'refund_recorded'));
    });

    await check('editor reusable after reschedule dismissed and stale history rejection', async page => {
      await login(page); await go(page, 'bookings'); await filter(page, { q: booked[1].code }, 'bookings');
      await page.locator(`[data-action="reschedule-booking"][data-id="${booked[1].code}"]`).click();
      await page.locator('#editor-dialog').waitFor({ state: 'visible' });
      assert.ok(await page.locator('#editor-form [type="submit"]').isDisabled());
      await page.keyboard.press('Escape'); await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
      await page.locator(`[data-action="cash-receipt"][data-id="${booked[1].code}"]`).click();
      assert.ok(await page.locator('#editor-form [type="submit"]').isEnabled(), 'The next editor does not inherit disabled reschedule state');
      assert.doesNotMatch(await page.locator('#editor-form [type="submit"]').innerText(), /đổi chuyến/);
      await page.keyboard.press('Escape'); await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
      await filter(page, { q: 'qa-passenger@example.test' }, 'bookings');
      let release, intercepted;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { intercepted = resolve; });
      await page.route('**/api/admin/bookings/' + booked[1].code + '/events', async route => {
        intercepted(); await gate; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Lỗi cũ không được ghi lên đơn mới' }) });
      });
      await page.locator(`[data-action="booking-detail"][data-id="${booked[1].code}"]`).click(); await started;
      await page.keyboard.press('Escape'); await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
      await page.locator(`[data-action="booking-detail"][data-id="${booked[2].code}"]`).click(); await page.locator('#audit-events article').first().waitFor();
      const stale = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings/' + booked[1].code + '/events'));
      release(); await stale; await finishRendering(page);
      assert.equal(await page.locator('#editor-title').innerText(), 'Đơn ' + booked[2].code);
      assert.doesNotMatch(await page.locator('#audit-events').innerText(), /Lỗi cũ/); assert.ok(await page.locator('#audit-events article').count() >= 1);
    });

    await check('counter sale refresh conflict and pending payment scope', async (page, context) => {
      await login(page); await go(page, 'trips'); await filter(page, { operator: operator.id, date }, 'trips');
      await page.locator(`[data-action="counter-booking"][data-id="${trips[0].id}"]`).click();
      await page.locator('.counter-seat[data-seat="A02"]:enabled').waitFor();
      for (const label of ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07']) await page.locator(`.counter-seat[data-seat="${label}"]`).click();
      assert.equal(await page.locator('.counter-seat.selected').count(), 6, 'Counter sales accept at most six passengers');
      assert.match(await page.locator('#counter-error').innerText(), /6 ghế/);
      for (const label of await page.locator('.counter-seat.selected').evaluateAll(elements => elements.map(element => element.dataset.seat))) await page.locator(`.counter-seat[data-seat="${label}"]`).click();
      await page.locator('.counter-seat[data-seat="A02"]').click(); await page.locator('.counter-seat[data-seat="A03"]').click();
      assert.match(await page.locator('#counter-selected').innerText(), /A02, A03/);
      const competitor = await browser.newContext();
      try {
        await json(await competitor.request.post(base + '/api/holds', { data: { tripId: trips[0].id, seats: ['A02'] } }), 201);
        await page.locator('#counter-refresh').click();
        await page.locator('.counter-seat[data-seat="A02"]:disabled').waitFor();
        assert.equal(await page.locator('#counter-selected').innerText(), 'A03', 'Refreshing removes seats held by a competing guest');
        assert.match(await page.locator('#counter-error').innerText(), /khách khác/);
        await page.fill('#counter-form [name="fullName"]', 'Hành khách tại quầy QA'); await page.fill('#counter-form [name="phone"]', '0907777888'); await page.fill('#counter-form [name="email"]', 'qa-counter@example.test');
        assert.ok(await page.locator('#counter-form [name="email"]').evaluate(element => !element.required), 'A counter passenger can receive a ticket by phone without an email address');
        assert.match(await page.locator('#counter-total').innerText(), /250\.000/);
        await screenshot(page, 'admin-counter-desktop.png', false);
        let release, started;
        const gate = new Promise(resolve => { release = resolve; });
        const intercepted = new Promise(resolve => { started = resolve; });
        await page.route('**/api/admin/bookings', async route => { if (route.request().method() !== 'POST') return route.continue(); started(); await gate; await route.continue(); });
        const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings') && response.request().method() === 'POST');
        try {
          await page.locator('#counter-submit').click(); await intercepted;
          assert.ok(await page.locator('#counter-submit').isDisabled());
          await page.keyboard.press('Escape'); assert.ok(await page.locator('#counter-dialog').isVisible(), 'An in-flight sale stays visible until server response');
        } finally { release(); }
        const booking = (await json(await saved, 201)).booking;
        await page.locator('#counter-dialog').waitFor({ state: 'hidden' });
        assert.deepEqual(booking.seats, ['A03']); assert.equal(booking.total, 250000); assert.equal(booking.userId, null);
        assert.equal(booking.status, 'reserved'); assert.equal(booking.paymentStatus, 'pending'); assert.equal(booking.paymentMethod, 'cash');
        assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM payments WHERE booking_code=?', [booking.code])).n), 0, 'Creating a counter sale must not mark cash as received');
        await page.locator(`[data-action="booking-detail"][data-id="${booking.code}"]`).waitFor();
      } finally { await competitor.close(); }
      const employee = await browser.newContext();
      try {
        await json(await employee.request.post(base + '/api/auth/login', { data: { email: staff.email, password: 'Operator@12345' } }));
        const foreign = bootstrap.operators.find(item => item.id !== operator.id);
        const foreignTrips = (await json(await context.request.get(base + '/api/admin/trips?operator=' + foreign.id + '&date=' + date))).trips;
        assert.ok(foreignTrips.length);
        const target = foreignTrips[0];
        assert.equal((await employee.request.post(base + '/api/admin/bookings', { data: { tripId: target.id, seats: ['A01'], fullName: 'Không có quyền', phone: '0907777888', email: 'qa-counter@example.test', pickup: target.pickupPoints[0], dropoff: target.dropoffPoints[0], paymentMethod: 'cash' } })).status(), 403);
      } finally { await employee.close(); }
    });

    await check('counter final seat race refreshes unavailable seats', async page => {
      await login(page); await go(page, 'trips'); await filter(page, { operator: operator.id, date }, 'trips');
      await page.locator(`[data-action="counter-booking"][data-id="${trips[2].id}"]`).click();
      await page.locator('.counter-seat[data-seat="A02"]:enabled').waitFor(); await page.locator('.counter-seat[data-seat="A02"]').click();
      await page.fill('#counter-form [name="fullName"]', 'Hành khách xung đột QA'); await page.fill('#counter-form [name="phone"]', '0907777888'); await page.fill('#counter-form [name="email"]', 'qa-conflict@example.test');
      const competitor = await browser.newContext();
      try {
        await json(await competitor.request.post(base + '/api/holds', { data: { tripId: trips[2].id, seats: ['A02'] } }), 201);
        const rejected = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings') && response.request().method() === 'POST');
        await page.locator('#counter-submit').click(); assert.equal((await rejected).status(), 409);
        await page.locator('.counter-seat[data-seat="A02"]:disabled').waitFor();
        assert.equal(await page.locator('#counter-selected').innerText(), 'Chưa chọn ghế'); assert.ok(await page.locator('#counter-submit').isDisabled());
        assert.match(await page.locator('#counter-error').innerText(), /ghế|Ghế/);
        assert.equal(Number((await runtime.api.db.get("SELECT COUNT(*) AS n FROM bookings WHERE email='qa-conflict@example.test'")).n), 0);
      } finally { await competitor.close(); }
    });

    await check('counter inventory retry and revoked staff session clear passenger data', async page => {
      const user = (await json(await fixtures.request.post(base + '/api/admin/users', { data: { fullName: 'Nhân viên QA hết quyền', email: 'qa-revoked-counter@example.test', phone: '0909999000', password: 'Operator@12345', role: 'operator', operatorId: operator.id } }), 201)).user;
      await login(page, user.email, 'Operator@12345'); await go(page, 'trips'); await filter(page, { date }, 'trips');
      let initial = true;
      await page.route('**/api/trips/' + trips[3].id, async route => {
        if (!initial) return route.continue();
        initial = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Kho vé QA tạm thời không sẵn sàng' }) });
      });
      await page.locator(`[data-action="counter-booking"][data-id="${trips[3].id}"]`).click();
      await page.locator('#counter-error').filter({ hasText: 'Kho vé QA tạm thời không sẵn sàng' }).waitFor();
      assert.doesNotMatch(await page.locator('#counter-seats').innerText(), /Đang tải/);
      assert.ok(await page.locator('#counter-refresh').isEnabled(), 'An inventory failure leaves retry available');
      await page.locator('#counter-refresh').click(); await page.locator('.counter-seat[data-seat="A01"]:enabled').waitFor();
      await page.locator('.counter-seat[data-seat="A01"]').click();
      await page.fill('#counter-form [name="fullName"]', 'Khách cần xóa khỏi phiên'); await page.fill('#counter-form [name="phone"]', '0908888999'); await page.fill('#counter-form [name="email"]', 'qa-revoked-passenger@example.test');
      await json(await fixtures.request.patch(base + '/api/admin/users/' + user.id, { data: { active: false } }));
      const rejected = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings') && response.request().method() === 'POST');
      await page.locator('#counter-submit').click(); assert.equal((await rejected).status(), 403);
      await page.locator('#login-screen').waitFor({ state: 'visible' }); await page.locator('#counter-dialog').waitFor({ state: 'hidden' });
      assert.ok(await page.locator('#portal').isHidden());
      assert.ok(await page.evaluate(() => ['fullName', 'phone', 'email'].every(name => !document.querySelector(`#counter-form [name="${name}"]`)?.value)), 'A revoked staff session clears passenger inputs');
      assert.equal(Number((await runtime.api.db.get("SELECT COUNT(*) AS n FROM bookings WHERE email='qa-revoked-passenger@example.test'")).n), 0);
    });

    await check('dashboard date range and audit filters are scoped', async (page, context) => {
      await login(page);
      assert.equal(await page.locator('#filters [name="dateFrom"]').count(), 1); assert.equal(await page.locator('#filters [name="dateTo"]').count(), 1);
      const stats = await filter(page, { dateFrom: bootstrap.today, dateTo: laterDate }, 'stats');
      assert.ok(stats.analytics); assert.ok(stats.stats.grossRevenue >= stats.stats.revenue);
      await go(page, 'audit');
      const audit = await filter(page, { entityType: 'trip', operator: operator.id }, 'audit');
      assert.ok(audit.total >= 18); assert.ok(audit.events.every(event => event.entityType === 'trip' && event.operatorId === operator.id));
      await screenshot(page, 'admin-audit-desktop.png');
      await filter(page, { q: 'khong-co-nhat-ky-qa' }, 'audit');
      assert.equal(await page.locator('#content .data-table tbody tr:has([data-action])').count(), 0);
      assert.equal((await context.request.get(base + '/api/admin/stats?dateFrom=2026-02-30')).status(), 400);
    });

    await check('mobile layout navigation keyboard and dialogs fit', async page => {
      await login(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Dashboard has no horizontal overflow');
      await screenshot(page, 'admin-dashboard-mobile.png');
      await page.locator('#menu-button').click(); assert.equal(await page.locator('#menu-button').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#menu-button').getAttribute('aria-expanded'), 'false');
      await page.locator('#menu-button').click(); await go(page, 'trips'); assert.equal(await page.locator('#menu-button').getAttribute('aria-expanded'), 'false');
      await filter(page, { operator: operator.id, date }, 'trips');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Trip table scrolls within its panel');
      await screenshot(page, 'admin-trips-mobile.png');
      await page.locator('[data-action="new-trip"]').click();
      assert.ok(await page.evaluate(() => { const bounds = document.querySelector('#editor-dialog').getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth + 1; }), 'Editor fits mobile width');
      assert.equal(await page.locator('#editor-dialog').getAttribute('aria-labelledby'), 'editor-title');
      await screenshot(page, 'admin-editor-mobile.png', false);
      await page.keyboard.press('Escape'); await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
      await page.locator('[data-action="counter-booking"]:enabled').first().click();
      await page.locator('.counter-seat').first().waitFor();
      assert.ok(await page.evaluate(() => { const bounds = document.querySelector('#counter-dialog').getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth + 1; }), 'Counter sale dialog fits mobile width');
      assert.ok(await page.locator('#counter-dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Counter fields do not overflow horizontally');
      await screenshot(page, 'admin-counter-mobile.png', false);
      await page.locator('#counter-dialog').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.fill('#counter-form [name="fullName"]', 'Hành khách quầy trên điện thoại');
      await page.fill('#counter-form [name="phone"]', '0907777888');
      assert.ok(await page.evaluate(() => {
        const dialog = document.querySelector('#counter-dialog').getBoundingClientRect();
        const footer = document.querySelector('#counter-dialog .dialog-footer').getBoundingClientRect();
        return ['fullName', 'phone'].every(name => { const bounds = document.querySelector(`#counter-form [name="${name}"]`).getBoundingClientRect(); return bounds.top >= dialog.top && bounds.bottom <= footer.top; });
      }), 'Mobile contact inputs remain visible above the fixed action footer');
      await screenshot(page, 'admin-counter-mobile-passenger.png', false);
      await page.keyboard.press('Escape'); await page.locator('#counter-dialog').waitFor({ state: 'hidden' });
      await page.locator('#menu-button').click(); await go(page, 'audit');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Audit table fits mobile viewport');
      await screenshot(page, 'admin-audit-mobile.png');
    }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    assert.deepEqual(browserErrors, [], 'No uncaught browser errors, CSP failures, or missing assets');
    assert.deepEqual(failures, [], 'All admin regression scenarios passed');
    console.log(`Admin UI passed: ${passed} scenarios; permissions, trip lifecycle, staff sessions, atomic imports, cash/refund ledger, modal races, audit filters and desktop/mobile layouts.`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    if (fixtures) await fixtures.close();
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (runtime) await runtime.close();
    const target = path.resolve(dataDir), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(target.startsWith(temporaryRoot) && path.basename(target).startsWith('ticket4t-admin-ui-'), 'Cleanup target must be this test directory in OS temporary storage');
    await fs.rm(target, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
