'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');
const {createApp} = require('../index');
const {addDays} = require('../server/catalog');
const {cleanupBrowserTest} = require('./browser-test-helpers');

// Managed inventory and receipts are created only in this test's temporary database.
(async () => {
  const prefix = 'ticket4t-browser-dashboard-';
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const screenshots = path.resolve('artifacts/screenshots');
  const env = {NODE_ENV:'test', SEED_DEMO:'false', SESSION_SECRET:'dashboard-browser-isolated-session-secret', ADMIN_EMAIL:'dashboard-admin@example.test', ADMIN_PASSWORD:'DashboardAdmin@12345'};
  const contexts = [], errors = [], failures = [];
  const chartIds = ['dashboard-revenue-chart', 'dashboard-status-chart', 'dashboard-payment-chart', 'dashboard-route-chart'];
  let runtime, server, browser, staff, base, today, operatorA, operatorB, employeeA, employeeB, passed = 0, executed = 0, testFailure;

  async function json(response, status = 200) {
    const data = await response.json();
    assert.equal(response.status(), status, JSON.stringify(data));
    return data;
  }
  async function deadline(promise, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((resolve,reject) => {timer=setTimeout(() => reject(new Error(label+' timed out')),15000);})]); }
    finally { clearTimeout(timer); }
  }
  async function frame(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function check(id, title, work) {
    if (process.env.UI_DASHBOARD_CASE && !id.endsWith(process.env.UI_DASHBOARD_CASE)) return;
    executed++;
    const context = await browser.newContext({viewport:{width:1440,height:1050}});
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(id+': '+error.message));
    page.on('console', message => { if (message.type()==='error' && /Content Security Policy|Refused to|Uncaught/i.test(message.text())) errors.push(id+': '+message.text()); });
    try { await work(page,context); passed++; console.log('PASS ['+id+'] '+title); }
    catch (error) {
      failures.push('['+id+'] '+title+': '+error.message);
      console.error('FAIL ['+id+'] '+title+'\n'+error.stack);
      await page.screenshot({path:path.join(screenshots,'dashboard-failure-'+id.toLowerCase()+'.png'),fullPage:true,animations:'disabled'}).catch(() => {});
    } finally { await context.close(); }
  }
  async function ready(page, charts = true) {
    await page.locator('.stats-grid').first().waitFor();
    await page.locator('#dashboard-daily-table').waitFor({state:'attached'});
    if (charts) await page.waitForFunction(() => window.Chart?.getChart(document.getElementById('dashboard-revenue-chart')));
    await frame(page);
  }
  async function login(page, user, charts = true) {
    await page.goto(base+'/admin');
    await page.fill('#login-form [name="email"]',user?.email || env.ADMIN_EMAIL);
    await page.fill('#login-form [name="password"]',user ? 'DashboardStaff@12345' : env.ADMIN_PASSWORD);
    await page.locator('#login-form [type="submit"]').click();
    await page.locator('#portal').waitFor({state:'visible'});
    await ready(page,charts);
  }
  async function filter(page, dateFrom, dateTo, charts = true) {
    await page.fill('#filters [name="dateFrom"]',dateFrom);
    await page.fill('#filters [name="dateTo"]',dateTo);
    const response = page.waitForResponse(value => {
      const url = new URL(value.url());
      return url.pathname==='/api/admin/stats' && url.searchParams.get('dateFrom')===dateFrom && url.searchParams.get('dateTo')===dateTo;
    });
    await page.locator('#filters [type="submit"]').click();
    const data = await json(await response);
    await ready(page,charts);
    return data;
  }
  async function snapshot(page,id) {
    return page.evaluate(id => {
      const chart=window.Chart.getChart(document.getElementById(id));
      return {labels:[...chart.data.labels],datasets:chart.data.datasets.map(item => ({label:item.label,data:[...item.data]}))};
    },id);
  }
  async function countCharts(page, expected) {
    await page.waitForFunction(expected => Object.keys(window.Chart?.instances || {}).length===expected,expected);
    assert.equal(await page.evaluate(() => Object.keys(window.Chart?.instances || {}).length),expected);
  }
  async function go(page,name) {
    await page.evaluate(name => {location.hash=name;},name);
    await page.waitForFunction(name => location.hash==='#'+name && document.querySelector('#sidebar [data-page="'+name+'"]')?.classList.contains('active') && !document.querySelector('#content .loading'),name);
    if (name==='dashboard') await ready(page);
  }
  async function assertRevenue(page,data) {
    const chart=await snapshot(page,'dashboard-revenue-chart');
    assert.deepEqual(chart.labels,data.analytics.daily.map(day => day.date));
    assert.equal(chart.datasets.length,3);
    assert.deepEqual(chart.datasets.map(item => item.data),['grossRevenue','refundedAmount','revenue'].map(key => data.analytics.daily.map(day => day[key])));
    assert.equal(await page.locator('#dashboard-daily-table tbody tr').count(),data.analytics.daily.length);
  }
  function delayedStats(page,date) {
    let release, started, complete, failure, intercepted=false;
    const gate=new Promise(resolve => {release=resolve;}), held=new Promise(resolve => {started=resolve;}), done=new Promise(resolve => {complete=resolve;});
    const pattern='**/api/admin/stats?**';
    const handler=async route => {
      if (intercepted || new URL(route.request().url()).searchParams.get('dateFrom')!==date) return route.continue();
      intercepted=true;
      try { const response=await route.fetch();await json(response);started();await gate;await route.fulfill({response}); }
      catch (error) {failure=error;started();}
      finally {complete();}
    };
    return {pattern,handler,held,async finish(){release();await deadline(done,'Delayed dashboard reply');assert.ifError(failure);},async close(){release();if(intercepted)await deadline(done,'Dashboard route cleanup').catch(() => {});await page.unroute(pattern,handler);}};
  }
  async function trip(operator,extra = {}) {
    return (await json(await staff.request.post(base+'/api/admin/trips',{data:{operatorId:operator.id,from:'ho-chi-minh',to:'da-lat',date:addDays(today,4),departureTime:'08:00',durationMinutes:360,price:250000,totalSeats:9,type:'limousine',pickupPoints:['Điểm đón kiểm thử biểu đồ'],dropoffPoints:['Điểm trả kiểm thử biểu đồ'],provenance:'Kho ghế kiểm thử dashboard cục bộ',...extra}}),201)).trip;
  }
  async function booking(item,id,seat = 'A01') {
    return (await json(await staff.request.post(base+'/api/bookings',{data:{tripId:item.id,seats:[seat],fullName:'Hành khách '+id,phone:'0912345678',email:id.toLowerCase()+'@example.test',pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0],paymentMethod:'cash'}}),201)).booking;
  }
  async function collect(item) { await json(await staff.request.post(base+'/api/admin/bookings/'+item.code+'/cash-receipt',{data:{reference:'DASHBOARD-CASH-'+item.code,amount:item.total}})); }
  async function employee(operator,id) {
    return (await json(await staff.request.post(base+'/api/admin/users',{data:{fullName:'Nhân viên biểu đồ '+id,email:'dashboard-'+id.toLowerCase()+'@example.test',phone:'0901234567',password:'DashboardStaff@12345',role:'operator',operatorId:operator.id}}),201)).user;
  }

  try {
    await fs.mkdir(screenshots,{recursive:true});
    runtime=await createApp({env,dataDir,seedDemo:false,disableRateLimit:true});
    server=runtime.app.listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    base=env.APP_URL='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
    staff=await browser.newContext();contexts.push(staff);
    await json(await staff.request.post(base+'/api/auth/login',{data:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}));
    ({today}=await json(await staff.request.get(base+'/api/bootstrap')));
    operatorA=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe biểu đồ A',phone:'0901234567'}}),201)).operator;
    operatorB=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe biểu đồ B',phone:'0901234567'}}),201)).operator;
    employeeA=await employee(operatorA,'A');employeeB=await employee(operatorB,'B');
    const own=await trip(operatorA),historical=await trip(operatorA,{departureTime:'09:00'}),other=await trip(operatorB,{from:'ha-noi',to:'sa-pa',price:400000});
    const paid=await booking(own,'DASHBOARD-PAID'),refunded=await booking(historical,'DASHBOARD-REFUNDED'),pending=await booking(own,'DASHBOARD-PENDING','A02'),otherPaid=await booking(other,'DASHBOARD-OTHER');
    await collect(paid);await collect(refunded);await collect(otherPaid);
    await json(await staff.request.patch(base+'/api/admin/bookings/'+refunded.code,{data:{status:'cancelled'}}));
    await json(await staff.request.post(base+'/api/admin/bookings/'+refunded.code+'/refund-receipt',{data:{reference:'DASHBOARD-REFUND-'+refunded.code,amount:refunded.total}}));
    // Only fixture timestamps move: the instants straddle Vietnamese midnight.
    await runtime.api.db.transaction(async tx => {
      for (const [item,time] of [[paid,'2020-04-01T17:00:00.000Z'],[refunded,'2020-04-01T16:59:59.999Z'],[pending,'2020-04-02T17:00:00.000Z'],[otherPaid,'2020-04-01T17:00:00.000Z']]) await tx.run('UPDATE bookings SET created_at=? WHERE code=?',[time,item.code]);
      await tx.run('UPDATE payments SET created_at=? WHERE booking_code=?',['2020-04-01T17:00:00.000Z',paid.code]);
      await tx.run("UPDATE payments SET created_at=? WHERE booking_code=? AND status='paid'",['2020-04-01T16:59:59.999Z',refunded.code]);
      await tx.run("UPDATE payments SET created_at=? WHERE booking_code=? AND status='refunded'",['2020-04-02T17:00:00.000Z',refunded.code]);
      await tx.run('UPDATE payments SET created_at=? WHERE booking_code=?',['2020-04-01T17:00:00.000Z',otherPaid.code]);
    });
    await json(await staff.request.patch(base+'/api/admin/trips/'+historical.id,{data:{operatorId:operatorB.id,from:'ha-noi',to:'sa-pa',price:350000}}));

    await check('UI-DASHBOARD-001','Local charts match receipts and accessible tables; legend and tooltip respond to pointer input',async (page,context) => {
      const requests=[];page.on('request',request => {if(request.resourceType()==='script')requests.push(request.url());});
      await login(page);
      const data=await filter(page,'2020-04-01','2020-04-03');
      await assertRevenue(page,data);await countCharts(page,4);
      assert.ok(requests.some(url => new URL(url).pathname==='/admin/vendor/chart.umd.js'));
      assert.ok(requests.every(url => new URL(url).origin===base),'Dashboard scripts must stay on the application origin');
      assert.equal(await page.evaluate(() => window.Chart.version),'4.5.1');
      assert.deepEqual((await snapshot(page,'dashboard-payment-chart')).datasets[0].data,data.analytics.byPaymentMethod.map(row => row.revenue));
      assert.deepEqual((await snapshot(page,'dashboard-route-chart')).datasets[0].data,[...data.analytics.byRoute].sort((a,b) => b.bookings-a.bookings || `${a.from}/${a.to}`.localeCompare(`${b.from}/${b.to}`)).slice(0,10).map(row => row.bookings));
      assert.equal(await page.locator('#dashboard-payment-table tbody tr').count(),data.analytics.byPaymentMethod.length);
      assert.equal(await page.locator('#dashboard-route-table tbody tr').count(),data.analytics.byRoute.length);
      const status=await snapshot(page,'dashboard-status-chart');
      assert.deepEqual(status.datasets[0].data,data.analytics.byStatus.map(row => row.bookings));
      assert.ok((await page.locator('#dashboard-status-list').innerText()).includes('1'));
      assert.equal(await page.locator('[data-chart-fallback]:visible').count(),0);
      const toggle=page.locator('[data-chart-series="0"]');await toggle.click();
      await page.waitForFunction(() => !window.Chart.getChart(document.getElementById('dashboard-revenue-chart')).isDatasetVisible(0));
      assert.equal(await toggle.getAttribute('aria-pressed'),'false');
      assert.equal(await page.locator('#dashboard-daily-table tbody tr').count(),3,'Hiding a series must preserve the detailed ledger table');
      await toggle.focus();await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.Chart.getChart(document.getElementById('dashboard-revenue-chart')).isDatasetVisible(0));
      assert.equal(await toggle.getAttribute('aria-pressed'),'true');
      const canvas=page.locator('#dashboard-revenue-chart');await canvas.scrollIntoViewIfNeeded();
      const point=await page.evaluate(() => {const chart=window.Chart.getChart(document.getElementById('dashboard-revenue-chart')),point=chart.getDatasetMeta(0).data[1];return {x:point.x,y:point.y,width:chart.width,height:chart.height};});
      const box=await canvas.boundingBox();await page.mouse.move(box.x+point.x*box.width/point.width,box.y+point.y*box.height/point.height);
      await page.waitForFunction(() => window.Chart.getChart(document.getElementById('dashboard-revenue-chart')).tooltip.getActiveElements().length>0);
      await page.mouse.move(0,0);await page.evaluate(() => window.scrollTo(0,0));await frame(page);
      await page.screenshot({path:path.join(screenshots,'dashboard-charts-desktop.png'),fullPage:true,animations:'disabled'});
      assert.equal((await context.request.get(base+'/api/admin/stats?dateFrom=2020-02-30')).status(),400);
    });

    await check('UI-DASHBOARD-002','Vietnamese calendar boundaries preserve independent booking and receipt dates and a negative net refund day',async page => {
      await login(page);
      const collection=await filter(page,'2020-04-02','2020-04-02');
      assert.equal(collection.stats.bookings,2);assert.equal(collection.stats.trips,0);assert.equal(collection.stats.grossRevenue,650000);assert.equal(collection.stats.refundedAmount,0);
      assert.equal(await page.locator('.managed-progress').evaluate(element => element.style.width),'0%');
      assert.equal(await page.locator('.demo-progress').evaluate(element => element.style.width),'0%','A period with no trips must not display a full demo-source bar');
      await assertRevenue(page,collection);
      const refund=await filter(page,'2020-04-03','2020-04-03');
      assert.equal(refund.stats.bookings,1);assert.equal(refund.stats.grossRevenue,0);assert.equal(refund.stats.refundedAmount,250000);assert.equal(refund.stats.revenue,-250000);
      await assertRevenue(page,refund);
      assert.deepEqual((await snapshot(page,'dashboard-revenue-chart')).datasets[2].data,[-250000]);
      assert.match(await page.locator('.stat-card').first().innerText(),/-250[.\s]000/);
      await page.locator('details:has(#dashboard-daily-table) > summary').click();
      assert.match(await page.locator('#dashboard-daily-table').innerText(),/-250[.\s]000/);
    });

    await check('UI-DASHBOARD-003','Date shortcuts and leap-year range retain all 7, 30 and 366 days including zero periods',async page => {
      await login(page);
      for (const days of [7,30]) {
        const response=page.waitForResponse(value => new URL(value.url()).pathname==='/api/admin/stats');
        await page.locator('[data-action="dashboard-range"][data-range="'+days+'"]').click();
        const data=await json(await response);await ready(page);await assertRevenue(page,data);
        assert.equal(data.analytics.daily.length,days);
        assert.equal(await page.inputValue('#filters [name="dateTo"]'),today);
      }
      const year=await filter(page,'2020-01-01','2020-12-31');await assertRevenue(page,year);assert.equal(year.analytics.daily.length,366);
      const empty=await filter(page,'2019-04-01','2019-04-02');await assertRevenue(page,empty);assert.equal(empty.stats.bookings,0);assert.equal(empty.stats.grossRevenue,0);
      assert.deepEqual((await snapshot(page,'dashboard-revenue-chart')).datasets.map(row => row.data),[[0,0],[0,0],[0,0]]);
      await countCharts(page,1);assert.match(await page.locator('#dashboard-status-list').innerText(),/Chưa có đơn/);
      const response=page.waitForResponse(value => new URL(value.url()).pathname==='/api/admin/stats');await page.locator('[data-action="reset-filters"]').click();await json(await response);await ready(page);
      assert.equal(await page.inputValue('#filters [name="dateFrom"]'),'');assert.equal(await page.inputValue('#filters [name="dateTo"]'),'');
      assert.equal((await snapshot(page,'dashboard-revenue-chart')).labels.length,14);
    });

    await check('UI-DASHBOARD-004','Operator charts preserve historical ownership after cancelled inventory is reassigned',async (page,context) => {
      await login(page,employeeA);const own=await filter(page,'2020-04-01','2020-04-03');await assertRevenue(page,own);
      assert.equal(own.stats.grossRevenue,500000);assert.equal(own.stats.refundedAmount,250000);assert.equal(own.stats.bookings,3);
      assert.ok(own.analytics.byOperator.every(row => row.operatorId===operatorA.id));
      assert.ok(own.analytics.byRoute.every(row => row.from==='ho-chi-minh' && row.to==='da-lat'));
      await page.locator('details:has(#dashboard-route-table) > summary').click();
      assert.ok((await page.locator('#dashboard-route-table').innerText()).includes(own.analytics.byRoute[0].fromName));
      assert.ok(!(await page.locator('#dashboard-route-table').innerText()).includes('Sa Pa'));
      await page.locator('#logout-button').click();await page.locator('#login-screen').waitFor({state:'visible'});await countCharts(page,0);
      await login(page,employeeB);const other=await filter(page,'2020-04-01','2020-04-03');await assertRevenue(page,other);
      assert.equal(other.stats.grossRevenue,400000);assert.equal(other.stats.refundedAmount,0);assert.equal(other.stats.bookings,1);
      assert.ok(other.analytics.byOperator.every(row => row.operatorId===operatorB.id));
      assert.equal((await context.request.get(base+'/api/admin/users')).status(),403);
    });

    await check('UI-DASHBOARD-005','A delayed old date-range response cannot replace a newer report or its chart instances',async page => {
      await login(page);const gate=delayedStats(page,'2020-04-02');await page.route(gate.pattern,gate.handler);
      try {
        await page.fill('#filters [name="dateFrom"]','2020-04-02');await page.fill('#filters [name="dateTo"]','2020-04-02');await page.locator('#filters [type="submit"]').click();
        await deadline(gate.held,'Old dashboard report');await countCharts(page,0);
        await page.locator('[data-action="refresh"]').click();await ready(page);
        const current=await filter(page,'2020-04-03','2020-04-03');await assertRevenue(page,current);
        const ids=await page.evaluate(() => Object.keys(window.Chart.instances));
        await gate.finish();await frame(page);await assertRevenue(page,current);
        assert.deepEqual(await page.evaluate(() => Object.keys(window.Chart.instances)),ids);
        assert.equal(await page.inputValue('#filters [name="dateFrom"]'),'2020-04-03');
      } finally {await gate.close();}
    });

    await check('UI-DASHBOARD-006','Navigation and repeated refresh destroy old chart instances and keep one chart per canvas',async page => {
      await login(page);
      for (let index=0;index<3;index++) {
        const old=await page.evaluate(() => {window.dashboardPreviousCharts=Object.values(window.Chart.instances);return window.dashboardPreviousCharts.map(chart => chart.id);});
        const response=page.waitForResponse(value => new URL(value.url()).pathname==='/api/admin/stats');await page.locator('[data-action="refresh"]').click();await json(await response);await ready(page);await countCharts(page,4);
        const current=await page.evaluate(() => Object.values(window.Chart.instances).map(chart => chart.id));assert.ok(current.every(id => !old.includes(id)));
        assert.ok(await page.evaluate(() => window.dashboardPreviousCharts.every(chart => chart.canvas===null && chart.ctx===null)));
        await go(page,'trips');await countCharts(page,0);await go(page,'dashboard');await countCharts(page,4);
      }
    });

    await check('UI-DASHBOARD-007','Logout destroys charts and a late report cannot expose data or restore the portal',async page => {
      await login(page);const gate=delayedStats(page,'2020-04-02');await page.route(gate.pattern,gate.handler);
      try {
        await page.fill('#filters [name="dateFrom"]','2020-04-02');await page.fill('#filters [name="dateTo"]','2020-04-02');await page.locator('#filters [type="submit"]').click();await deadline(gate.held,'Dashboard report before logout');
        await page.locator('#logout-button').click();await page.locator('#login-screen').waitFor({state:'visible'});await countCharts(page,0);
        await gate.finish();await frame(page);await countCharts(page,0);
        assert.equal(await page.locator('#content').innerText(),'');assert.ok(await page.locator('#portal').isHidden());assert.equal(await page.locator('canvas').count(),0);
      } finally {await gate.close();}
    });

    await check('UI-DASHBOARD-008','An unavailable local chart library preserves KPIs, date filters and readable ledger tables',async page => {
      let attempts=0;await page.route('**/admin/vendor/chart.umd.js',route => {attempts++;return route.abort('failed');});
      await login(page,null,false);assert.ok(attempts>=1);assert.equal(await page.evaluate(() => typeof window.Chart),'undefined');
      assert.ok(await page.locator('[data-chart-fallback]:visible').count()>0);
      const data=await filter(page,'2020-04-01','2020-04-03',false);
      assert.equal(await page.locator('.stat-card').count(),8);assert.equal(await page.locator('#dashboard-daily-table tbody tr').count(),3);
      assert.equal(await page.locator('#dashboard-payment-table tbody tr').count(),data.analytics.byPaymentMethod.length);
      assert.equal(await page.locator('#dashboard-route-table tbody tr').count(),data.analytics.byRoute.length);
      assert.match(await page.locator('#dashboard-daily-table').innerText(),/650[.\s]000/);
      assert.ok(await page.locator('[data-chart-fallback]:visible').count()>0);
      await page.locator('#dashboard-daily-table').evaluate(table => {const details=table.closest('details');if(details)details.open=true;});
      assert.ok(await page.locator('#dashboard-daily-table').isVisible());
    });

    await check('UI-DASHBOARD-009','Charts resize at 390 pixels without page overflow and retain accessible tabular data',async page => {
      await login(page);const data=await filter(page,'2020-04-01','2020-04-03');await page.setViewportSize({width:390,height:844});await frame(page);
      await page.waitForFunction(ids => ids.every(id => {const canvas=document.getElementById(id),chart=window.Chart.getChart(canvas);return chart.width>0 && Math.abs(chart.width-canvas.getBoundingClientRect().width)<2;}),chartIds);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),'Mobile dashboard must not overflow the viewport');
      for (const id of chartIds) {
        const box=await page.locator('#'+id).boundingBox();assert.ok(box && box.width>0 && box.x>=-1 && box.x+box.width<=391,id+' fits mobile');
        assert.ok(await page.locator('#'+id).getAttribute('aria-label'),id+' has an accessible description');
      }
      await assertRevenue(page,data);
      await page.mouse.move(0,0);await page.evaluate(() => window.scrollTo(0,0));await frame(page);
      await page.screenshot({path:path.join(screenshots,'dashboard-charts-mobile.png'),fullPage:true,animations:'disabled'});
      await page.locator('#menu-button').click();await page.locator('#sidebar [data-page="trips"]').click();await page.waitForFunction(() => location.hash==='#trips' && !document.querySelector('#content .loading'));await countCharts(page,0);
    });

    assert.ok(executed>0,'At least one dashboard case must run');
    assert.deepEqual(errors,[],'Dashboard must not raise browser exceptions or CSP errors');
    if (failures.length) throw new AggregateError(failures.map(message => new Error(message)),passed+'/'+executed+' dashboard browser scenarios passed');
    console.log('Dashboard browser passed: '+passed+'/'+executed+' scenarios; receipt charts, Vietnamese date ranges, operator scope, pointer interaction, lifecycle, races, local-library fallback and mobile layout.');
  } catch (error) {testFailure=error;throw error;}
  finally {await Promise.allSettled(contexts.map(context => context.close()));await cleanupBrowserTest({browser,server,runtime,dataDir,prefix},testFailure);}
})().catch(error => {console.error(error);process.exitCode=1;});
