'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const {createApp}=require('../index');
const {addDays}=require('../server/catalog');
const {cleanupBrowserTest}=require('./browser-test-helpers');

// All inventory, sessions and writes use an isolated local managed database.
(async()=>{
  const prefix='ticket4t-browser-reschedule-',dataDir=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  const screenshots=path.resolve('artifacts/screenshots');
  const env={NODE_ENV:'test',SEED_DEMO:'false',SESSION_SECRET:'reschedule-browser-session-fixture-'.repeat(3),ADMIN_EMAIL:'reschedule-admin@example.test',ADMIN_PASSWORD:'RescheduleAdmin@12345'};
  const failures=[],errors=[],contexts=[];
  let runtime,server,browser,staff,base,operator,today,testFailure,passed=0,sequence=0;
  const hash=token=>crypto.createHash('sha256').update(token).digest('hex');
  async function json(response,status=200){const data=await response.json();assert.equal(response.status(),status,JSON.stringify(data));return data;}
  async function freshPage(){
    const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);
    const page=await context.newPage();page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to|Uncaught/i.test(message.text()))errors.push(message.text());});
    return {page,context};
  }
  async function check(id,title,work){
    const {page,context}=await freshPage();
    try{await work(page,context);passed++;console.log('PASS ['+id+'] '+title);}
    catch(error){failures.push('['+id+'] '+title+': '+error.message);console.error('FAIL ['+id+'] '+title+'\n'+error.stack);await page.screenshot({path:path.join(screenshots,'reschedule-failure-'+id.toLowerCase()+'.png'),fullPage:true,animations:'disabled'}).catch(()=>{});}
    finally{await context.close();}
  }
  async function deadline(promise,label){
    let timeout;
    try{return await Promise.race([promise,new Promise((resolve,reject)=>{timeout=setTimeout(()=>reject(new Error(label+' timed out')),15000);})]);}
    finally{clearTimeout(timeout);}
  }
  async function trip(extra={}){
    sequence++;
    return (await json(await staff.request.post(base+'/api/admin/trips',{data:{operatorId:operator.id,from:'ho-chi-minh',to:'da-lat',date:addDays(today,3+sequence),departureTime:'08:00',type:'limousine',price:250000,totalSeats:9,durationMinutes:360,pickupPoints:['Bến xe thử nghiệm','Văn phòng thử nghiệm'],dropoffPoints:['Bến xe Đà Lạt thử nghiệm','Văn phòng Đà Lạt thử nghiệm'],provenance:'Kho ghế cục bộ kiểm thử đổi chuyến',...extra}}),201)).trip;
  }
  function person(id){return {fullName:'Hành khách '+id,phone:'0912345678',email:id.toLowerCase()+'@example.test',paymentMethod:'cash'};}
  function leg(item,seats=['A01']){return {tripId:item.id,seats,pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0]};}
  async function booking(context,item,id){return (await json(await context.request.post(base+'/api/bookings',{data:{...person(id),...leg(item)}}),201)).booking;}
  async function fixture(context,id){const original=await trip(),target=await trip(),saved=await booking(context,original,id);return {original,target,booking:saved};}
  async function lookup(context,item){return (await json(await context.request.get(base+'/api/bookings/lookup?'+new URLSearchParams({code:item.code,phone:item.phone})))).booking;}
  async function draft(page){return page.evaluate(()=>JSON.parse(sessionStorage.getItem('ticket4t_checkout')||'null'));}
  async function historyCount(item){return Number((await runtime.api.db.get("SELECT COUNT(*) AS n FROM booking_events WHERE booking_code=? AND event='rescheduled'",[item.code])).n);}
  async function heldCount(item){return Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM seat_holds WHERE trip_id=?',[item.id])).n);}
  async function heldRow(hold){return runtime.api.db.get('SELECT trip_id FROM seat_holds WHERE hash=?',[hash(hold.token)]);}
  async function begin(page,item,target,seats=['A02']){
    await page.goto(base+'/#/reschedule/'+item.code+'?'+new URLSearchParams({phone:item.phone,date:target.date}));await page.locator('#reschedule-search-form').waitFor();
    await page.locator('.trip-card-price .btn[href*="'+target.id+'"]').click();await page.locator('[data-action="seat"][data-label="'+seats[0]+'"]:enabled').waitFor();
    for(const label of seats)await page.locator('[data-action="seat"][data-label="'+label+'"]:enabled').click();
    await page.locator('[data-action="checkout"]').click();await page.locator('#reschedule-confirm-form').waitFor();
    await page.locator('#change-pickup').selectOption({index:1});await page.locator('#change-dropoff').selectOption({index:1});await page.check('#reschedule-confirm-form input[type="checkbox"]');
    return draft(page);
  }
  function isReschedule(response,code){return new URL(response.url()).pathname==='/api/bookings/'+code+'/reschedule'&&response.request().method()==='POST';}
  async function frame(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function correctTargetFixture(item,changes){
    // Simulate an out-of-band source correction; normal admin edits protect held inventory.
    await runtime.api.db.transaction(async tx=>{
      const row=await tx.get('SELECT data FROM trips WHERE id=?',[item.id]),corrected={...JSON.parse(row.data),...changes};
      await tx.run('UPDATE trips SET departure_time=?,departure_at=?,data=? WHERE id=?',[corrected.departureTime,new Date(corrected.date+'T'+corrected.departureTime+':00+07:00').toISOString(),JSON.stringify(corrected),item.id]);
    });
  }
  async function expireTarget(page,{client=false}={}){
    const saved=await draft(page),expiry=new Date(Date.now()-60000).toISOString();
    await runtime.api.db.transaction(tx=>tx.run('UPDATE seat_holds SET expires_at=? WHERE hash=?',[expiry,hash(saved.legs[0].hold.token)]));
    if(client)await expireCachedHold(page,expiry);
    return saved;
  }
  async function expireCachedHold(page,expiry=new Date(Date.now()-60000).toISOString()){
    await page.evaluate(expiry=>{
      for(const key of ['ticket4t_checkout','ticket4t_reschedule_attempt']){
        const value=JSON.parse(sessionStorage.getItem(key)||'null');if(!value)continue;
        for(const leg of value.legs||[value.leg].filter(Boolean))if(leg.hold)leg.hold.expiresAt=expiry;
        if(value.hold)value.hold.expiresAt=expiry;sessionStorage.setItem(key,JSON.stringify(value));
      }
    },expiry);
  }
  async function ordinaryCheckout(page,item,id){
    await page.goto(base+'/#/trip/'+item.id);await page.locator('[data-action="seat"][data-label="A03"]:enabled').waitFor();await page.locator('[data-action="seat"][data-label="A03"]').click();
    await page.locator('[data-action="checkout"]').click();await page.locator('#checkout-form').waitFor();
    for(const key of ['fullName','phone','email'])await page.fill('#'+key,person(id)[key]);return draft(page);
  }
  async function customer(id){
    const context=await browser.newContext();contexts.push(context);const user={fullName:'Tài khoản '+id,email:id.toLowerCase()+'@example.test',phone:id.startsWith('BOB')?'0987654321':'0901234567',password:'RescheduleCustomer@12345'};
    try{await json(await context.request.post(base+'/api/auth/register',{data:user}),201);return user;}finally{await context.close();}
  }
  async function login(page,user){
    await page.goto(base+'/#/login');await page.locator('#auth-form').waitFor();await page.fill('#auth-email',user.email);await page.fill('#auth-password',user.password);await page.locator('#auth-form [type="submit"]').click();await page.locator('.profile-card').waitFor();assert.ok((await page.locator('.profile-head').innerText()).includes(user.email));
  }
  async function logout(page){await page.goto(base+'/#/account');await page.locator('[data-action="logout"]').click();await page.waitForURL(url=>url.hash==='#/');await page.waitForFunction(()=>!document.querySelector('[data-action="logout"]'));}
  async function assertPrivacyCleared(page){
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('ticket4t_reschedule_attempt')),null,'The prior account uncertain request is private');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('ticket4t_reschedule')),null,'The prior booking contact cache is private');
  }
  async function loseReply(page,item){
    const requests=[];let committed;
    const handler=async route=>{requests.push({body:route.request().postData(),key:route.request().headers()['idempotency-key']});const response=await route.fetch();committed=await json(response);await route.abort('failed');};
    await page.route('**/api/bookings/'+item.code+'/reschedule',handler);
    try{await page.click('#book-button');await page.waitForFunction(()=>Boolean(document.getElementById('reschedule-error')?.textContent));assert.ok(committed?.booking);return {request:requests[0],booking:committed.booking};}
    finally{await page.unroute('**/api/bookings/'+item.code+'/reschedule',handler);}
  }

  try{
    await fs.mkdir(screenshots,{recursive:true});runtime=await createApp({env,dataDir,seedDemo:false,disableRateLimit:true});
    server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=env.APP_URL='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});staff=await browser.newContext();contexts.push(staff);
    await json(await staff.request.post(base+'/api/auth/login',{data:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}));({today}=await json(await staff.request.get(base+'/api/bootstrap')));
    operator=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe kiểm thử đổi chuyến',phone:'0901234567'}}),201)).operator;

    await check('UI-RSCH-001','A lost committed reschedule reply is recovered after reload with the exact request and key',async(page,context)=>{
      const f=await fixture(context,'UI-RSCH-001');await begin(page,f.booking,f.target);
      let first=true,committed;const requests=[];
      const handler=async route=>{
        requests.push({body:route.request().postData(),key:route.request().headers()['idempotency-key']});
        if(!first)return route.continue();first=false;const response=await route.fetch();committed=await json(response);await route.abort('failed');
      };
      await page.route('**/api/bookings/'+f.booking.code+'/reschedule',handler);
      try{
        await page.click('#book-button');await page.waitForFunction(()=>Boolean(document.getElementById('reschedule-error')?.textContent));assert.equal(committed.booking.tripId,f.target.id);assert.equal(await historyCount(f.booking),1);
        const nullableSource=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('ticket4t_reschedule_attempt')));assert.equal(nullableSource.booking.expiresAt,null,'Cash source bookings legitimately have no payment expiry');assert.ok(Number.isFinite(Date.parse(nullableSource.leg.hold.expiresAt)),'Replacement holds retain their separate expiry');
        await expireCachedHold(page);await page.reload();await page.locator('#reschedule-confirm-form').waitFor();await page.locator('#reschedule-recovery-notice').waitFor();
        await page.setViewportSize({width:390,height:844});await frame(page);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Recovery form must fit a mobile viewport');
        for(const selector of ['#reschedule-recovery-notice','#change-pickup','#change-dropoff','#reschedule-restore-request','#book-button']){
          const bounds=await page.locator(selector).boundingBox();assert.ok(bounds&&bounds.width>0&&bounds.x>=-1&&bounds.x+bounds.width<=391,selector+' must fit the mobile viewport');
        }
        await page.setViewportSize({width:1440,height:1000});await frame(page);
        const originalRequest=JSON.parse(requests[0].body),storedAttempt=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('ticket4t_reschedule_attempt')));
        await page.selectOption('#change-pickup',{index:0});await page.selectOption('#change-dropoff',{index:0});await page.check('#reschedule-confirm-form [name="consent"]');await page.click('#book-button');
        await page.waitForFunction(()=>document.getElementById('reschedule-error')?.textContent.includes('khôi phục'));await frame(page);assert.equal(requests.length,1,'Edited recovery must not send a replacement request');assert.equal(await historyCount(f.booking),1);
        const blockedAttempt=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('ticket4t_reschedule_attempt')));assert.equal(blockedAttempt.key,storedAttempt.key);assert.equal(blockedAttempt.body,storedAttempt.body);
        await page.click('#reschedule-restore-request');await page.waitForFunction(points=>document.getElementById('change-pickup')?.value===points.pickup&&document.getElementById('change-dropoff')?.value===points.dropoff,originalRequest);
        assert.equal(await page.isChecked('#reschedule-confirm-form [name="consent"]'),false,'Restoring an uncertain request still requires manual consent');await page.check('#reschedule-confirm-form [name="consent"]');
        const retry=page.waitForResponse(response=>isReschedule(response,f.booking.code));await page.click('#book-button');const result=await json(await retry);await page.locator('.receipt-code').waitFor();
        assert.equal(result.booking.tripId,f.target.id);assert.equal(requests.length,2);assert.ok(requests[0].key);assert.deepEqual(requests[1],requests[0]);
        assert.equal(await historyCount(f.booking),1);assert.equal((await lookup(context,f.booking)).previousTrips.length,1);assert.equal(await heldCount(f.target),0);
      }finally{await page.unroute('**/api/bookings/'+f.booking.code+'/reschedule',handler);}
    });

    await check('UI-RSCH-002','Two simultaneous confirmation submits create only one reschedule',async(page,context)=>{
      const f=await fixture(context,'UI-RSCH-002');await begin(page,f.booking,f.target);
      let release,intercept,complete,count=0;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
      const handler=async route=>{count++;const response=await route.fetch();intercept();await gate;try{await route.fulfill({response});}finally{complete();}};
      await page.route('**/api/bookings/'+f.booking.code+'/reschedule',handler);
      try{
        await page.evaluate(()=>{const form=document.getElementById('reschedule-confirm-form');form.requestSubmit();form.requestSubmit();});await deadline(intercepted,'Concurrent submit request');await frame(page);assert.equal(count,1);
        release();await deadline(completed,'Concurrent submit response');await page.locator('.receipt-code').waitFor();assert.equal(await historyCount(f.booking),1);assert.equal((await lookup(context,f.booking)).previousTrips.length,1);assert.equal(await heldCount(f.target),0);
      }finally{release();await page.unroute('**/api/bookings/'+f.booking.code+'/reschedule',handler);}
    });

    await check('UI-RSCH-003','A booking moved elsewhere before confirmation requires fresh source review and consent',async(page,context)=>{
      const f=await fixture(context,'UI-RSCH-003'),elsewhere=await trip({departureTime:'13:00'});await begin(page,f.booking,f.target);
      await json(await staff.request.post(base+'/api/admin/bookings/'+f.booking.code+'/reschedule',{data:leg(elsewhere,['A04'])}));
      const rejected=page.waitForResponse(response=>isReschedule(response,f.booking.code));await page.click('#book-button');assert.equal((await json(await rejected,409)).code,'BOOKING_CHANGED');
      await page.locator('#reschedule-review-notice').waitFor();assert.match(await page.locator('.reschedule-comparison').innerText(),/13:00/);assert.equal(await page.isChecked('#reschedule-confirm-form [name="consent"]'),false);
      assert.equal(await historyCount(f.booking),1);assert.equal((await lookup(context,f.booking)).tripId,elsewhere.id);
      await page.check('#reschedule-confirm-form [name="consent"]');const accepted=page.waitForResponse(response=>isReschedule(response,f.booking.code));await page.click('#book-button');assert.equal((await json(await accepted)).booking.tripId,f.target.id);await page.locator('.receipt-code').waitFor();assert.equal(await historyCount(f.booking),2);
      const reloaded=await fixture(context,'UI-RSCH-003-RELOAD'),changed=await trip({departureTime:'14:00'});const originalDraft=await begin(page,reloaded.booking,reloaded.target);
      await json(await staff.request.post(base+'/api/admin/bookings/'+reloaded.booking.code+'/reschedule',{data:leg(changed,['A05'])}));await page.reload();await page.locator('#reschedule-review-notice').waitFor();
      assert.match(await page.locator('.reschedule-comparison').innerText(),/14:00/);assert.equal(await page.isChecked('#reschedule-confirm-form [name="consent"]'),false);
      const currentSource=await lookup(context,reloaded.booking);assert.equal(await page.getAttribute('#reschedule-confirm-form','data-source-version'),currentSource.rescheduleVersion);assert.equal((await draft(page)).legs[0].hold.token,originalDraft.legs[0].hold.token);assert.equal(await historyCount(reloaded.booking),1);
      const refreshed=page.waitForResponse(response=>isReschedule(response,reloaded.booking.code));await page.check('#reschedule-confirm-form [name="consent"]');await page.click('#book-button');const response=await refreshed,moved=await json(response);
      assert.equal(response.request().postDataJSON().expectedSourceVersion,currentSource.rescheduleVersion);assert.equal(moved.booking.tripId,reloaded.target.id);await page.locator('.receipt-code').waitFor();assert.equal(await historyCount(reloaded.booking),2);
      const cancelled=await fixture(context,'UI-RSCH-003-CANCELLED');await begin(page,cancelled.booking,cancelled.target);await json(await context.request.post(base+'/api/bookings/'+cancelled.booking.code+'/cancel',{data:{phone:cancelled.booking.phone}}));
      await page.reload();await page.locator('#reschedule-review-notice').waitFor();const sourceCard=await page.locator('.reschedule-comparison > div').first().innerText();assert.match(sourceCard,/Đã hủy/);assert.match(sourceCard,/Chưa thanh toán/);assert.equal(await page.isChecked('#reschedule-confirm-form [name="consent"]'),false);assert.equal(await historyCount(cancelled.booking),0);
    });

    await check('UI-RSCH-004','Changed target schedule and removed stops are refreshed before manual reconfirmation',async(page,context)=>{
      const f=await fixture(context,'UI-RSCH-004');await begin(page,f.booking,f.target);
      const correction={departureTime:'11:00',pickupPoints:['Điểm đón mới đã xác nhận'],dropoffPoints:['Điểm trả mới đã xác nhận']};
      assert.equal((await json(await staff.request.patch(base+'/api/admin/trips/'+f.target.id,{data:correction}),409)).code,'HAS_BOOKINGS');
      await correctTargetFixture(f.target,correction);
      const rejected=page.waitForResponse(response=>isReschedule(response,f.booking.code));await page.click('#book-button');assert.equal((await json(await rejected,409)).code,'TRIP_CHANGED');
      await page.locator('#reschedule-review-notice').waitFor();assert.match(await page.locator('.reschedule-comparison').innerText(),/11:00/);assert.equal(await page.isChecked('#reschedule-confirm-form [name="consent"]'),false);
      assert.equal(await page.locator('#change-pickup option').count(),1);assert.equal(await page.locator('#change-dropoff option').count(),1);assert.equal(await historyCount(f.booking),0);
      await page.selectOption('#change-pickup','Điểm đón mới đã xác nhận');await page.selectOption('#change-dropoff','Điểm trả mới đã xác nhận');await page.check('#reschedule-confirm-form [name="consent"]');
      const accepted=page.waitForResponse(response=>isReschedule(response,f.booking.code));await page.click('#book-button');const moved=(await json(await accepted)).booking;assert.equal(moved.trip.departureTime,'11:00');assert.equal(moved.pickup,'Điểm đón mới đã xác nhận');assert.equal(moved.dropoff,'Điểm trả mới đã xác nhận');await page.locator('.receipt-code').waitFor();
    });

    await check('UI-RSCH-005','Expired replacement holds block fresh submits and preserve the original booking',async(page,context)=>{
      const f=await fixture(context,'UI-RSCH-005-SERVER');await begin(page,f.booking,f.target);await expireTarget(page);
      const rejected=page.waitForResponse(response=>isReschedule(response,f.booking.code));await page.click('#book-button');assert.equal((await json(await rejected,409)).code,'HOLD_EXPIRED');
      await page.locator('#reschedule-expired-notice').waitFor();assert.ok(await page.locator('#book-button').isDisabled());assert.equal((await lookup(context,f.booking)).tripId,f.original.id);assert.equal(await historyCount(f.booking),0);
      const local=await fixture(context,'UI-RSCH-005-CLIENT');await begin(page,local.booking,local.target);await expireCachedHold(page);await page.reload();await page.locator('#reschedule-expired-notice').waitFor();assert.ok(await page.locator('#book-button').isDisabled());
      let count=0;const handler=async route=>{count++;await route.continue();};await page.route('**/api/bookings/'+local.booking.code+'/reschedule',handler);
      try{await page.check('#reschedule-confirm-form [name="consent"]');await page.evaluate(()=>document.getElementById('reschedule-confirm-form').requestSubmit());await frame(page);assert.equal(count,0);assert.equal((await lookup(context,local.booking)).tripId,local.original.id);assert.equal(await historyCount(local.booking),0);}
      finally{await page.unroute('**/api/bookings/'+local.booking.code+'/reschedule',handler);}
    });

    await check('UI-RSCH-006','A delayed reschedule result cannot navigate away from or wipe a newer checkout',async(page,context)=>{
      const f=await fixture(context,'UI-RSCH-006'),current=await trip();await begin(page,f.booking,f.target);
      let release,intercept,complete;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
      const handler=async route=>{const response=await route.fetch();await json(response);intercept();await gate;try{await route.fulfill({response});}finally{complete();}};
      await page.route('**/api/bookings/'+f.booking.code+'/reschedule',handler);
      try{
        await page.click('#book-button');await deadline(intercepted,'Delayed route request');const saved=await ordinaryCheckout(page,current,'CURRENT-RSCH-006');
        const received=page.waitForResponse(response=>isReschedule(response,f.booking.code));release();await deadline(completed,'Delayed route response');await(await received).finished();await frame(page);
        assert.equal(new URL(page.url()).hash,'#/checkout');const after=await draft(page);assert.equal(after.legs[0].tripId,current.id);assert.equal(after.legs[0].hold.token,saved.legs[0].hold.token);assert.ok(await heldRow(saved.legs[0].hold));assert.equal(await page.inputValue('#fullName'),person('CURRENT-RSCH-006').fullName);assert.equal(await historyCount(f.booking),1);
      }finally{release();await page.unroute('**/api/bookings/'+f.booking.code+'/reschedule',handler);}
    });

    await check('UI-RSCH-007','Logout and cross-tab account changes remove cached booking contact and uncertain reschedule requests',async(page,context)=>{
      const alice=await customer('ALICE-RSCH-007'),bob=await customer('BOB-RSCH-007');await login(page,alice);const normal=await fixture(context,'PRIVATE-RSCH-007-NORMAL');await begin(page,normal.booking,normal.target);await logout(page);await assertPrivacyCleared(page);
      await login(page,bob);await ordinaryCheckout(page,await trip(),'BOB-RSCH-007');assert.equal(await page.locator('#reschedule-recovery-notice').count(),0);
      await logout(page);await login(page,alice);const uncertain=await fixture(context,'PRIVATE-RSCH-007-UNCERTAIN');await begin(page,uncertain.booking,uncertain.target);await loseReply(page,uncertain.booking);
      assert.ok(await page.evaluate(()=>sessionStorage.getItem('ticket4t_reschedule_attempt')));await logout(page);await assertPrivacyCleared(page);await login(page,bob);
      await page.goto(base+'/#/tickets');await page.locator('#lookup-form').waitFor();assert.equal(await page.inputValue('#lookup-phone'),bob.phone);assert.ok(!(await page.locator('body').innerText()).includes(uncertain.booking.code));
      await logout(page);await login(page,alice);const cross=await fixture(context,'PRIVATE-RSCH-007-CROSS');await begin(page,cross.booking,cross.target);await loseReply(page,cross.booking);await page.goto(base+'/#/account');await page.locator('.profile-card').waitFor();
      const sibling=await context.newPage();
      try{await logout(sibling);await login(sibling,bob);await page.reload();await page.locator('.profile-card').waitFor();assert.ok((await page.locator('.profile-head').innerText()).includes(bob.email));await assertPrivacyCleared(page);}
      finally{await sibling.close();}
    });

    await check('UI-RSCH-008','A replacement selected for one booking cannot confirm a different booking',async(page,context)=>{
      const first=await fixture(context,'UI-RSCH-008-A'),other=await fixture(context,'UI-RSCH-008-B');const saved=await begin(page,first.booking,first.target);
      await page.goto(base+'/#/reschedule/'+other.booking.code+'?'+new URLSearchParams({phone:other.booking.phone,confirm:'1'}));
      await page.locator('#reschedule-search-form').waitFor();assert.equal(await page.locator('#reschedule-confirm-form').count(),0);
      assert.equal((await lookup(context,other.booking)).tripId,other.original.id);assert.equal(await historyCount(other.booking),0);assert.ok(await heldRow(saved.legs[0].hold),'An unrelated booking must not consume the existing replacement hold');
      const cached=await fixture(context,'UI-RSCH-008-CACHE'),selected=await begin(page,cached.booking,cached.target),source=await lookup(context,cached.booking),targetLeg=selected.legs[0];
      const request={tripId:targetLeg.tripId,seats:targetLeg.seats,pickup:targetLeg.trip.pickupPoints[1],dropoff:targetLeg.trip.dropoffPoints[1],phone:source.phone,holdToken:targetLeg.hold.token,expectedBookingVersion:targetLeg.trip.bookingVersion,expectedSourceVersion:source.rescheduleVersion};
      const template={key:crypto.randomUUID(),code:source.code,path:'/api/bookings/'+encodeURIComponent(source.code)+'/reschedule',body:JSON.stringify(request),booking:source,leg:targetLeg,createdAt:Date.now()},posted=[];
      const mutations=[attempt=>{attempt.body='{}';},attempt=>{attempt.booking.trip=null;},attempt=>{attempt.leg.seats=['A03'];},attempt=>{attempt.booking.expiresAt='not-a-date';}];
      const handler=async route=>{posted.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});await route.continue();};await page.route('**/api/bookings/'+source.code+'/reschedule',handler);
      try{
        for(const mutate of mutations){
          const malformed=JSON.parse(JSON.stringify(template));mutate(malformed);await page.evaluate(value=>sessionStorage.setItem('ticket4t_reschedule_attempt',JSON.stringify(value)),malformed);await page.reload();await page.locator('#reschedule-confirm-form').waitFor();await frame(page);
          assert.equal(await page.locator('#reschedule-recovery-notice').count(),0,'Malformed cached recovery must be discarded');assert.equal(await page.evaluate(()=>sessionStorage.getItem('ticket4t_reschedule_attempt')),null);assert.equal(posted.length,0,'Restoring a malformed cache must not post a request');assert.equal(await page.isChecked('#reschedule-confirm-form [name="consent"]'),false);assert.equal((await draft(page)).legs[0].hold.token,targetLeg.hold.token);
        }
        const accepted=page.waitForResponse(response=>isReschedule(response,source.code));await page.check('#reschedule-confirm-form [name="consent"]');await page.click('#book-button');assert.equal((await json(await accepted)).booking.tripId,cached.target.id);await page.locator('.receipt-code').waitFor();
        assert.equal(posted.length,1);assert.notEqual(posted[0].key,template.key);assert.equal(posted[0].body.tripId,cached.target.id);assert.deepEqual(posted[0].body.seats,['A02']);assert.equal(posted[0].body.holdToken,targetLeg.hold.token);assert.equal(posted[0].body.expectedSourceVersion,source.rescheduleVersion);assert.equal(await historyCount(source),1);
      }finally{await page.unroute('**/api/bookings/'+source.code+'/reschedule',handler);}
    });

    await check('UI-RSCH-009','An uncertain reschedule replay shows the current cancelled booking',async(page,context)=>{
      const f=await fixture(context,'UI-RSCH-009');await begin(page,f.booking,f.target);const lost=await loseReply(page,f.booking);
      await json(await context.request.post(base+'/api/bookings/'+f.booking.code+'/cancel',{data:{phone:f.booking.phone}}));
      await page.reload();await page.locator('#reschedule-recovery-notice').waitFor();await page.check('#reschedule-confirm-form [name="consent"]');
      const received=page.waitForResponse(response=>isReschedule(response,f.booking.code));await page.click('#book-button');const response=await received,result=await json(response);assert.equal(response.request().postData(),lost.request.body);assert.equal(response.request().headers()['idempotency-key'],lost.request.key);
      assert.equal(result.booking.status,'cancelled');await page.locator('.receipt-code').waitFor();assert.match(await page.locator('.receipt-main').innerText(),/Đã hủy/);assert.equal(await historyCount(f.booking),1);assert.equal(await heldCount(f.target),0);
    });

    await check('UI-RSCH-010','An uncertain earlier request replay shows a later moved booking without moving it again',async(page,context)=>{
      const f=await fixture(context,'UI-RSCH-010'),later=await trip({departureTime:'15:00'});await begin(page,f.booking,f.target);const lost=await loseReply(page,f.booking);
      await json(await staff.request.post(base+'/api/admin/bookings/'+f.booking.code+'/reschedule',{data:leg(later,['A04'])}));
      await page.reload();await page.locator('#reschedule-recovery-notice').waitFor();await page.check('#reschedule-confirm-form [name="consent"]');
      const received=page.waitForResponse(response=>isReschedule(response,f.booking.code));await page.click('#book-button');const response=await received,result=await json(response);assert.equal(response.request().postData(),lost.request.body);assert.equal(response.request().headers()['idempotency-key'],lost.request.key);
      assert.equal(result.booking.tripId,later.id);assert.deepEqual(result.booking.seats,['A04']);await page.locator('.receipt-code').waitFor();assert.match(await page.locator('.receipt-main').innerText(),/15:00/);assert.equal(await historyCount(f.booking),2);assert.equal((await lookup(context,f.booking)).previousTrips.length,2);
    });

    await check('UI-RSCH-011','A previous account delayed reschedule result cannot affect the new account draft',async(page,context)=>{
      const alice=await customer('ALICE-RSCH-011'),bob=await customer('BOB-RSCH-011');await login(page,alice);const f=await fixture(context,'PRIVATE-RSCH-011'),current=await trip();await begin(page,f.booking,f.target);
      let release,intercept,complete;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
      const handler=async route=>{const response=await route.fetch();await json(response);intercept();await gate;try{await route.fulfill({response});}finally{complete();}};
      await page.route('**/api/bookings/'+f.booking.code+'/reschedule',handler);
      try{
        await page.click('#book-button');await deadline(intercepted,'Delayed account request');await logout(page);await login(page,bob);const saved=await ordinaryCheckout(page,current,'CURRENT-BOB-RSCH-011');
        const received=page.waitForResponse(response=>isReschedule(response,f.booking.code));release();await deadline(completed,'Delayed account response');await(await received).finished();await frame(page);
        assert.equal(new URL(page.url()).hash,'#/checkout');assert.equal((await draft(page)).legs[0].hold.token,saved.legs[0].hold.token);assert.ok(await heldRow(saved.legs[0].hold));assert.equal(await page.inputValue('#fullName'),person('CURRENT-BOB-RSCH-011').fullName);await assertPrivacyCleared(page);
        assert.ok(!(await page.locator('body').innerText()).includes(f.booking.code));assert.equal(await historyCount(f.booking),1);
      }finally{release();await page.unroute('**/api/bookings/'+f.booking.code+'/reschedule',handler);}
    });

    assert.deepEqual(errors,[],'Reschedule flows must not raise browser exceptions or CSP errors');
    if(failures.length)throw new AggregateError(failures.map(message=>new Error(message)),passed+'/11 reschedule browser scenarios passed');
    console.log('Reschedule browser passed: '+passed+'/11 scenarios; exact uncertain recovery, duplicate submits, source and target review, expiry, route and identity races, privacy and current-state replay.');
  }catch(error){testFailure=error;throw error;}
  finally{await Promise.allSettled(contexts.map(context=>context.close()));await cleanupBrowserTest({browser,server,runtime,dataDir,prefix},testFailure);}
})().catch(error=>{console.error(error);process.exitCode=1;});
