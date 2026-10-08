'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createApp } = require('../index');
const { addDays } = require('../server/catalog');

// Every write is confined to the fixture database in this temporary directory.
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket4t-browser-regression-'));
  const runtime = await createApp({
    env: { NODE_ENV: 'development', SEED_DEMO: 'true', SESSION_SECRET: 'regression-tests-only-'.repeat(4) },
    dataDir, seedDays: 6, disableRateLimit: true
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const output = path.resolve('artifacts/screenshots');
  await fs.mkdir(output, { recursive: true });
  const outDate = addDays(bootstrap.today, 1), backDate = addDays(bootstrap.today, 2), laterDate = addDays(bootstrap.today, 3);
  const outbound = { from: 'ho-chi-minh', to: 'da-lat', date: outDate };
  const failures = [], browserErrors = [];
  let passed = 0;

  function route(values) { return base + '/#/search?' + new URLSearchParams(values); }
  async function search(page, values = outbound) {
    await page.goto(route(values));
    await page.locator('#sort-select').waitFor();
    await page.locator('.trip-card').first().waitFor();
  }
  async function choose(page, count = 1) {
    await page.locator('.trip-card .btn').first().click();
    await page.locator('[data-action="seat"]:enabled').first().waitFor();
    const labels = await page.locator('[data-action="seat"]:enabled').evaluateAll((elements, passengerCount) => elements.slice(0, passengerCount).map(element => element.dataset.label), count);
    for (const label of labels) await page.locator(`[data-action="seat"][data-label="${label}"]`).click();
    await page.locator('[data-action="checkout"]').click();
    return labels;
  }
  async function newPage(context) {
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to|Uncaught/i.test(message.text())) browserErrors.push(message.text()); });
    page.on('response', response => { if (response.status() === 404 && !response.url().includes('/api/') && !response.url().endsWith('/favicon.ico')) browserErrors.push('Missing asset: ' + response.url()); });
    return page;
  }
  async function check(name, callback) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      await callback(await newPage(context), context);
      passed++;
      console.log('PASS ' + name);
    } catch (error) {
      failures.push(name + ': ' + error.message);
      console.error('FAIL ' + name + ': ' + error.stack);
    } finally {
      await context.close();
      // Expired browser sessions must not reserve inventory needed by the next test.
      await runtime.api.db.transaction(async tx => {
        await tx.run('DELETE FROM hold_seats');
        await tx.run('DELETE FROM seat_holds');
      });
    }
  }

  try {
    await check('search validation and swapping places', async page => {
      await page.goto(base);
      await page.locator('#search-form').waitFor();
      await page.fill('#search-date', outDate);
      await page.selectOption('#search-to', 'ho-chi-minh');
      await page.locator('#search-form button[type="submit"]').click();
      await page.locator('#toast-region .toast.error').waitFor();
      assert.equal(new URL(page.url()).hash, '', 'Invalid identical places must not start a search');
      await page.selectOption('#search-to', 'da-lat');
      await page.locator('[data-action="swap"]').click();
      assert.equal(await page.locator('#search-from').inputValue(), 'da-lat');
      assert.equal(await page.locator('#search-to').inputValue(), 'ho-chi-minh');
      await page.locator('#search-form button[type="submit"]').click();
      await page.locator('.trip-card').first().waitFor();
      assert.match(page.url(), /from=da-lat/);
      const sameSearchUrl = page.url();
      const refreshed = page.waitForResponse(response => {
        if (!response.url().includes('/api/trips?')) return false;
        const query = new URL(response.url()).searchParams;
        return query.get('from') === 'da-lat' && query.get('to') === 'ho-chi-minh' && query.get('date') === outDate;
      });
      await page.locator('#search-form button[type="submit"]').click();
      assert.ok((await (await refreshed).json()).trips.length > 0, 'Submitting the current search refreshes results');
      await page.locator('.trip-card').first().waitFor();
      assert.equal(page.url(), sameSearchUrl, 'Refreshing the same search preserves its URL');
      assert.ok(await page.locator('#search-form button[type="submit"]').isEnabled(), 'The current search remains usable after submission');
    });

    await check('location search supports aliases, accents and keyboard dismissal', async page => {
      await page.goto(base);
      await page.locator('#search-form').waitFor();
      await page.locator('[data-action="location-picker"][data-target="search-from"]').click();
      await page.locator('#location-dialog').waitFor({ state: 'visible' });
      await page.fill('#location-query', 'SG');
      await page.locator('[data-action="choose-location"][data-location="ho-chi-minh"]').waitFor();
      assert.equal(await page.locator('[data-action="choose-location"]').count(), 1);
      await page.screenshot({ path: path.join(output, 'location-picker-desktop.png') });
      await page.locator('[data-action="choose-location"][data-location="ho-chi-minh"]').click();
      await page.locator('#location-dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#search-from').inputValue(), 'ho-chi-minh');
      await page.locator('[data-action="location-picker"][data-target="search-to"]').click();
      await page.fill('#location-query', 'da lat');
      await page.locator('[data-action="choose-location"][data-location="da-lat"]').waitFor();
      await page.locator('[data-action="choose-location"][data-location="da-lat"]').click();
      await page.locator('#location-dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#search-to').inputValue(), 'da-lat');
      await page.locator('[data-action="location-picker"][data-target="search-to"]').click();
      await page.fill('#location-query', 'dia diem khong ton tai');
      await page.locator('.location-empty').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('#location-dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#search-to').inputValue(), 'da-lat', 'Closing a picker preserves the selected destination');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[data-action="location-picker"][data-target="search-to"]').click();
      await page.fill('#location-query', 'da lat');
      await page.locator('[data-action="choose-location"][data-location="da-lat"]').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The mobile location picker fits its viewport');
      await page.screenshot({ path: path.join(output, 'location-picker-mobile.png') });
      await page.keyboard.press('Escape');
      await page.locator('#location-dialog').waitFor({ state: 'hidden' });
    });

    await check('sorts and combined filters preserve route state', async page => {
      await search(page);
      const sorted = page.waitForResponse(response => response.url().includes('/api/trips?') && new URL(response.url()).searchParams.get('sort') === 'price');
      await page.selectOption('#sort-select', 'price');
      const sortedData = await (await sorted).json();
      await page.locator('.trip-card').first().waitFor();
      assert.deepEqual(sortedData.trips.map(trip => trip.price), [...sortedData.trips.map(trip => trip.price)].sort((a, b) => a - b));
      const filtered = page.waitForResponse(response => response.url().includes('/api/trips?') && new URL(response.url()).searchParams.get('time') === 'morning');
      await page.check('#filter-form [name="time"][value="morning"]');
      const filteredData = await (await filtered).json();
      assert.ok(filteredData.trips.length > 0);
      assert.ok(filteredData.trips.every(trip => trip.departureTime >= '06:00' && trip.departureTime < '12:00'));
      await page.locator('#filter-dropoff').waitFor();
      await page.fill('#filter-dropoff', 'Địa điểm không tồn tại');
      const empty = page.waitForResponse(response => response.url().includes('/api/trips?') && new URL(response.url()).searchParams.get('dropoff') === 'Địa điểm không tồn tại');
      await page.locator('#filter-form button[type="submit"]').click();
      assert.equal((await (await empty).json()).total, 0);
      await page.locator('#search-results .empty').waitFor();
      await page.locator('[data-action="clear-filters"]').first().click();
      await page.locator('.trip-card').first().waitFor();
      const query = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
      assert.equal(query.get('from'), outbound.from);
      assert.equal(query.get('date'), outDate);
      for (const key of ['time', 'type', 'operator', 'pickup', 'dropoff', 'q', 'minPrice', 'maxPrice']) assert.ok(!query.get(key), 'Cleared filter: ' + key);
    });

    await check('seat selection limit, deselection and changed availability', async (page, context) => {
      await search(page);
      await page.locator('.trip-card .btn').first().click();
      await page.locator('[data-action="seat"]:enabled').first().waitFor();
      const labels = await page.locator('[data-action="seat"]:enabled').evaluateAll(elements => elements.slice(0, 7).map(element => element.dataset.label));
      assert.equal(labels.length, 7);
      for (const label of labels) await page.locator(`[data-label="${label}"]`).click();
      assert.equal(await page.locator('.seat.selected').count(), 6, 'At most six passengers can be selected');
      await page.locator(`[data-label="${labels[0]}"]`).click();
      assert.equal(await page.locator('.seat.selected').count(), 5);
      const tripId = decodeURIComponent(new URL(page.url()).hash.split('?')[0].split('/').pop());
      const competitor = await browser.newContext();
      try {
        await competitor.request.get(base + '/api/bootstrap');
        const held = await competitor.request.post(base + '/api/holds', { data: { tripId, seats: [labels[1]] } });
        assert.equal(held.status(), 201, await held.text());
        await page.locator('[data-action="refresh-seats"]').click();
        await page.waitForFunction(label => document.querySelector(`[data-label="${label}"]`)?.disabled, labels[1]);
        assert.equal(await page.locator('.seat.selected').count(), 4, 'A seat held by another guest is removed from the selection');
      } finally { await competitor.close(); }
      assert.ok(await page.locator('[data-action="checkout"]').isEnabled());
    });

    await check('return date changes through form and date tabs', async page => {
      await search(page, { ...outbound, mode: 'roundtrip', returnDate: backDate, leg: 'outbound' });
      await choose(page, 2);
      await page.waitForURL(/leg=return/);
      await page.locator('.trip-card').first().waitFor();
      await page.fill('#search-date', laterDate);
      await page.locator('#search-form button[type="submit"]').click();
      await page.waitForURL(url => new URLSearchParams(url.hash.split('?')[1]).get('date') === laterDate);
      await page.locator('.trip-card').first().waitFor();
      let query = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
      assert.equal(query.get('returnDate'), laterDate);
      assert.equal(query.get('leg'), 'return');
      assert.match(await page.locator('.journey-status').innerText(), /Chiều đi/);
      await page.locator(`[data-action="change-date"][data-date="${backDate}"]`).click();
      await page.waitForURL(url => new URLSearchParams(url.hash.split('?')[1]).get('date') === backDate);
      await page.locator('.trip-card').first().waitFor();
      query = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
      assert.equal(query.get('returnDate'), backDate, 'Date tabs also update the round-trip context');
      await choose(page, 2);
      await page.locator('#checkout-form').waitFor();
      assert.equal(await page.locator('#return-pickup').count(), 1);
      assert.equal(await page.locator('#return-dropoff').count(), 1);
      await page.locator('.breadcrumb a[href*="#/trip/"]').click();
      await page.locator('[data-action="seat"]:enabled').first().waitFor();
      const backQuery = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
      assert.equal(backQuery.get('mode'), 'roundtrip', 'Going back to the seat map preserves the round-trip workflow');
      assert.equal(await page.locator('.seat.selected').count(), 2, 'Previously held seats remain selected');
      await page.locator('[data-action="checkout"]').click();
      await page.waitForURL(/leg=return/);
      await page.locator('.trip-card').first().waitFor();
      await choose(page, 2);
      await page.locator('#checkout-form').waitFor();
      assert.equal(await page.locator('#return-pickup').count(), 1, 'Editing outbound seats does not turn a round-trip into a one-way booking');
    });

    await check('stale checkout cannot treat another guest hold as its own', async page => {
      await search(page);
      const seats = await choose(page);
      await page.locator('#checkout-form').waitFor();
      const tripId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ticket4t_checkout')).legs[0].tripId);
      await runtime.api.db.transaction(tx => tx.run('UPDATE seat_holds SET expires_at=?', [new Date(Date.now() - 60000).toISOString()]));
      const competitor = await browser.newContext();
      try {
        await competitor.request.get(base + '/api/bootstrap');
        const response = await competitor.request.post(base + '/api/holds', { data: { tripId, seats } });
        assert.equal(response.status(), 201, await response.text());
        await page.reload();
        await page.waitForFunction(() => !document.querySelector('#main .loading-panel'));
        assert.equal(await page.locator('#checkout-form').count(), 0, 'A cached future expiry cannot authorize seats now held by a different guest');
        assert.match(await page.locator('#main').innerText(), /chỗ.*thay đổi|chọn.*chỗ|chọn.*lại/i);
      } finally { await competitor.close(); }
    });

    await check('coupon response cannot restore a changed coupon', async page => {
      await search(page);
      await choose(page, 2);
      await page.locator('#checkout-form').waitFor();
      await page.fill('#phone', '0912222333');
      const originalTotal = await page.locator('[data-checkout-total]').innerText();
      let release, intercepted;
      const pending = new Promise(resolve => { intercepted = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/promotions/quote', async interceptedRoute => { intercepted(); await gate; await interceptedRoute.continue(); });
      await page.fill('#coupon-code', 'TEST50K');
      await page.locator('[data-action="apply-coupon"]').click();
      await pending;
      await page.fill('#coupon-code', '');
      const response = page.waitForResponse(item => item.url().endsWith('/api/promotions/quote'));
      release();
      await response;
      await page.waitForFunction(() => !document.querySelector('[data-action="apply-coupon"]').disabled);
      assert.equal(await page.locator('[data-checkout-total]').innerText(), originalTotal, 'The stale quote must not change the displayed total');
      assert.equal(await page.locator('.coupon-success').count(), 0, 'The response for the removed code must not become a successful quote');
      await page.unroute('**/api/promotions/quote');
      await page.fill('#coupon-code', 'TEST50K');
      await page.locator('[data-action="apply-coupon"]').click();
      await page.locator('#coupon-feedback.coupon-success').waitFor();
      assert.notEqual(await page.locator('[data-checkout-total]').innerText(), originalTotal);
      await page.fill('#phone', '0912222444');
      assert.equal(await page.locator('[data-checkout-total]').innerText(), originalTotal, 'Changing the customer invalidates the applicable quote');
    });

    await check('malformed persisted state recovers without a blank screen', async page => {
      await page.goto(base);
      await page.locator('#search-form').waitFor();
      await page.evaluate(() => {
        localStorage.setItem('ticket4t_favorites', JSON.stringify({ unexpected: true }));
        localStorage.setItem('ticket4t_compare', JSON.stringify('invalid list'));
        sessionStorage.setItem('ticket4t_checkout', JSON.stringify({ legs: 'invalid legs' }));
        sessionStorage.setItem('ticket4t_journey', JSON.stringify({ legs: 'invalid legs' }));
      });
      await page.reload();
      await page.locator('#search-form').waitFor();
      await page.goto(base + '/#/favorites');
      await page.locator('#main h1').waitFor();
      assert.doesNotMatch(await page.locator('#main').innerText(), /Hành trình tạm gián đoạn/);
      await search(page);
      await page.locator('[data-action="favorite"]').first().click();
      await page.goto(base + '/#/favorites');
      await page.locator('.trip-card').waitFor();
      assert.equal(await page.locator('.trip-card').count(), 1);
      await page.goto(base + '/#/compare');
      await page.locator('#main h1').waitFor();
      assert.doesNotMatch(await page.locator('#main').innerText(), /Hành trình tạm gián đoạn/);
    });

    await check('closed trip cannot start a seat reservation', async page => {
      await search(page);
      await page.route('**/api/trips/*', async interceptedRoute => {
        const response = await interceptedRoute.fetch();
        const data = await response.json();
        const trip = data.trip || data;
        trip.bookingOpen = false;
        await interceptedRoute.fulfill({ response, json: data });
      });
      await page.locator('.trip-card .btn').first().click();
      await page.locator('#seat-summary').waitFor();
      assert.equal(await page.locator('[data-action="seat"]:enabled').count(), 0, 'Closed departures expose no selectable seats');
      assert.equal(await page.locator('[data-action="checkout"]:enabled').count(), 0, 'Closed departures expose no booking CTA');
    });

    await check('SVG icons, mobile menu and mobile filters', async page => {
      await page.goto(base);
      await page.locator('#search-form').waitFor();
      assert.ok(await page.locator('svg.ticket-icon[data-icon-name]').count() >= 15, 'Shared SVG icons render across the home page');
      const invalidIcons = await page.locator('svg.ticket-icon').evaluateAll(elements => elements.filter(element => element.getAttribute('aria-hidden') !== 'true' || !element.querySelector('path,rect,circle,ellipse,line,polyline,polygon,use')).length);
      assert.equal(invalidIcons, 0, 'Decorative icons have geometry and remain hidden from screen readers');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[data-action="menu"]').click();
      assert.equal(await page.locator('[data-action="menu"]').getAttribute('aria-expanded'), 'true');
      await page.locator('#main-nav a[href="#/support"]').click();
      await page.locator('#main h1').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile support fits its viewport');
      await search(page);
      await page.locator('[data-action="filters"]').click();
      assert.equal(await page.locator('[data-action="filters"]').getAttribute('aria-expanded'), 'true');
      assert.ok(await page.locator('#filter-form').isVisible());
      await page.locator('[data-action="filters"]').click();
      assert.equal(await page.locator('[data-action="filters"]').getAttribute('aria-expanded'), 'false');
      assert.ok(!(await page.locator('#filter-form').isVisible()));
      assert.ok(await page.locator('.trip-features svg.ticket-icon').count() > 0, 'Trip amenities use the SVG icon system');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile results fit their viewport');
    });

    await check('lookup checks phone and normalizes booking code', async page => {
      await search(page, { ...outbound, date: laterDate });
      await choose(page);
      await page.locator('#checkout-form').waitFor();
      await page.fill('#fullName', 'Khách tra cứu hồi quy');
      await page.fill('#phone', '0912222555');
      await page.fill('#email', 'regression@example.test');
      await page.check('#checkout-form [name="consent"]');
      const response = page.waitForResponse(item => item.url().endsWith('/api/bookings') && item.request().method() === 'POST');
      await page.locator('#book-button').click();
      const created = await (await response).json();
      assert.ok(created.booking?.code, JSON.stringify(created));
      await page.locator('[data-action="print"]').waitFor();
      await page.goto(base + '/#/tickets');
      await page.locator('#lookup-form').waitFor();
      await page.fill('#lookup-code', created.booking.code.toLowerCase());
      await page.fill('#lookup-phone', '0912222666');
      await page.locator('#lookup-form button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('#lookup-error')?.textContent.trim());
      assert.equal(await page.locator('.receipt-code').count(), 0, 'A wrong phone reveals no itinerary');
      await page.fill('#lookup-phone', '0912222555');
      await page.locator('#lookup-form button[type="submit"]').click();
      await page.locator('.receipt-code').waitFor();
      assert.equal((await page.locator('.receipt-code').innerText()).trim(), created.booking.code);
    });

    assert.deepEqual(browserErrors, [], 'No missing assets, browser errors or blocked scripts');
    assert.deepEqual(failures, [], 'All UI regressions pass');
    console.log('Regression UI passed: ' + passed + ' scenarios.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await runtime.close();
    const cleanupTarget = path.resolve(dataDir), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!cleanupTarget.startsWith(tempRoot) || !path.basename(cleanupTarget).startsWith('ticket4t-browser-regression-')) throw new Error('Invalid temporary cleanup path.');
    await fs.rm(cleanupTarget, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
