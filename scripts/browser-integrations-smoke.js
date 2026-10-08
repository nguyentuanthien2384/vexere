'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const {createApp} = require('../index');
const {addDays} = require('../server/catalog');

// The mock partner and all writes use an isolated temporary database.
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'ticket4t-integrations-ui-'));
  const output = path.resolve('artifacts/screenshots');
  await fs.mkdir(output,{recursive:true});
  const failures = [],browserErrors = [];
  let runtime,server,feedServer,browser,context,fixtures,base,feed,operatorId,importedId,passed = 0;
  const token = 'isolated-browser-feed-secret';
  const env = {NODE_ENV:'test',SEED_DEMO:'true',SESSION_SECRET:'isolated-integrations-ui-tests-'.repeat(3)};

  async function json(response,status = 200) {
    const data = await response.json();
    assert.equal(response.status(),status,JSON.stringify(data));
    return data;
  }
  async function login(page,email = 'admin@ticket4t.vn',password = 'Admin@12345') {
    await page.goto(base+'/admin');
    await page.locator('#login-form').waitFor({state:'visible'});
    await page.fill('#login-form [name="email"]',email);
    await page.fill('#login-form [name="password"]',password);
    await page.locator('#login-form [type="submit"]').click();
    await page.locator('#portal').waitFor({state:'visible'});
    await page.locator('.stats-grid').first().waitFor();
  }
  function instrument(page) {
    page.setDefaultTimeout(12000);
    page.on('pageerror',error => browserErrors.push(error.message));
    page.on('console',message => {if (message.type() === 'error' && /Content Security Policy|Refused to|Uncaught/i.test(message.text())) browserErrors.push(message.text());});
    page.on('response',response => {if (response.status() === 404 && !response.url().includes('/api/') && !response.url().endsWith('/favicon.ico')) browserErrors.push('Missing asset: '+response.url());});
  }
  async function screenshot(page,name) {
    await page.waitForFunction(() => !document.querySelector('#toast-stack .toast'));
    await page.evaluate(() => {window.scrollTo(0,0);});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({path:path.join(output,name),fullPage:true,animations:'disabled'});
  }
  async function check(name,work,page) {
    try {await work();passed++;console.log('PASS '+name);}
    catch (error) {
      failures.push(name+': '+error.message);
      console.error('FAIL '+name+': '+error.stack);
      if (page) await screenshot(page,'integrations-failure-'+name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()+'.png').catch(() => {});
    }
  }
  async function preview(page) {
    const loaded = page.waitForResponse(response => response.url().endsWith('/api/admin/integrations/operator-feed/preview') && response.request().method() === 'POST');
    await page.locator('[data-action="preview-feed"]').click();
    const data = await json(await loaded);
    await page.locator('#feed-preview tbody tr').first().waitFor();
    return data.preview;
  }
  async function apply(page,status = 200) {
    const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/integrations/operator-feed/apply') && response.request().method() === 'POST');
    await page.locator('[data-action="apply-feed"]').click();
    const data = await json(await saved,status);
    if (status === 200) await page.locator('#feed-preview tbody tr').waitFor({state:'hidden'});
    return data;
  }
  async function tripCount() {return Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM trips WHERE operator_id=?',[operatorId])).n);}

  try {
    feedServer = http.createServer((req,res) => {
      res.setHeader('Content-Type','application/json');
      if (req.headers.authorization !== 'Bearer '+token) {res.writeHead(401);res.end('{"error":"unauthorized"}');return;}
      res.end(JSON.stringify(feed));
    });
    await new Promise(resolve => feedServer.listen(0,'127.0.0.1',resolve));
    runtime = await createApp({env,dataDir,seedDays:2,disableRateLimit:true});
    server = runtime.app.listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    base = 'http://127.0.0.1:'+server.address().port;
    browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
    fixtures = await browser.newContext();
    await json(await fixtures.request.post(base+'/api/auth/login',{data:{email:'admin@ticket4t.vn',password:'Admin@12345'}}));
    const operator = (await json(await fixtures.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe API kiểm thử trình duyệt',phone:'0901234567',email:'browser-partner@example.test'}}),201)).operator;
    operatorId = operator.id;
    await json(await fixtures.request.post(base+'/api/admin/users',{data:{fullName:'Nhân viên API kiểm thử',email:'browser-feed-staff@example.test',phone:'0901234567',password:'FeedStaff@12345',role:'operator',operatorId}}),201);
    const bootstrap = await json(await fixtures.request.get(base+'/api/bootstrap'));
    feed = {version:1,sourceReference:'Hợp đồng cấp riêng kho ghế kiểm thử UI',trips:[{externalId:'UI-FEED-001',from:'ho-chi-minh',to:'da-lat',date:addDays(bootstrap.today,2),departureTime:'18:00',type:'limousine',price:250000,totalSeats:9,durationMinutes:360,pickupPoints:['Văn phòng đối tác kiểm thử'],dropoffPoints:['Bến xe Đà Lạt kiểm thử'],amenities:['Điều hòa']} ]};
    context = await browser.newContext({viewport:{width:1440,height:1000}});
    const page = await context.newPage();
    instrument(page);
    await login(page);
    await page.locator('#sidebar [data-page="integrations"]').click();
    await page.locator('.integration-grid').waitFor();

    await check('missing credentials disable partner import and show gateway diagnostics',async () => {
      assert.equal(await page.locator('#page-title').innerText(),'Kết nối API');
      assert.ok(await page.locator('[data-action="preview-feed"]').isDisabled());
      for (const text of ['VNPAY','MoMo','ZaloPay','Email giao dịch','Cơ sở dữ liệu']) assert.ok(await page.locator('.integration-card').filter({hasText:text}).count());
      assert.match(await page.locator('#content').innerText(),/OPERATOR_FEED_URL/);
      assert.match(await page.locator('#content').innerText(),/hộp thư phát triển/);
      const status = await json(await context.request.get(base+'/api/admin/integrations'));
      assert.equal(status.inventory.providerSync.configured,false);
      assert.ok(!JSON.stringify(status).includes(token));
    },page);

    Object.assign(env,{OPERATOR_FEED_URL:'http://127.0.0.1:'+feedServer.address().port+'/feed',OPERATOR_FEED_TOKEN:token,OPERATOR_FEED_OPERATOR_ID:operatorId});
    await page.reload();
    await page.locator('.integration-grid').waitFor();
    await check('configured feed preview is read only and apply creates one managed trip',async () => {
      assert.ok(await page.locator('[data-action="preview-feed"]').isEnabled());
      const before = await preview(page);
      assert.deepEqual(before.counts,{created:1,updated:0,unchanged:0});
      importedId = before.trips[0].id;
      assert.equal(await tripCount(),0);
      assert.match(await page.locator('#feed-preview').innerText(),/UI-FEED-001/);
      const applied = await apply(page);
      assert.deepEqual(applied.sync,{created:1,updated:0,unchanged:0});
      assert.equal(await tripCount(),1);
      const trip = await json(await context.request.get(base+'/api/trips/'+importedId));
      assert.equal(trip.source,'managed');
      assert.equal(trip.operatorId,operatorId);
      assert.equal(trip.price,250000);
    },page);

    await check('unchanged feed disables apply and repeated server apply creates no duplicate',async () => {
      const repeated = await preview(page);
      assert.deepEqual(repeated.counts,{created:0,updated:0,unchanged:1});
      assert.ok(await page.locator('[data-action="apply-feed"]').isDisabled());
      const result = await json(await context.request.post(base+'/api/admin/integrations/operator-feed/apply',{data:{digest:repeated.digest}}));
      assert.deepEqual(result.sync,{created:0,updated:0,unchanged:1});
      assert.equal(await tripCount(),1);
    },page);

    await check('changed feed invalidates preview and a fresh review updates the stable trip',async () => {
      feed.trips[0].price = 275000;
      const original = await preview(page);
      assert.equal(original.counts.updated,1);
      feed.trips[0].price = 300000;
      const stale = await apply(page,409);
      assert.equal(stale.code,'OPERATOR_FEED_CHANGED');
      await page.locator('#feed-feedback').filter({hasText:/đã thay đổi/}).waitFor();
      assert.equal(await page.locator('#feed-preview tbody tr').count(),0);
      assert.equal((await json(await context.request.get(base+'/api/trips/'+importedId))).price,250000);
      const fresh = await preview(page);
      assert.equal(fresh.trips[0].price,300000);
      assert.equal(fresh.trips[0].id,importedId);
      await apply(page);
      assert.equal((await json(await context.request.get(base+'/api/trips/'+importedId))).price,300000);
      assert.equal(await tripCount(),1);
    },page);

    await check('desktop and mobile integration pages render without document overflow',async () => {
      await preview(page);
      await page.evaluate(() => document.fonts.ready);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
      await screenshot(page,'integrations-desktop.png');
      await page.setViewportSize({width:390,height:844});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1),'mobile document must not scroll horizontally');
      assert.equal(await page.locator('.integration-card:visible').count(),6);
      await screenshot(page,'integrations-mobile.png');
    },page);

    await check('operator and guest cannot access diagnostics or synchronize feed',async () => {
      const staff = await browser.newContext({viewport:{width:1440,height:1000}});
      try {
        const staffPage = await staff.newPage();instrument(staffPage);
        await login(staffPage,'browser-feed-staff@example.test','FeedStaff@12345');
        assert.equal(await staffPage.locator('#sidebar [data-page="integrations"]:visible').count(),0);
        await staffPage.goto(base+'/admin#integrations');
        await staffPage.locator('.stats-grid').first().waitFor();
        assert.equal(await staffPage.locator('#page-title').innerText(),'Tổng quan');
        assert.equal((await staff.request.get(base+'/api/admin/integrations')).status(),403);
        for (const action of ['preview','apply']) assert.equal((await staff.request.post(base+'/api/admin/integrations/operator-feed/'+action,{data:{}})).status(),403);
      } finally {await staff.close();}
      const guest = await browser.newContext();
      try {assert.equal((await guest.request.get(base+'/api/admin/integrations')).status(),403);} finally {await guest.close();}
    },page);

    assert.deepEqual(browserErrors,[],'browser runtime/CSP/assets errors');
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('Integration browser checks: '+passed+' passed; screenshots: '+output);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (fixtures) await fixtures.close();
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (runtime) await runtime.close();
    if (feedServer) {feedServer.closeAllConnections();await new Promise(resolve => feedServer.close(resolve));}
    const target = path.resolve(dataDir);
    assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(target).startsWith('ticket4t-integrations-ui-'));
    await fs.rm(target,{recursive:true,force:true});
  }
})();
