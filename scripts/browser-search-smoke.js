'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');
const {createApp} = require('../index');
const {addDays} = require('../server/catalog');
const {cleanupBrowserTest} = require('./browser-test-helpers');

// Every trip, booking and hold belongs to this fresh local fixture. No merchant,
// SMTP, operator feed, application .env database or deployed server is used.
(async () => {
  const prefix = 'ticket4t-browser-search-';
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  const screenshots = path.resolve('artifacts/screenshots');
  const env = {
    NODE_ENV:'test',SEED_DEMO:'false',SESSION_SECRET:'search-browser-fixture-secret-'.repeat(3),
    ADMIN_EMAIL:'search-admin@example.test',ADMIN_PASSWORD:'SearchAdmin@12345',
  };
  const errors = [],failures = [],contexts = [];
  let runtime,server,browser,staff,base,testFailure,passed = 0;

  async function json(response,status = 200) {
    const data = await response.json();
    assert.equal(response.status(),status,JSON.stringify(data));
    return data;
  }
  async function newPage() {
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror',error => errors.push(error.message));
    page.on('console',message => {
      if (message.type() === 'error' && /Content Security Policy|Refused to|Uncaught/i.test(message.text())) errors.push(message.text());
    });
    return {page,context};
  }
  async function check(id,title,work) {
    const {page,context} = await newPage();
    try {
      await work(page,context);
      passed++;
      console.log('PASS ['+id+'] '+title);
    } catch (error) {
      failures.push('['+id+'] '+title+': '+error.message);
      console.error('FAIL ['+id+'] '+title+'\n'+error.stack);
      await page.screenshot({path:path.join(screenshots,'search-failure-'+id.toLowerCase()+'.png'),fullPage:true,animations:'disabled'}).catch(() => {});
    } finally {await context.close();}
  }
  function searchUrl(date,extra = {}) {
    return base+'/#/search?'+new URLSearchParams({from:'ho-chi-minh',to:'da-lat',date,...extra});
  }
  function card(page,trip) {
    return page.locator('.trip-card').filter({has:page.locator('[data-action="favorite"][data-trip-id="'+trip.id+'"]')});
  }
  async function openSearch(page,url) {
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trips');
    await page.goto(url);
    const data = await json(await loaded);
    await page.locator('.results-toolbar').waitFor();
    return data;
  }
  async function submitFilters(page) {
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trips');
    await page.locator('#filter-form [type="submit"]').click();
    const data = await json(await loaded);
    await page.locator('.results-toolbar').waitFor();
    return data;
  }
  async function makeOperator(name) {
    return (await json(await staff.request.post(base+'/api/admin/operators',{data:{name,phone:'0901234567'}}),201)).operator;
  }
  async function makeTrip(operator,date,extra = {}) {
    return (await json(await staff.request.post(base+'/api/admin/trips',{data:{
      operatorId:operator.id,from:'ho-chi-minh',to:'da-lat',date,departureTime:'18:00',
      type:'limousine',price:250000,totalSeats:9,durationMinutes:360,
      pickupPoints:['Bến xe Miền Đông'],dropoffPoints:['Văn phòng Đà Lạt'],amenities:['Điều hòa'],
      provenance:'Kho ghế cục bộ riêng cho kiểm thử tìm và lọc chuyến',...extra,
    }}),201)).trip;
  }
  async function reserve(context,trip,seats,email) {
    return json(await context.request.post(base+'/api/bookings',{data:{
      tripId:trip.id,seats,pickup:trip.pickupPoints[0],dropoff:trip.dropoffPoints[0],
      fullName:'Hành khách kiểm thử tìm chuyến',phone:'0901234567',email,paymentMethod:'cash',
    }}),201);
  }
  async function journey(page,outward,returnDate) {
    await openSearch(page,searchUrl(outward.date,{from:outward.from,to:outward.to,mode:'roundtrip',returnDate,leg:'outbound',operator:outward.operatorId}));
    await card(page,outward).locator('.trip-card-price .btn').click();
    await page.locator('[data-action="seat"]:enabled').first().waitFor();
    await page.locator('[data-action="seat"]:enabled').first().click();
    const held = page.waitForResponse(response => new URL(response.url()).pathname === '/api/holds' && response.request().method() === 'POST');
    await page.locator('[data-action="checkout"]').click();
    await json(await held,201);
    await page.waitForURL(/leg=return/);
    await page.locator('.results-toolbar').waitFor();
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ticket4t_journey')));
    assert.equal(saved.legs.length,1);
    assert.equal(saved.legs[0].tripId,outward.id);
    return saved.legs[0];
  }
  async function assertOutwardHold(leg) {
    const hash = crypto.createHash('sha256').update(leg.hold.token).digest('hex');
    const held = await runtime.api.db.get('SELECT trip_id,expires_at FROM seat_holds WHERE hash=?',[hash]);
    assert.ok(held,'Navigation must keep the outward reservation alive');
    assert.equal(held.trip_id,leg.tripId);
    assert.ok(new Date(held.expires_at).getTime() > Date.now());
  }

  try {
    await fs.mkdir(screenshots,{recursive:true});
    runtime = await createApp({env,dataDir,seedDemo:false,disableRateLimit:true});
    server = runtime.app.listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    base = env.APP_URL = 'http://127.0.0.1:'+server.address().port;
    browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
    staff = await browser.newContext();
    contexts.push(staff);
    await json(await staff.request.post(base+'/api/auth/login',{data:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}));
    const {today} = await json(await staff.request.get(base+'/api/bootstrap'));
    const priceDate = addDays(today,2),textDate = addDays(today,3),pageDate = addDays(today,4);
    const outwardDate = addDays(today,6),returnDate = addDays(today,8),laterReturnDate = addDays(today,9);
    const priceOperator = await makeOperator('Nhà xe Giá thực tế');
    const premium = await makeTrip(priceOperator,priceDate,{totalSeats:1,seatPrices:{A01:300000}});
    const split = await makeTrip(priceOperator,priceDate,{price:200000,totalSeats:2,seatPrices:{A02:400000},departureTime:'19:00'});
    const occupiedCheap = await makeTrip(priceOperator,priceDate,{price:100000,totalSeats:3,seatPrices:{A02:200000,A03:400000},departureTime:'20:00'});
    const soldOut = await makeTrip(priceOperator,priceDate,{price:150000,totalSeats:1,departureTime:'21:00'});
    const competitor = await browser.newContext();
    contexts.push(competitor);
    await reserve(competitor,occupiedCheap,['A01'],'occupied-cheap@example.test');
    await json(await competitor.request.post(base+'/api/holds',{data:{tripId:occupiedCheap.id,seats:['A02']}}),201);
    await reserve(competitor,soldOut,['A01'],'sold-out@example.test');
    const textOperator = await makeOperator('Nhà xe Đường Việt');
    const textTrip = await makeTrip(textOperator,textDate);
    const percentTrip = await makeTrip(textOperator,textDate,{departureTime:'19:00',pickupPoints:['Bến xe Quận Một'],dropoffPoints:['Văn phòng Trung tâm'],amenities:['Ưu đãi 100%']});
    const pageOperator = await makeOperator('Nhà xe Phân trang');
    for (let i=0;i<10;i++) await makeTrip(pageOperator,pageDate,{departureTime:String(6+i).padStart(2,'0')+':00',price:200000+i*10000});
    const journeyOperator = await makeOperator('Nhà xe Đường Việt khứ hồi');
    const outward = await makeTrip(journeyOperator,outwardDate,{departureTime:'08:00',pickupPoints:['Bến xe Sài Gòn']});
    const unrelatedOutward = await makeTrip(journeyOperator,outwardDate,{from:'ha-noi',to:'sa-pa',departureTime:'08:00',pickupPoints:['Bến xe Hà Nội'],dropoffPoints:['Văn phòng Sa Pa']});
    const returning = [];
    for (const date of [returnDate,laterReturnDate]) {
      for (const departureTime of ['18:00','20:00']) returning.push(await makeTrip(journeyOperator,date,{
        from:'da-lat',to:'ho-chi-minh',departureTime,price:300000,
        pickupPoints:['Bến xe Đà Lạt'],dropoffPoints:['Văn phòng Sài Gòn'],
      }));
    }

    await check('UI-SRCH-001','Malformed dates show a recoverable validation message without requests',async page => {
      let requests = 0;
      page.on('request',request => {if (new URL(request.url()).pathname === '/api/trips') requests++;});
      for (const date of ['garbage','2099-02-30']) {
        await page.goto(searchUrl(date));
        await page.locator('#search-date-error').waitFor();
        assert.match(await page.locator('#search-date-error').innerText(),/ngày/i);
        assert.equal(await page.inputValue('#search-date'),'');
        assert.equal(requests,0,'Invalid hash dates must be caught before the trips API');
        await page.fill('#search-date',priceDate);
        const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trips');
        await page.locator('#search-form [type="submit"]').click();
        await json(await loaded);
        await page.locator('.trip-card').first().waitFor();
        requests = 0;
      }
    });

    await check('UI-SRCH-002','Inverted prices are rejected on explicit submit and automatic radio changes',async page => {
      await openSearch(page,searchUrl(priceDate));
      let requests = 0;
      page.on('request',request => {if (new URL(request.url()).pathname === '/api/trips') requests++;});
      const unchangedHash = new URL(page.url()).hash;
      await page.fill('#filter-min','400000');
      await page.fill('#filter-max','200000');
      await page.locator('#filter-form [type="submit"]').click();
      await page.locator('#toast-region .toast.error').last().waitFor();
      assert.match(await page.locator('#toast-region .toast.error').last().innerText(),/giá/i);
      assert.equal(requests,0);
      const before = await page.locator('#toast-region .toast.error').count();
      await page.locator('#filter-form [name="time"][value="evening"]').check();
      await page.waitForFunction(count => document.querySelectorAll('#toast-region .toast.error').length > count,before);
      assert.equal(requests,0,'Automatic filter changes must also validate the complete range');
      assert.equal(new URL(page.url()).hash,unchangedHash);
    });

    await check('UI-SRCH-003','Cards and price ranges reflect available seats, excluding booked and held bargains',async page => {
      const data = await openSearch(page,searchUrl(priceDate));
      const premiumResult = data.trips.find(trip => trip.id === premium.id);
      assert.equal(premiumResult.price,250000,'The base fare remains the API booking contract');
      assert.equal(premiumResult.displayPrice,300000);
      assert.match(await card(page,premium).locator('[data-trip-price]').innerText(),/300\.000/);
      assert.match(await card(page,occupiedCheap).locator('[data-trip-price]').innerText(),/400\.000/);
      const sorted = await openSearch(page,searchUrl(priceDate,{sort:'price',available:'true'}));
      assert.deepEqual(sorted.trips.map(trip => trip.id),[split.id,premium.id,occupiedCheap.id],'Price ordering uses the cheapest seat that can still be booked');
      const cheap = await openSearch(page,searchUrl(priceDate,{maxPrice:'250000'}));
      assert.ok(!cheap.trips.some(trip => trip.id === premium.id));
      assert.ok(!cheap.trips.some(trip => trip.id === occupiedCheap.id));
      assert.ok(cheap.trips.some(trip => trip.id === split.id));
      const exact = await openSearch(page,searchUrl(priceDate,{minPrice:'300000',maxPrice:'300000'}));
      assert.deepEqual(exact.trips.map(trip => trip.id),[premium.id],'200k and 400k seats do not match an exact 300k range');
      assert.equal(exact.trips[0].matchingSeats,1);
      assert.equal(await page.locator('.trip-card').count(),1);
      assert.match(await card(page,premium).locator('[data-trip-price]').innerText(),/300\.000/);
      await card(page,premium).locator('[data-action="favorite"]').click();
      await page.locator('#favorites-shortcut').click();
      await page.waitForURL(/#\/favorites/);
      assert.match(await card(page,premium).locator('[data-trip-price]').innerText(),/300\.000/,'Saved cards retain the available seat price');
      await openSearch(page,searchUrl(priceDate,{sort:'price',available:'true'}));
      for (const trip of [premium,occupiedCheap]) await card(page,trip).locator('[data-action="compare"]').click();
      await page.locator('#compare-shortcut').click();
      await page.locator('.compare-grid').waitFor();
      const comparisonPrices = await page.locator('.compare-card [data-trip-price]').allInnerTexts();
      assert.deepEqual(comparisonPrices,['300.000đ','400.000đ'],'Comparison cards retain the same available prices');
    });

    await check('UI-SRCH-004','Accentless and decomposed Vietnamese search matches keywords, pickup and dropoff',async page => {
      await openSearch(page,searchUrl(textDate));
      await page.fill('#filter-keyword','duong viet');
      assert.equal((await submitFilters(page)).total,2);
      await page.fill('#filter-keyword','Đường Việt'.normalize('NFD'));
      await page.fill('#filter-pickup','ben xe mien dong');
      await page.fill('#filter-dropoff','Văn phòng Đà Lạt'.normalize('NFD'));
      const data = await submitFilters(page);
      assert.deepEqual(data.trips.map(trip => trip.id),[textTrip.id]);
      assert.equal(await page.locator('.trip-card').count(),1);
      assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('pickup'),'ben xe mien dong');
    });

    await check('UI-SRCH-005','Literal percent keyword matches actual text instead of a wildcard',async page => {
      await openSearch(page,searchUrl(textDate));
      await page.fill('#filter-keyword','%');
      const data = await submitFilters(page);
      assert.deepEqual(data.trips.map(trip => trip.id),[percentTrip.id]);
      assert.equal(await page.locator('.trip-card').count(),1);
      assert.ok(await card(page,percentTrip).isVisible());
    });

    await check('UI-SRCH-006','Available seats filter hides sold-out trips and cards disclose sold-out state',async page => {
      await openSearch(page,searchUrl(priceDate));
      assert.match(await card(page,soldOut).innerText(),/Hết chỗ/);
      assert.doesNotMatch(await card(page,soldOut).locator('[data-trip-price]').innerText(),/150\.000/,'A sold-out trip cannot advertise its base fare as a currently available seat');
      assert.equal(await card(page,soldOut).getByText('Chọn chuyến',{exact:true}).count(),0);
      assert.match(await card(page,soldOut).locator('.trip-card-price .btn').innerText(),/Xem chuyến/);
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trips');
      await page.check('#filter-available');
      const data = await json(await loaded);
      await page.locator('.results-toolbar').waitFor();
      assert.ok(data.trips.every(trip => trip.availableSeats > 0));
      assert.equal(await card(page,soldOut).count(),0);
      assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('available'),'true');
    });

    await check('UI-SRCH-007','Out-of-range pages retain real results and normalize the active page',async page => {
      const data = await openSearch(page,searchUrl(pageDate,{page:'99'}));
      assert.equal(data.total,10);
      assert.equal(data.pages,2);
      assert.equal(data.page,2);
      assert.equal(await page.locator('.trip-card').count(),2);
      assert.equal((await page.locator('.pagination [aria-current="page"]').innerText()).trim(),'2');
      assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('page'),'2');
      assert.match(await page.locator('.results-toolbar').innerText(),/10 chuyến xe/);
    });

    await check('UI-SRCH-008','A slow earlier search cannot replace the latest filtered results',async page => {
      await openSearch(page,searchUrl(textDate));
      let release,intercept,complete;
      const gate = new Promise(resolve => {release=resolve;});
      const intercepted = new Promise(resolve => {intercept=resolve;});
      const completed = new Promise(resolve => {complete=resolve;});
      const handler = async route => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('q') !== 'mien dong') return route.continue();
        const response = await route.fetch();
        intercept();
        await gate;
        try {await route.fulfill({response});} finally {complete();}
      };
      await page.route('**/api/trips?*',handler);
      try {
        await page.fill('#filter-keyword','mien dong');
        await page.locator('#filter-form [type="submit"]').click();
        await intercepted;
        const loaded = page.waitForResponse(response => new URL(response.url()).searchParams.get('q') === '%');
        await page.evaluate(hash => {location.hash=hash;},new URL(searchUrl(textDate,{q:'%'})).hash);
        await json(await loaded);
        await card(page,percentTrip).waitFor();
        const previousResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trips' && new URL(response.url()).searchParams.get('q') === 'mien dong');
        release();
        await completed;
        await (await previousResponse).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator('.trip-card').count(),1);
        assert.ok(await card(page,percentTrip).isVisible());
        assert.equal(await card(page,textTrip).count(),0);
      } finally {release();await page.unroute('**/api/trips?*',handler);}
    });

    await check('UI-SRCH-009','Changing return date preserves every active filter, sort and outward hold',async page => {
      const leg = await journey(page,outward,returnDate);
      const values = {operator:journeyOperator.id,type:'limousine',time:'evening',minPrice:'200000',maxPrice:'400000',pickup:'ben xe da lat',dropoff:'van phong sai gon',q:'duong viet',sort:'price',available:'true'};
      const returnQuery = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
      for (const [key,value] of Object.entries(values)) returnQuery.set(key,value);
      await openSearch(page,base+'/#/search?'+returnQuery);
      await page.fill('#search-date',laterReturnDate);
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trips');
      await page.locator('#search-form [type="submit"]').click();
      const data = await json(await loaded);
      await page.locator('.results-toolbar').waitFor();
      assert.equal(data.total,2);
      const params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
      for (const [key,value] of Object.entries(values)) assert.equal(params.get(key),value,'Return-date changes preserve '+key);
      assert.equal(params.get('date'),laterReturnDate);
      assert.equal(params.get('returnDate'),laterReturnDate);
      assert.equal(params.get('leg'),'return');
      const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ticket4t_journey')));
      assert.equal(saved.legs[0].hold.token,leg.hold.token);
      await assertOutwardHold(leg);
    });

    for (const destination of ['compare','favorites']) {
      await check(destination === 'compare' ? 'UI-SRCH-010' : 'UI-SRCH-011','Opening a return trip through '+destination+' completes the same round trip',async page => {
        const leg = await journey(page,outward,returnDate);
        const candidates = returning.filter(trip => trip.date === returnDate);
        if (destination === 'compare') {
          for (const trip of candidates) await card(page,trip).locator('[data-action="compare"]').click();
          await page.locator('#compare-shortcut').click();
          await page.locator('.compare-grid').waitFor();
          await page.locator('.compare-card .btn[href*="'+candidates[0].id+'"]').click();
        } else {
          await card(page,candidates[0]).locator('[data-action="favorite"]').click();
          await page.locator('#favorites-shortcut').click();
          await page.waitForURL(/#\/favorites/);
          await card(page,candidates[0]).locator('.trip-card-price .btn').click();
        }
        await page.locator('[data-action="seat"]:enabled').first().waitFor();
        const params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
        assert.equal(params.get('mode'),'roundtrip');
        assert.equal(params.get('leg'),'return');
        assert.equal(params.get('returnDate'),returnDate);
        await assertOutwardHold(leg);
        await page.locator('[data-action="seat"]:enabled').first().click();
        await page.locator('[data-action="checkout"]').click();
        await page.locator('#checkout-form').waitFor();
        const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ticket4t_checkout')));
        assert.equal(saved.mode,'roundtrip');
        assert.equal(saved.legs.length,2);
        assert.equal(saved.legs[0].tripId,outward.id);
        assert.equal(saved.legs[0].hold.token,leg.hold.token);
        assert.equal(saved.legs[1].tripId,candidates[0].id);
        assert.equal(await page.locator('.order-leg-summary').count(),2);
        await assertOutwardHold(leg);
      });
    }

    await check('UI-SRCH-012','A return favorite opens and books as one-way in a fresh session',async page => {
      const sourceLeg = await journey(page,outward,returnDate);
      const target = returning.find(trip => trip.date === returnDate);
      await card(page,target).locator('[data-action="favorite"]').click();
      const favorites = await page.evaluate(() => localStorage.getItem('ticket4t_favorites'));
      const fresh = await newPage();
      try {
        await fresh.page.addInitScript(value => localStorage.setItem('ticket4t_favorites',value),favorites);
        await fresh.page.goto(base+'/#/favorites');
        await card(fresh.page,target).locator('.trip-card-price .btn').click();
        await fresh.page.locator('[data-action="seat"]:enabled').first().waitFor();
        const params = new URLSearchParams(new URL(fresh.page.url()).hash.split('?')[1]);
        assert.notEqual(params.get('mode'),'roundtrip','Persistent favorites must not require an absent session journey');
        assert.notEqual(params.get('leg'),'return');
        const backHref = await fresh.page.locator('.breadcrumb a[href^="#/search"]').getAttribute('href');
        assert.notEqual(new URLSearchParams(backHref.split('?')[1]).get('mode'),'roundtrip');
        assert.equal(await fresh.page.evaluate(() => sessionStorage.getItem('ticket4t_journey')),null);
        await fresh.page.locator('[data-action="seat"]:enabled').first().click();
        await fresh.page.locator('[data-action="checkout"]').click();
        await fresh.page.locator('#checkout-form').waitFor();
        const draft = await fresh.page.evaluate(() => JSON.parse(sessionStorage.getItem('ticket4t_checkout')));
        assert.equal(draft.mode,'oneway');
        assert.equal(draft.legs.length,1);
        assert.equal(draft.legs[0].tripId,target.id);
        await assertOutwardHold(sourceLeg);
      } finally {await fresh.context.close();}
    });

    await check('UI-SRCH-013','An old return favorite cannot attach to or release an unrelated active journey',async page => {
      await journey(page,outward,returnDate);
      const target = returning.find(trip => trip.date === returnDate);
      await card(page,target).locator('[data-action="favorite"]').click();
      const unrelatedLeg = await journey(page,unrelatedOutward,laterReturnDate);
      await page.locator('#favorites-shortcut').click();
      await card(page,target).locator('.trip-card-price .btn').click();
      await page.locator('[data-action="seat"]:enabled').first().waitFor();
      const params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
      assert.notEqual(params.get('mode'),'roundtrip');
      assert.notEqual(params.get('leg'),'return','The saved return trip belongs to a different outward route');
      const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ticket4t_journey')));
      assert.equal(saved.legs.length,1);
      assert.equal(saved.legs[0].tripId,unrelatedOutward.id);
      assert.equal(saved.legs[0].hold.token,unrelatedLeg.hold.token);
      await assertOutwardHold(unrelatedLeg);
      assert.equal(await page.locator('.journey-status').count(),0,'The old trip must not be presented as the current journey return leg');
    });

    assert.deepEqual(errors,[],'Search flows must not raise browser exceptions or CSP errors');
    if (failures.length) throw new AggregateError(failures.map(message => new Error(message)),passed+'/13 search browser scenarios passed');
    console.log('Search browser passed: '+passed+'/13 scenarios; date/range validation, live seat fares, Unicode/literal search, availability, pagination, stale responses and round-trip state across fresh and unrelated sessions.');
  } catch (error) {testFailure=error;throw error;}
  finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await cleanupBrowserTest({browser,server,runtime,dataDir,prefix},testFailure);
  }
})().catch(error => {console.error(error);process.exitCode=1;});
