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

// Managed inventory and every write are local to this temporary test database.
// A test environment object deliberately excludes .env database and services.
(async () => {
  const prefix = 'ticket4t-browser-checkout-';
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  const screenshots = path.resolve('artifacts/screenshots');
  const env = {NODE_ENV:'test',SEED_DEMO:'false',SESSION_SECRET:'checkout-browser-session-fixture-'.repeat(3),ADMIN_EMAIL:'checkout-admin@example.test',ADMIN_PASSWORD:'CheckoutAdmin@12345'};
  const failures = [],errors = [],contexts = [];
  let runtime,server,browser,staff,base,operator,today,testFailure,passed = 0,sequence = 0;

  const holdHash = hold => crypto.createHash('sha256').update(hold.token).digest('hex');
  async function json(response,status = 200) {
    const data = await response.json();
    assert.equal(response.status(),status,JSON.stringify(data));
    return data;
  }
  async function freshPage() {
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror',error => errors.push(error.message));
    page.on('console',message => {if (message.type() === 'error' && /Content Security Policy|Refused to|Uncaught/i.test(message.text())) errors.push(message.text());});
    return {page,context};
  }
  async function check(id,title,work) {
    const {page,context} = await freshPage();
    try {await work(page,context);passed++;console.log('PASS ['+id+'] '+title);}
    catch (error) {
      failures.push('['+id+'] '+title+': '+error.message);
      console.error('FAIL ['+id+'] '+title+'\n'+error.stack);
      await page.screenshot({path:path.join(screenshots,'checkout-failure-'+id.toLowerCase()+'.png'),fullPage:true,animations:'disabled'}).catch(() => {});
    } finally {await context.close();}
  }
  async function trip(extra = {}) {
    sequence++;
    return (await json(await staff.request.post(base+'/api/admin/trips',{data:{
      operatorId:operator.id,from:'ho-chi-minh',to:'da-lat',date:addDays(today,2+sequence),departureTime:'08:00',type:'limousine',
      price:250000,totalSeats:9,durationMinutes:360,pickupPoints:['Bến xe thử nghiệm','Văn phòng thử nghiệm'],
      dropoffPoints:['Bến xe Đà Lạt thử nghiệm','Văn phòng Đà Lạt thử nghiệm'],
      provenance:'Kho ghế riêng cục bộ cho kiểm thử chọn chỗ và phục hồi đặt vé',...extra,
    }}),201)).trip;
  }
  async function patch(item,changes) {return json(await staff.request.patch(base+'/api/admin/trips/'+item.id,{data:changes}));}
  async function promo(value = 50) {
    return (await json(await staff.request.post(base+'/api/admin/promotions',{data:{code:'UICHECK'+(++sequence),title:'Ưu đãi kiểm thử đặt vé',type:'percentage',value,minSpend:0,maxDiscount:0,maxUses:100,perCustomer:100}}),201)).promotion;
  }
  async function detail(page,item) {
    await page.goto(base+'/#/trip/'+item.id);
    await page.locator('[data-action="seat"][data-label="A01"]:enabled').waitFor();
  }
  async function select(page,labels = ['A01']) {
    for (const label of labels) await page.locator('[data-action="seat"][data-label="'+label+'"]:enabled').click();
  }
  async function checkout(page,item,labels = ['A01']) {
    await detail(page,item);await select(page,labels);
    await page.locator('[data-action="checkout"]').click();
    await page.locator('#checkout-form').waitFor();
    return draft(page);
  }
  async function draft(page) {return page.evaluate(() => JSON.parse(sessionStorage.getItem('ticket4t_checkout')));}
  function person(id) {return {fullName:'Hành khách '+id,phone:'0912345678',email:id.toLowerCase()+'@example.test'};}
  async function fill(page,id,{consent = true,points = true} = {}) {
    const value = person(id);
    for (const [key,text] of Object.entries(value)) await page.fill('#'+key,text);
    if (points) {
      for (const selector of ['#pickup','#dropoff','#return-pickup','#return-dropoff']) {
        if (await page.locator(selector).count()) await page.locator(selector).selectOption({index:1});
      }
    }
    if (consent) await page.check('#checkout-form [name="consent"]');
    return value;
  }
  async function assertPerson(page,id) {
    for (const [key,value] of Object.entries(person(id))) assert.equal(await page.inputValue('#'+key),value,'Preserved '+key);
  }
  async function applyPromo(page,p) {
    await page.fill('#coupon-code',p.code);
    await page.locator('[data-action="apply-coupon"]').click();
    await page.locator('#coupon-feedback.coupon-success').waitFor();
  }
  async function expire(page,indices,{client = true} = {}) {
    const saved = await draft(page),expiry = new Date(Date.now()-60000).toISOString();
    for (const i of indices) await runtime.api.db.transaction(tx => tx.run('UPDATE seat_holds SET expires_at=? WHERE hash=?',[expiry,holdHash(saved.legs[i].hold)]));
    if (client) {
      await page.evaluate(({indices,expiry}) => {
        for (const key of ['ticket4t_checkout','ticket4t_journey']) {
          const value=JSON.parse(sessionStorage.getItem(key)||'null');if(!value)continue;
          for (const i of indices) if(value.legs?.[i]?.hold)value.legs[i].hold.expiresAt=expiry;
          if(indices.includes(0)&&value.hold)value.hold.expiresAt=expiry;
          sessionStorage.setItem(key,JSON.stringify(value));
        }
      },{indices,expiry});
      await page.reload();await page.locator('#checkout-form').waitFor();
      await page.locator('[data-action="renew-holds"]').waitFor({state:'visible'});
    }
    return saved;
  }
  async function heldRow(hold) {return runtime.api.db.get('SELECT trip_id,expires_at FROM seat_holds WHERE hash=?',[holdHash(hold)]);}
  async function heldCount(item) {return Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM seat_holds WHERE trip_id=?',[item.id])).n);}
  async function bookings(email) {return Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM bookings WHERE email=?',[email])).n);}
  async function roundtrip(page) {
    const outward=await trip(),returning=await trip({from:'da-lat',to:'ho-chi-minh',date:addDays(outward.date,1),departureTime:'18:00'});
    await page.goto(base+'/#/search?'+new URLSearchParams({from:outward.from,to:outward.to,date:outward.date,operator:operator.id,mode:'roundtrip',returnDate:returning.date,leg:'outbound'}));
    await page.locator('.trip-card-price .btn[href*="'+outward.id+'"]').click();
    await page.locator('[data-action="seat"][data-label="A01"]:enabled').waitFor();await select(page);
    await page.locator('[data-action="checkout"]').click();await page.waitForURL(/leg=return/);
    await page.locator('.trip-card-price .btn[href*="'+returning.id+'"]').click();
    await page.locator('[data-action="seat"][data-label="A01"]:enabled').waitFor();await select(page);
    await page.locator('[data-action="checkout"]').click();await page.locator('#checkout-form').waitFor();
    return {outward,returning,saved:await draft(page)};
  }
  async function competitorHold(item) {
    const context=await browser.newContext();contexts.push(context);
    const data=await json(await context.request.post(base+'/api/holds',{data:{tripId:item.id,seats:['A01']}}),201);
    return {context,hold:data.hold};
  }
  async function frame(page) {await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));}
  async function customer(id) {
    const context=await browser.newContext();contexts.push(context);
    const user={fullName:'Tài khoản '+id,email:id.toLowerCase()+'@example.test',phone:id.startsWith('BOB')?'0987654321':'0901234567',password:'CheckoutCustomer@12345'};
    try {await json(await context.request.post(base+'/api/auth/register',{data:user}),201);return user;}
    finally {await context.close();}
  }
  async function login(page,user) {
    await page.goto(base+'/#/login');await page.locator('#auth-form').waitFor();
    await page.fill('#auth-email',user.email);await page.fill('#auth-password',user.password);
    await page.locator('#auth-form [type="submit"]').click();await page.locator('.profile-card').waitFor();
    assert.ok((await page.locator('.profile-head').innerText()).includes(user.email));
  }
  async function logout(page) {
    await page.goto(base+'/#/account');await page.locator('[data-action="logout"]').click();
    await page.waitForURL(url => url.hash==='#/');
    await page.waitForFunction(() => !document.querySelector('[data-action="logout"]'));
  }
  async function assertDefaults(page,user) {
    for(const key of ['fullName','phone','email'])assert.equal(await page.inputValue('#'+key),user[key],'Current account default '+key);
    assert.equal(await page.locator('[data-checkout-recovery]').count(),0,'A different account must not recover a prior passenger attempt');
    assert.equal(await page.isChecked('#checkout-form [name="consent"]'),false);
  }

  try {
    await fs.mkdir(screenshots,{recursive:true});
    runtime=await createApp({env,dataDir,seedDemo:false,disableRateLimit:true});
    server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));
    base=env.APP_URL='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
    staff=await browser.newContext();contexts.push(staff);
    await json(await staff.request.post(base+'/api/auth/login',{data:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}));
    ({today}=await json(await staff.request.get(base+'/api/bootstrap')));
    operator=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe kiểm thử đặt vé',phone:'0901234567'}}),201)).operator;

    await check('UI-CHECK-001','A fare changed after seat selection requires review before a new hold',async page => {
      const item=await trip();await detail(page,item);await select(page);
      await patch(item,{price:300000});
      const rejected=page.waitForResponse(response => new URL(response.url()).pathname === '/api/holds' && response.request().method() === 'POST');
      await page.locator('[data-action="checkout"]').click();
      assert.equal((await json(await rejected,409)).code,'TRIP_CHANGED');
      await page.locator('#seat-review-notice').waitFor();
      assert.equal(await page.locator('.seat.selected').count(),1);
      assert.match(await page.locator('#seat-summary').innerText(),/300\.000/);
      assert.equal(await heldCount(item),0);
      await page.locator('[data-action="checkout"]').click();await page.locator('#checkout-form').waitFor();
      assert.match(await page.locator('[data-checkout-total]').innerText(),/300\.000/);
    });

    await check('UI-CHECK-002','A departure change after selection is displayed and reconfirmed before holding',async page => {
      const item=await trip();await detail(page,item);await select(page);await patch(item,{departureTime:'11:00'});
      const rejected=page.waitForResponse(response => new URL(response.url()).pathname === '/api/holds' && response.request().method() === 'POST');
      await page.locator('[data-action="checkout"]').click();assert.equal((await json(await rejected,409)).code,'TRIP_CHANGED');
      await page.locator('#seat-review-notice').waitFor();assert.match(await page.locator('.detail-heading').innerText(),/11:00/);assert.equal(await heldCount(item),0);
      await page.locator('[data-action="checkout"]').click();await page.locator('#checkout-form').waitFor();assert.match(await page.locator('.summary-card').innerText(),/11:00/);
    });

    await check('UI-CHECK-003','A lost first hold response can be retried in the already established guest session',async page => {
      const item=await trip();await detail(page,item);await select(page);
      const requests=[];page.on('request',request => {if(new URL(request.url()).pathname.startsWith('/api/holds'))requests.push(new URL(request.url()).pathname);});
      let first=true,committed;
      await page.route('**/api/holds',async route => {
        if(route.request().method()!=='POST'||!first)return route.continue();first=false;
        const response=await route.fetch();committed=await json(response,201);await route.abort('failed');
      });
      await page.locator('[data-action="checkout"]').click();await page.locator('#toast-region .toast.error').last().waitFor();assert.ok(committed?.hold);
      assert.ok(requests.indexOf('/api/holds/session')>=0 && requests.indexOf('/api/holds/session')<requests.indexOf('/api/holds'));
      assert.ok((await page.context().cookies(base)).some(cookie => cookie.name==='ticket4t.sid'),'The guest session survives the lost hold response');
      await page.locator('[data-action="checkout"]').click();await page.locator('#checkout-form').waitFor();
      assert.equal(await heldCount(item),1);assert.deepEqual((await draft(page)).legs[0].seats,['A01']);
    });

    await check('UI-CHECK-004','Server-expired holds expose renewal despite a future cached expiry and keep passenger fields',async page => {
      const item=await trip();await checkout(page,item);const value=await fill(page,'UI-CHECK-004');
      await expire(page,[0],{client:false});
      const rejected=page.waitForResponse(response => new URL(response.url()).pathname === '/api/bookings' && response.request().method() === 'POST');
      await page.click('#book-button');assert.equal((await json(await rejected,409)).code,'HOLD_EXPIRED');
      await page.locator('[data-action="renew-holds"]').waitFor({state:'visible'});assert.ok(await page.locator('#book-button').isDisabled());await assertPerson(page,'UI-CHECK-004');
      assert.equal(await page.inputValue('#pickup'),item.pickupPoints[1]);assert.equal(await page.inputValue('#dropoff'),item.dropoffPoints[1]);assert.equal(await bookings(value.email),0);
      await page.locator('[data-action="renew-holds"]').click();await page.waitForFunction(() => !document.querySelector('#book-button').disabled);await assertPerson(page,'UI-CHECK-004');
    });

    await check('UI-CHECK-005','Renewal reprices expired seats, invalidates the old coupon and requires fresh consent',async page => {
      const item=await trip(),p=await promo();await checkout(page,item);await fill(page,'UI-CHECK-005');await applyPromo(page,p);
      await page.check('#checkout-form [name="consent"]');
      assert.match(await page.locator('[data-checkout-total]').innerText(),/125\.000/);
      await expire(page,[0]);await json(await staff.request.get(base+'/api/trips/'+item.id));await patch(item,{price:300000});
      await page.locator('[data-action="renew-holds"]').click();await page.locator('#checkout-review-notice').waitFor();
      await assertPerson(page,'UI-CHECK-005');assert.equal(await page.inputValue('#pickup'),item.pickupPoints[1]);
      assert.equal(await page.inputValue('#coupon-code'),p.code);assert.match(await page.locator('[data-checkout-total]').innerText(),/300\.000/);
      assert.equal(await page.isChecked('#checkout-form [name="consent"]'),false);assert.equal(await page.locator('#coupon-feedback.coupon-success').count(),0);
      await applyPromo(page,p);assert.match(await page.locator('[data-checkout-total]').innerText(),/150\.000/);
    });

    await check('UI-CHECK-006','Failed renewal of an expired outward leg preserves the still valid return hold',async page => {
      const {outward,saved}=await roundtrip(page);await fill(page,'UI-CHECK-006');await expire(page,[0]);
      const competitor=await competitorHold(outward);
      try {
        const rejected=page.waitForResponse(response => new URL(response.url()).pathname === '/api/holds' && response.request().method() === 'POST');
        await page.locator('[data-action="renew-holds"]').click();await json(await rejected,409);await page.locator('#toast-region .toast.error').last().waitFor();
        assert.ok(await heldRow(saved.legs[1].hold),'A failed outward renewal must not sacrifice the existing return reservation');
        assert.ok(await heldRow(competitor.hold));await assertPerson(page,'UI-CHECK-006');assert.ok(await page.locator('#book-button').isDisabled());
        assert.equal((await draft(page)).legs[1].hold.token,saved.legs[1].hold.token);
      } finally {await competitor.context.close();}
    });

    await check('UI-CHECK-007','Failure on the second renewed leg cleans the first newly acquired hold',async page => {
      const {outward,returning}=await roundtrip(page);await fill(page,'UI-CHECK-007');await expire(page,[0,1]);
      const competitor=await competitorHold(returning);
      try {
        const result=page.waitForResponse(response => new URL(response.url()).pathname === '/api/holds' && response.request().method() === 'POST' && response.request().postDataJSON().tripId === returning.id);
        await page.locator('[data-action="renew-holds"]').click();await json(await result,409);await page.locator('#toast-region .toast.error').last().waitFor();
        assert.equal(await heldCount(outward),0,'Partially acquired renewal must be compensated');assert.ok(await heldRow(competitor.hold));
        await assertPerson(page,'UI-CHECK-007');assert.ok(await page.locator('#book-button').isDisabled());assert.equal((await draft(page)).legs.length,2);
      } finally {await competitor.context.close();}
    });

    await check('UI-CHECK-008','A delayed old renewal cannot overwrite or release a newer checkout draft',async page => {
      const old=await trip(),current=await trip();await checkout(page,old);await fill(page,'UI-CHECK-008');await expire(page,[0]);
      let release,intercept,complete,oldHold;const gate=new Promise(resolve => {release=resolve;}),intercepted=new Promise(resolve => {intercept=resolve;}),completed=new Promise(resolve => {complete=resolve;});
      const handler=async route => {
        if(route.request().method()!=='POST'||route.request().postDataJSON().tripId!==old.id)return route.continue();
        const response=await route.fetch();oldHold=(await json(response,201)).hold;intercept();await gate;try{await route.fulfill({response});}finally{complete();}
      };
      await page.route('**/api/holds',handler);
      try {
        await page.locator('[data-action="renew-holds"]').click();await intercepted;
        await checkout(page,current);const saved=await draft(page);await fill(page,'CURRENT-DRAFT');
        const cleanup=page.waitForResponse(response => new URL(response.url()).pathname === '/api/holds/'+oldHold.token && response.request().method() === 'DELETE');
        release();await completed;await json(await cleanup);await frame(page);
        const after=await draft(page);assert.equal(after.legs[0].tripId,current.id);assert.equal(after.legs[0].hold.token,saved.legs[0].hold.token);await assertPerson(page,'CURRENT-DRAFT');
        assert.equal(await heldRow(oldHold),undefined);assert.ok(await heldRow(saved.legs[0].hold));
      } finally {release();await page.unroute('**/api/holds',handler);}
    });

    await check('UI-CHECK-009','A pending old seat refresh does not block or overwrite a new trip refresh',async page => {
      const old=await trip(),current=await trip();await detail(page,old);
      let release,intercept,complete;const gate=new Promise(resolve => {release=resolve;}),intercepted=new Promise(resolve => {intercept=resolve;}),completed=new Promise(resolve => {complete=resolve;});
      const handler=async route => {const response=await route.fetch();intercept();await gate;try{await route.fulfill({response});}finally{complete();}};
      await page.route('**/api/trips/'+old.id,handler);
      try {
        await page.locator('[data-action="refresh-seats"]').click();await intercepted;
        await detail(page,current);await select(page,['A02']);const competitor=await competitorHold(current);
        try {
          const loaded=page.waitForResponse(response => new URL(response.url()).pathname === '/api/trips/'+current.id);
          await page.locator('[data-action="refresh-seats"]').click();await json(await loaded);
          await page.waitForFunction(() => document.querySelector('[data-action="seat"][data-label="A01"]')?.disabled);
          const previous=page.waitForResponse(response => new URL(response.url()).pathname === '/api/trips/'+old.id);release();await completed;await(await previous).finished();await frame(page);
          assert.ok(new URL(page.url()).hash.includes(current.id));assert.equal(await page.locator('.seat.selected').count(),1);assert.equal(await page.locator('.seat.selected').getAttribute('data-label'),'A02');assert.ok(await page.locator('[data-label="A01"]').isDisabled());
        } finally {await competitor.context.close();}
      } finally {release();await page.unroute('**/api/trips/'+old.id,handler);}
    });

    await check('UI-CHECK-010','Guest data survives reload and seat editing without carrying consent across a fare change',async page => {
      const item=await trip({seatPrices:{A02:300000}});await checkout(page,item);await fill(page,'UI-CHECK-010');await page.reload();await page.locator('#checkout-form').waitFor();await assertPerson(page,'UI-CHECK-010');
      assert.equal(await page.inputValue('#pickup'),item.pickupPoints[1]);assert.equal(await page.inputValue('#dropoff'),item.dropoffPoints[1]);
      await page.locator('.summary-card a[href^="#/trip/"]').click();await page.locator('[data-label="A01"]').waitFor();
      if(await page.locator('[data-label="A01"]').getAttribute('aria-pressed')==='true')await page.locator('[data-label="A01"]').click();
      await select(page,['A02']);await page.locator('[data-action="checkout"]').click();await page.locator('#checkout-form').waitFor();await assertPerson(page,'UI-CHECK-010');
      assert.equal(await page.inputValue('#pickup'),item.pickupPoints[1]);assert.match(await page.locator('[data-checkout-total]').innerText(),/300\.000/);assert.equal(await page.isChecked('#checkout-form [name="consent"]'),false);
    });

    await check('UI-CHECK-011','A changed promotion cannot silently charge more than the reviewed total',async page => {
      const item=await trip(),p=await promo();await checkout(page,item);const value=await fill(page,'UI-CHECK-011');await applyPromo(page,p);await page.check('#checkout-form [name="consent"]');
      assert.match(await page.locator('[data-checkout-total]').innerText(),/125\.000/);
      await json(await staff.request.patch(base+'/api/admin/promotions/'+p.code,{data:{value:20}}));
      const rejected=page.waitForResponse(response => new URL(response.url()).pathname === '/api/bookings' && response.request().method()==='POST');await page.click('#book-button');
      assert.equal((await json(await rejected,409)).code,'PRICE_CHANGED');await page.locator('#checkout-review-notice').waitFor();
      assert.equal(await bookings(value.email),0);await assertPerson(page,'UI-CHECK-011');assert.equal(await page.isChecked('#checkout-form [name="consent"]'),false);
      assert.equal(await page.locator('#coupon-feedback.coupon-success').count(),0);await applyPromo(page,p);assert.match(await page.locator('[data-checkout-total]').innerText(),/200\.000/);
      await page.check('#checkout-form [name="consent"]');const accepted=page.waitForResponse(response => new URL(response.url()).pathname === '/api/bookings' && response.request().method()==='POST');await page.click('#book-button');
      assert.equal((await json(await accepted,201)).booking.total,200000);await page.locator('.receipt-code').waitFor();assert.equal(await bookings(value.email),1);
    });

    await check('UI-CHECK-012','Logout clears typed and uncertain passenger data before a different account checks out',async page => {
      const alice=await customer('ALICE-012'),bob=await customer('BOB-012');
      await login(page,alice);await checkout(page,await trip());await fill(page,'PRIVATE-ALICE-NORMAL');await logout(page);
      await login(page,bob);await checkout(page,await trip());await assertDefaults(page,bob);
      await logout(page);await login(page,alice);await checkout(page,await trip());const privateValue=await fill(page,'PRIVATE-ALICE-UNCERTAIN');
      let committed;
      const handler=async route => {const response=await route.fetch();committed=await json(response,201);await route.abort('failed');};
      await page.route('**/api/bookings',handler);
      try {
        await page.click('#book-button');await page.waitForFunction(() => document.getElementById('checkout-error')?.textContent.includes('Giữ nguyên thông tin'));
        assert.equal(await bookings(privateValue.email),1);assert.ok(committed.booking.code);
        assert.ok(await page.evaluate(() => sessionStorage.getItem('ticket4t_checkout_attempt')),'An uncertain checkout must first be recoverable for its owner');
      } finally {await page.unroute('**/api/bookings',handler);}
      await logout(page);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('ticket4t_checkout_attempt')),null,'Logout removes the private uncertain request');
      const saved=await draft(page);assert.equal(saved?.passenger,undefined,'Logout removes the normal passenger cache');
      await login(page,bob);await checkout(page,await trip());await assertDefaults(page,bob);
      assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE-ALICE/);
      await fill(page,'PRIVATE-BOB-CROSS-TAB');
      const otherTab=await page.context().newPage();
      try {
        await logout(otherTab);await login(otherTab,alice);
        await page.reload();await page.goto(base+'/#/account');await page.locator('.profile-card').waitFor();
        assert.ok((await page.locator('.profile-head').innerText()).includes(alice.email));
        assert.equal((await draft(page))?.passenger,undefined,'Reload after another tab changed accounts removes the prior passenger cache');
        await checkout(page,await trip());await assertDefaults(page,alice);
        assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE-BOB/);
      } finally {await otherTab.close();}
    });

    await check('UI-CHECK-013','A late checkout reply after account switching cannot change the new account draft or payment contact',async page => {
      const alice=await customer('ALICE-013'),bob=await customer('BOB-013'),old=await trip(),current=await trip();
      await login(page,alice);await checkout(page,old);const privateValue=await fill(page,'PRIVATE-ALICE-DELAYED');
      let release,intercept,complete,oldBooking;
      const gate=new Promise(resolve => {release=resolve;}),intercepted=new Promise(resolve => {intercept=resolve;}),completed=new Promise(resolve => {complete=resolve;});
      const handler=async route => {
        const response=await route.fetch(),data=await json(response,201);oldBooking=data.booking;intercept();await gate;
        // The booking is committed locally. This reply exercises the online-payment
        // continuation branch with a local URL, without configuring a merchant.
        try {await route.fulfill({status:201,json:{...data,booking:{...data.booking,paymentMethod:'vnpay'},paymentUrl:base+'/fixture-late-payment'}});}
        finally {complete();}
      };
      await page.route('**/api/bookings',handler);
      try {
        await page.click('#book-button');await intercepted;assert.equal(await bookings(privateValue.email),1);
        await logout(page);await login(page,bob);await checkout(page,current);await assertDefaults(page,bob);await fill(page,'CURRENT-BOB-DRAFT');const saved=await draft(page);
        const received=page.waitForResponse(response => new URL(response.url()).pathname==='/api/bookings'&&response.request().method()==='POST');
        release();await completed;await(await received).finished();await frame(page);
        assert.equal(new URL(page.url()).hash,'#/checkout','A prior account response must not navigate the current account');
        const after=await draft(page);assert.equal(after.legs[0].tripId,current.id);assert.equal(after.legs[0].hold.token,saved.legs[0].hold.token);
        await assertPerson(page,'CURRENT-BOB-DRAFT');assert.ok(await heldRow(saved.legs[0].hold));
        assert.equal(await page.evaluate(() => sessionStorage.getItem('ticket4t_payment_return')),null,'A late old reply cannot restore private payment lookup contact');
        assert.equal(await page.evaluate(() => sessionStorage.getItem('ticket4t_checkout_attempt')),null);
        assert.ok(!(await page.locator('body').innerText()).includes(oldBooking.code),'No previous account booking code leaks into the new page');
      } finally {release();await page.unroute('**/api/bookings',handler);}
    });

    await check('UI-CHECK-014','A delayed same-trip renewal cannot replace the newer seat selection on the server',async page => {
      const item=await trip();await checkout(page,item);await fill(page,'OLD-SAME-TRIP');await expire(page,[0]);
      let release,intercept,complete,delayed=false;
      const gate=new Promise(resolve => {release=resolve;}),intercepted=new Promise(resolve => {intercept=resolve;}),completed=new Promise(resolve => {complete=resolve;});
      const handler=async route => {
        const request=route.request(),body=request.method()==='POST'?request.postDataJSON():null;
        if(delayed||body?.tripId!==item.id||JSON.stringify(body.seats)!==JSON.stringify(['A01']))return route.continue();
        delayed=true;intercept();await gate;
        // Hold this old request before server dispatch, so its database mutation
        // would otherwise run after the newer A02 selection has been saved.
        try {await route.fulfill({response:await route.fetch()});}
        finally {complete();}
      };
      await page.route('**/api/holds',handler);
      try {
        await page.locator('[data-action="renew-holds"]').click();await intercepted;
        await page.locator('.summary-card a[href^="#/trip/"]').click();await page.locator('[data-label="A01"]').waitFor();
        if(await page.locator('[data-label="A01"]').getAttribute('aria-pressed')==='true')await page.locator('[data-label="A01"]').click();
        await select(page,['A02']);await page.locator('[data-action="checkout"]').click();await page.locator('#checkout-form').waitFor();
        await fill(page,'NEW-SAME-TRIP');const saved=await draft(page);assert.deepEqual(saved.legs[0].seats,['A02']);
        const received=page.waitForResponse(response => new URL(response.url()).pathname==='/api/holds'&&response.request().method()==='POST'&&response.request().postDataJSON().seats.includes('A01'));
        release();await completed;assert.equal((await json(await received,409)).code,'HOLD_CHANGED');await frame(page);
        const after=await draft(page);assert.deepEqual(after.legs[0].seats,['A02']);assert.equal(after.legs[0].hold.token,saved.legs[0].hold.token);await assertPerson(page,'NEW-SAME-TRIP');
        assert.equal(await heldCount(item),1);assert.ok(await heldRow(saved.legs[0].hold));
        const data=await json(await page.context().request.get(base+'/api/trips/'+item.id)),fresh=data.trip||data;
        assert.equal(fresh.seats.find(seat=>seat.label==='A02').ownHold,true,'The newer A02 reservation remains live on the server');
        assert.equal(fresh.seats.find(seat=>seat.label==='A01').status,'available','The delayed old request must not reserve A01');
      } finally {release();await page.unroute('**/api/holds',handler);}
    });

    await check('UI-CHECK-015','A committed renewal with a lost reply can be retried and booked without orphaned holds',async page => {
      const item=await trip();await checkout(page,item);const value=await fill(page,'UI-CHECK-015');await expire(page,[0]);
      let first=true,reviewed=false,committed;const anchors=[];
      const handler=async route => {
        const request=route.request();if(request.method()!=='POST')return route.continue();
        anchors.push(request.postDataJSON().expectedHoldToken);
        if(!first){
          if(!reviewed){reviewed=true;return route.fulfill({status:409,json:{code:'TRIP_CHANGED',error:'Điều kiện chuyến đã thay đổi. Vui lòng kiểm tra lại.'}});}
          return route.continue();
        }
        first=false;
        const response=await route.fetch();committed=await json(response,201);await route.abort('failed');
      };
      await page.route('**/api/holds',handler);
      try {
        await page.locator('[data-action="renew-holds"]').click();await page.locator('#toast-region .toast.error').last().waitFor();
        assert.ok(committed?.hold);assert.equal(await heldCount(item),1,'The lost reply follows a successful server-side renewal');
        await assertPerson(page,'UI-CHECK-015');assert.ok(await page.locator('#book-button').isDisabled());
        await page.reload();await page.locator('#checkout-form').waitFor();await page.locator('[data-action="renew-holds"]').waitFor({state:'visible'});await assertPerson(page,'UI-CHECK-015');
        await page.check('#checkout-form [name="consent"]');
        const changed=page.waitForResponse(response => new URL(response.url()).pathname==='/api/holds'&&response.request().method()==='POST');
        await page.locator('[data-action="renew-holds"]').click();assert.equal((await json(await changed,409)).code,'TRIP_CHANGED');
        await page.locator('#checkout-review-notice').waitFor();assert.equal(await page.isChecked('#checkout-form [name="consent"]'),false);await assertPerson(page,'UI-CHECK-015');
        assert.equal(await heldCount(item),1,'A terms review must not discard the already committed unknown hold');
        const accepted=page.waitForResponse(response => new URL(response.url()).pathname==='/api/holds'&&response.request().method()==='POST');
        await page.locator('[data-action="renew-holds"]').click();await json(await accepted,201);
        await page.waitForFunction(() => !document.querySelector('#book-button').disabled);
        assert.equal(anchors.length,3);assert.equal(typeof anchors[0],'string');assert.ok(anchors.every(anchor=>anchor===anchors[0]),'An uncertain renewal keeps its original retry identity across reload and a terms review');
        assert.equal(await heldCount(item),1,'Retry must leave exactly one active hold');
        const saved=await draft(page);assert.ok(await heldRow(saved.legs[0].hold));await assertPerson(page,'UI-CHECK-015');
        const data=await json(await page.context().request.get(base+'/api/trips/'+item.id)),fresh=data.trip||data;
        assert.equal(fresh.seats.find(seat=>seat.label==='A01').ownHold,true);
        assert.equal(await page.inputValue('#pickup'),item.pickupPoints[1]);assert.equal(await page.inputValue('#dropoff'),item.dropoffPoints[1]);
        await page.check('#checkout-form [name="consent"]');
        const booked=page.waitForResponse(response => new URL(response.url()).pathname==='/api/bookings'&&response.request().method()==='POST');
        await page.click('#book-button');await json(await booked,201);await page.locator('.receipt-code').waitFor();
        assert.equal(await bookings(value.email),1);assert.equal(await heldCount(item),0,'The final booking consumes its only hold');
      } finally {await page.unroute('**/api/holds',handler);}
    });

    assert.deepEqual(errors,[],'Checkout flows must not raise browser exceptions or CSP errors');
    if(failures.length)throw new AggregateError(failures.map(message => new Error(message)),passed+'/15 checkout browser scenarios passed');
    console.log('Checkout browser passed: '+passed+'/15 scenarios; fare and terms review, lost hold and renewal replies, expiry/renewal compensation, route and same-trip races, data retention, changed promotion consent and account privacy.');
  } catch(error){testFailure=error;throw error;}
  finally {await Promise.allSettled(contexts.map(context => context.close()));await cleanupBrowserTest({browser,server,runtime,dataDir,prefix},testFailure);}
})().catch(error => {console.error(error);process.exitCode=1;});
