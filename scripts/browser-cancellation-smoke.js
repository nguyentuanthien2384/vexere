'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const {createApp}=require('../index');
const {addDays}=require('../server/catalog');
const {cleanupBrowserTest}=require('./browser-test-helpers');

(async()=>{
  const prefix='ticket4t-browser-cancellation-',dataDir=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  const env={NODE_ENV:'test',SEED_DEMO:'false',SESSION_SECRET:'cancellation-browser-isolated-session-'.repeat(3),ADMIN_EMAIL:'cancellation-admin@example.test',ADMIN_PASSWORD:'CancellationAdmin@12345'};
  const contexts=[],errors=[],failures=[],screenshots=path.resolve('artifacts/screenshots');
  let runtime,server,browser,staff,base,operator,today,sequence=0,passed=0,testFailure;
  async function json(response,status=200){const value=await response.json();assert.equal(response.status(),status,JSON.stringify(value));return value;}
  async function frame(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function deadline(promise,label){let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),15000);})]);}finally{clearTimeout(timer);}}
  function cancellation(response,code){return new URL(response.url()).pathname==='/api/bookings/'+code+'/cancel'&&response.request().method()==='POST';}
  async function check(id,title,work){
    if(process.env.UI_CANCEL_CASE&&!id.endsWith(process.env.UI_CANCEL_CASE))return;
    const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);const page=await context.newPage();page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to|Uncaught/i.test(message.text()))errors.push(message.text());});
    try{await work(page,context);passed++;console.log('PASS ['+id+'] '+title);}
    catch(error){failures.push('['+id+'] '+title+': '+error.message);console.error('FAIL ['+id+'] '+title+'\n'+error.stack);await page.screenshot({path:path.join(screenshots,'cancellation-failure-'+id.toLowerCase()+'.png'),fullPage:true,animations:'disabled'}).catch(()=>{});}
    finally{await context.close();}
  }
  async function trip(){return (await json(await staff.request.post(base+'/api/admin/trips',{data:{operatorId:operator.id,from:'ho-chi-minh',to:'da-lat',date:addDays(today,3+sequence++),departureTime:'08:00',type:'limousine',price:250000,totalSeats:9,durationMinutes:360,pickupPoints:['Điểm đón kiểm thử hủy vé'],dropoffPoints:['Điểm trả kiểm thử hủy vé'],provenance:'Kho ghế cục bộ kiểm thử hủy có xác nhận'}}),201)).trip;}
  async function booking(context,id){const item=await trip();return (await json(await context.request.post(base+'/api/bookings',{data:{tripId:item.id,seats:['A01'],pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0],fullName:'Hành khách '+id,phone:'0912345678',email:id.toLowerCase()+'@example.test',paymentMethod:'cash'}}),201)).booking;}
  async function lookup(context,item){return (await json(await context.request.get(base+'/api/bookings/lookup?'+new URLSearchParams({code:item.code,phone:item.phone})))).booking;}
  async function open(page,item){await page.goto(base+'/#/booking/'+item.code+'?'+new URLSearchParams({phone:item.phone}));await page.locator('.receipt-code').waitFor();assert.equal((await page.locator('.receipt-code').innerText()).trim(),item.code);}
  async function modal(page){await page.locator('[data-action="cancel-booking"]').click();await page.locator('#modal-confirm').waitFor();}
  async function mutations(item,event='cancelled'){return Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM booking_events WHERE booking_code=? AND event=?',[item.code,event])).n);}
  async function seats(item){return Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM reserved_seats WHERE booking_code=?',[item.code])).n);}
  async function customer(id){const context=await browser.newContext();contexts.push(context);const user={fullName:'Tài khoản '+id,email:id.toLowerCase()+'@example.test',phone:id.startsWith('BOB')?'0987654321':'0901234567',password:'CancellationCustomer@12345'};try{await json(await context.request.post(base+'/api/auth/register',{data:user}),201);return user;}finally{await context.close();}}
  async function login(page,user){await page.goto(base+'/#/login');await page.locator('#auth-form').waitFor();await page.fill('#auth-email',user.email);await page.fill('#auth-password',user.password);await page.locator('#auth-form [type="submit"]').click();await page.locator('.profile-card').waitFor();assert.ok((await page.locator('.profile-head').innerText()).includes(user.email));}
  async function logout(page){await page.goto(base+'/#/account');await page.locator('[data-action="logout"]').click();await page.waitForURL(url=>url.hash==='#/');await page.waitForFunction(()=>!document.querySelector('[data-action="logout"]'));}
  async function adminLogin(page){await page.goto(base+'/admin');await page.locator('#login-form').waitFor({state:'visible'});await page.fill('#login-form [name="email"]',env.ADMIN_EMAIL);await page.fill('#login-form [name="password"]',env.ADMIN_PASSWORD);await page.locator('#login-form [type="submit"]').click();await page.locator('#portal').waitFor({state:'visible'});await page.locator('.stats-grid').first().waitFor();}
  async function adminGo(page,name){await page.evaluate(name=>{location.hash=name;},name);await page.waitForFunction(name=>location.hash==='#'+name&&document.querySelector('#sidebar [data-page="'+name+'"]')?.classList.contains('active'),name);await page.locator('#filters').waitFor();await page.locator('#content .loading').waitFor({state:'hidden'});}
  async function adminBooking(page,item){await adminGo(page,'bookings');await page.fill('#filters [name="q"]',item.code);const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/bookings'&&new URL(response.url()).searchParams.get('q')===item.code);await page.locator('#filters [type="submit"]').click();await json(await response);await page.locator('[data-action="booking-detail"][data-id="'+item.code+'"]').waitFor();}
  async function adminModal(page,item){await page.locator('[data-action="cancel-booking"][data-id="'+item.code+'"]').click();await page.locator('#confirm-dialog').waitFor({state:'visible'});}
  function adminCancellation(response,item){return new URL(response.url()).pathname==='/api/admin/bookings/'+item.code&&response.request().method()==='PATCH';}
  async function delayedReply(page,item,{admin=false}={}){
    let release,intercept,complete,error,count=0;
    const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
    const pattern=admin ? '**/api/admin/bookings/'+item.code : '**/api/bookings/'+item.code+'/cancel';
    const handler=async route=>{try{count++;const response=await route.fetch();await json(response);intercept();await gate;await route.fulfill({response});}catch(failure){error=failure;intercept();}finally{complete();}};
    await page.route(pattern,handler);
    return {intercepted,get count(){return count;},async finish(){release();await deadline(completed,'Delayed cancellation response');if(error)throw error;},async close(){release();await deadline(completed,'Cancellation route cleanup').catch(()=>{});await page.unroute(pattern,handler);}};
  }
  try{
    await fs.mkdir(screenshots,{recursive:true});runtime=await createApp({env,dataDir,seedDemo:false,disableRateLimit:true});server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=env.APP_URL='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});staff=await browser.newContext();contexts.push(staff);
    await json(await staff.request.post(base+'/api/auth/login',{data:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}));({today}=await json(await staff.request.get(base+'/api/bootstrap')));operator=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe kiểm thử xác nhận hủy',phone:'0901234567'}}),201)).operator;

    await check('UI-CANCEL-001','Manual cancellation reviews exact booking details, fits mobile and sends the viewed source version',async(page,context)=>{
      const item=await booking(context,'UI-CANCEL-001'),source=await lookup(context,item);await open(page,item);await page.setViewportSize({width:390,height:844});await modal(page);await frame(page);
      const text=await page.locator('.modal-box').innerText();assert.ok(text.includes(item.code));assert.ok(text.includes('A01'));assert.match(text,/250\.000/);
      const bounds=await page.locator('.modal-box').boundingBox();assert.ok(bounds&&bounds.x>=-1&&bounds.x+bounds.width<=391);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.keyboard.press('Escape');assert.equal(await page.locator('#modal-confirm').count(),0);assert.equal((await lookup(context,item)).status,'reserved');assert.equal(await mutations(item),0);
      await modal(page);await page.click('#modal-cancel');assert.equal((await lookup(context,item)).status,'reserved');
      await modal(page);const response=page.waitForResponse(value=>cancellation(value,item.code));await page.click('#modal-confirm');const result=await response;assert.equal((await json(result)).booking.status,'cancelled');
      assert.equal(result.request().postDataJSON().expectedSourceVersion,source.rescheduleVersion);assert.equal(result.request().postDataJSON().phone,item.phone);await page.waitForFunction(()=>!document.querySelector('[data-action="cancel-booking"]'));assert.equal(await mutations(item),1);assert.equal(await seats(item),0);
    });

    await check('UI-CANCEL-002','Navigating to another booking dismisses old consent and a retained confirmation cannot cancel either booking',async(page,context)=>{
      const old=await booking(context,'UI-CANCEL-002-A'),current=await booking(context,'UI-CANCEL-002-B');await open(page,old);let count=0;const handler=async route=>{count++;await route.continue();};await page.route('**/api/bookings/*/cancel',handler);
      try{await modal(page);await page.evaluate(()=>{window.oldCancellationConfirm=document.getElementById('modal-confirm');});await page.locator('body').evaluate((body,hash)=>{location.hash=hash;},'#/booking/'+current.code+'?'+new URLSearchParams({phone:current.phone}));await page.waitForFunction(code=>document.querySelector('.receipt-code')?.textContent===code,current.code);assert.equal(await page.locator('#modal-confirm').count(),0);await page.evaluate(()=>window.oldCancellationConfirm.click());await frame(page);assert.equal(count,0);assert.equal((await lookup(context,old)).status,'reserved');assert.equal((await lookup(context,current)).status,'reserved');assert.equal(await mutations(old),0);assert.equal(await mutations(current),0);}
      finally{await page.unroute('**/api/bookings/*/cancel',handler);}
    });

    await check('UI-CANCEL-003','A cross-tab account switch invalidates old consent before any cancellation POST',async(page,context)=>{
      const alice=await customer('ALICE-CANCEL-003'),bob=await customer('BOB-CANCEL-003');await login(page,alice);const item=await booking(context,'PRIVATE-CANCEL-003');await open(page,item);await modal(page);
      await json(await context.request.post(base+'/api/auth/login',{data:{email:bob.email,password:bob.password}}));let count=0;const handler=async route=>{count++;await route.continue();};await page.route('**/api/bookings/'+item.code+'/cancel',handler);
      try{const identity=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/me');await page.click('#modal-confirm');assert.equal((await json(await identity)).user.email,bob.email);await page.locator('#lookup-form').waitFor();assert.equal(new URL(page.url()).hash,'#/tickets');assert.equal(await page.locator('#modal-confirm').count(),0);assert.equal(await page.locator('.receipt-code').count(),0);assert.ok(!(await page.locator('body').innerText()).includes(item.code));await page.goto(base+'/#/account');await page.locator('.profile-card').waitFor();assert.ok((await page.locator('.profile-head').innerText()).includes(bob.email));assert.equal(count,0);assert.equal((await lookup(context,item)).status,'reserved');assert.equal(await mutations(item),0);}
      finally{await page.unroute('**/api/bookings/'+item.code+'/cancel',handler);}
    });

    await check('UI-CANCEL-004','A newly recorded cash receipt rejects stale cancellation and requires fresh paid-state consent',async(page,context)=>{
      const item=await booking(context,'UI-CANCEL-004');await open(page,item);await modal(page);await json(await staff.request.post(base+'/api/admin/bookings/'+item.code+'/cash-receipt',{data:{reference:'UI-CANCEL-CASH-'+item.code,amount:item.total}}));
      const rejected=page.waitForResponse(response=>cancellation(response,item.code));await page.click('#modal-confirm');assert.equal((await json(await rejected,409)).code,'BOOKING_CHANGED');await page.locator('#cancellation-review-notice').waitFor();assert.equal((await lookup(context,item)).paymentStatus,'paid');assert.equal(await seats(item),1);assert.equal(await mutations(item,'refund_requested'),0);assert.equal(await page.locator('#modal-confirm').count(),0);
      await modal(page);assert.match(await page.locator('.modal-box').innerText(),/Vé đã thu tiền/);const accepted=page.waitForResponse(response=>cancellation(response,item.code));await page.click('#modal-confirm');assert.equal((await json(await accepted)).booking.status,'refund_pending');await page.waitForFunction(()=>!document.querySelector('[data-action="cancel-booking"]'));assert.equal(await mutations(item,'refund_requested'),1);assert.equal(await seats(item),0);
    });

    await check('UI-CANCEL-005','Delayed committed replies cannot restore an old booking after navigation or a new account booking',async(page,context)=>{
      for(const accountChange of [false,true]){
        const alice=accountChange?await customer('ALICE-CANCEL-005'):null,bob=accountChange?await customer('BOB-CANCEL-005'):null;if(alice)await login(page,alice);
        const old=await booking(context,accountChange?'PRIVATE-CANCEL-005-ACCOUNT':'UI-CANCEL-005-ROUTE');await open(page,old);await modal(page);const delayed=await delayedReply(page,old);
        try{await page.click('#modal-confirm');await deadline(delayed.intercepted,'Committed cancellation');if(accountChange){await logout(page);await login(page,bob);}const current=await booking(context,accountChange?'CURRENT-BOB-CANCEL-005':'CURRENT-CANCEL-005');await open(page,current);const hash=new URL(page.url()).hash;const received=page.waitForResponse(response=>cancellation(response,old.code));await delayed.finish();await(await received).finished();await frame(page);assert.equal(new URL(page.url()).hash,hash);assert.equal((await page.locator('.receipt-code').innerText()).trim(),current.code);assert.ok(!(await page.locator('body').innerText()).includes(old.code));assert.equal((await lookup(context,current)).status,'reserved');assert.equal(await mutations(old),1);assert.equal(delayed.count,1);}
        finally{await delayed.close();}
      }
    });

    await check('UI-CANCEL-006','Duplicate confirmation events and another cancel click while pending issue one POST and one mutation',async(page,context)=>{
      const item=await booking(context,'UI-CANCEL-006');await open(page,item);await modal(page);const delayed=await delayedReply(page,item);
      try{await page.evaluate(()=>{const yes=document.getElementById('modal-confirm');yes.click();yes.click();});await deadline(delayed.intercepted,'Double cancellation');await page.evaluate(()=>{const button=document.querySelector('[data-action="cancel-booking"]');button.disabled=false;button.click();});await frame(page);assert.equal(delayed.count,1);assert.equal(await page.locator('#modal-confirm').count(),0);const received=page.waitForResponse(response=>cancellation(response,item.code));await delayed.finish();await(await received).finished();await page.waitForFunction(()=>!document.querySelector('[data-action="cancel-booking"]'));assert.equal(await mutations(item),1);assert.equal(await seats(item),0);}
      finally{await delayed.close();}
    });

    await check('UI-CANCEL-007','A lost committed reply performs a read-only lookup of current cancellation without resubmitting',async(page,context)=>{
      const item=await booking(context,'UI-CANCEL-007');await open(page,item);await modal(page);let count=0;const pattern='**/api/bookings/'+item.code+'/cancel';const handler=async route=>{count++;const response=await route.fetch();assert.equal((await json(response)).booking.status,'cancelled');await route.abort('failed');};await page.route(pattern,handler);
      try{await page.click('#modal-confirm');await page.locator('#cancellation-review-notice').waitFor();assert.equal(count,1);assert.equal(await page.locator('[data-action="cancel-booking"]').count(),0);assert.equal((await page.locator('.receipt-code').innerText()).trim(),item.code);assert.equal((await lookup(context,item)).status,'cancelled');assert.equal(await mutations(item),1);assert.equal(await seats(item),0);}
      finally{await page.unroute(pattern,handler);}
    });

    await check('UI-CANCEL-008','Staff cancellation refreshes changed payment state and requires a new manual confirmation',async(page,context)=>{
      const item=await booking(context,'UI-CANCEL-008');await adminLogin(page);await adminBooking(page,item);await adminModal(page,item);let count=0;const pattern='**/api/admin/bookings/'+item.code;const recorder=async route=>{count++;await route.continue();};await page.route(pattern,recorder);
      try{await json(await staff.request.post(base+'/api/admin/bookings/'+item.code+'/cash-receipt',{data:{reference:'UI-ADMIN-CANCEL-CASH-'+item.code,amount:item.total}}));const rejected=page.waitForResponse(response=>adminCancellation(response,item));await page.click('#confirm-submit');assert.equal((await json(await rejected,409)).code,'BOOKING_CHANGED');await page.locator('#confirm-dialog').waitFor({state:'hidden'});await page.locator('#toast-stack').filter({hasText:/Vé đã thay đổi/}).waitFor();await page.locator('[data-action="booking-detail"][data-id="'+item.code+'"]').waitFor();await frame(page);assert.equal(count,1);assert.equal(await mutations(item,'refund_requested'),0);assert.equal(await seats(item),1);
        const current=await lookup(context,item);await adminModal(page,item);assert.match(await page.locator('#confirm-message').innerText(),/Đã thanh toán|Đã thu tiền/);const accepted=page.waitForResponse(response=>adminCancellation(response,item));await page.click('#confirm-submit');const response=await accepted;assert.equal((await json(response)).booking.status,'refund_pending');assert.equal(response.request().postDataJSON().expectedSourceVersion,current.rescheduleVersion);await page.locator('#confirm-dialog').waitFor({state:'hidden'});assert.equal(count,2);assert.equal(await mutations(item,'refund_requested'),1);assert.equal(await seats(item),0);}
      finally{await page.unroute(pattern,recorder);}
    });

    await check('UI-CANCEL-009','Leaving the staff booking list dismisses old confirmation and makes its retained callback inert',async(page,context)=>{
      const item=await booking(context,'UI-CANCEL-009');await adminLogin(page);await adminBooking(page,item);await adminModal(page,item);await page.evaluate(()=>{window.oldStaffCancellation=document.getElementById('confirm-submit').onclick;});let count=0;const pattern='**/api/admin/bookings/'+item.code;const recorder=async route=>{count++;await route.continue();};await page.route(pattern,recorder);
      try{await adminGo(page,'trips');await page.locator('#confirm-dialog').waitFor({state:'hidden'});await page.evaluate(()=>window.oldStaffCancellation());await frame(page);assert.equal(count,0);assert.equal(new URL(page.url()).hash,'#trips');assert.equal((await lookup(context,item)).status,'reserved');assert.equal(await mutations(item),0);}
      finally{await page.unroute(pattern,recorder);}
    });

    await check('UI-CANCEL-010','A delayed staff cancellation reply cannot leave a newer route or overwrite its trip editor',async(page,context)=>{
      const item=await booking(context,'UI-CANCEL-010');await adminLogin(page);await adminBooking(page,item);await adminModal(page,item);const delayed=await delayedReply(page,item,{admin:true});
      try{await page.click('#confirm-submit');await deadline(delayed.intercepted,'Committed staff cancellation');await adminGo(page,'trips');await page.locator('#confirm-dialog').waitFor({state:'hidden'});await page.locator('[data-action="new-trip"]').click();await page.locator('#editor-dialog').waitFor({state:'visible'});await page.fill('#editor-form [name="provenance"]','Bản nháp mới sau hủy cần giữ');const title=await page.locator('#editor-title').innerText();const received=page.waitForResponse(response=>adminCancellation(response,item));await delayed.finish();await(await received).finished();await frame(page);assert.equal(new URL(page.url()).hash,'#trips');assert.equal(await page.locator('#editor-title').innerText(),title);assert.equal(await page.inputValue('#editor-form [name="provenance"]'),'Bản nháp mới sau hủy cần giữ');assert.ok(await page.locator('#editor-dialog').isVisible());assert.equal(await mutations(item),1);assert.equal(await seats(item),0);assert.ok(!(await page.locator('#toast-stack').innerText()).includes('Đã xử lý hủy đơn vé'));}
      finally{await delayed.close();}
    });

    await check('UI-CANCEL-011','An account changed during error recovery is rechecked before applying the old lookup result',async(page,context)=>{
      const alice=await customer('ALICE-CANCEL-011'),bob=await customer('BOB-CANCEL-011');await login(page,alice);const item=await booking(context,'PRIVATE-CANCEL-011');await open(page,item);await modal(page);await json(await staff.request.post(base+'/api/admin/bookings/'+item.code+'/cash-receipt',{data:{reference:'UI-CANCEL-LOOKUP-CASH-'+item.code,amount:item.total}}));
      let release,intercept,complete,routeFailure,count=0,lookups=0;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
      const pattern='**/api/bookings/lookup?**',handler=async route=>{
        if(new URL(route.request().url()).searchParams.get('code')!==item.code||lookups++)return route.continue();
        try{const response=await route.fetch();assert.equal((await json(response)).booking.paymentStatus,'paid');intercept();await gate;await route.fulfill({response});}catch(error){routeFailure=error;intercept();}finally{complete();}
      };
      const cancelPattern='**/api/bookings/'+item.code+'/cancel',recorder=async route=>{count++;await route.continue();};await page.route(pattern,handler);await page.route(cancelPattern,recorder);
      try{const rejected=page.waitForResponse(response=>cancellation(response,item.code));await page.click('#modal-confirm');assert.equal((await json(await rejected,409)).code,'BOOKING_CHANGED');await deadline(intercepted,'Cancellation recovery lookup');assert.ifError(routeFailure);await json(await context.request.post(base+'/api/auth/login',{data:{email:bob.email,password:bob.password}}));const identity=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/me');release();await deadline(completed,'Cancellation recovery lookup reply');assert.ifError(routeFailure);assert.equal((await json(await identity)).user.email,bob.email);await page.locator('#lookup-form').waitFor();assert.equal(new URL(page.url()).hash,'#/tickets');assert.equal(await page.locator('.receipt-code').count(),0);assert.equal(await page.locator('#cancellation-review-notice').count(),0,'The old recovery result must not be applied to the changed account');assert.ok(!(await page.locator('body').innerText()).includes(item.code));assert.equal(count,1);await page.goto(base+'/#/account');await page.locator('.profile-card').waitFor();assert.ok((await page.locator('.profile-head').innerText()).includes(bob.email));assert.equal((await lookup(context,item)).paymentStatus,'paid');assert.equal(await mutations(item,'refund_requested'),0);assert.equal(await seats(item),1);}
      finally{release();await deadline(completed,'Recovery lookup cleanup').catch(()=>{});await page.unroute(pattern,handler);await page.unroute(cancelPattern,recorder);}
    });

    assert.deepEqual(errors,[],'Cancellation flows must not raise browser exceptions or CSP errors');if(failures.length)throw new AggregateError(failures.map(message=>new Error(message)),passed+'/11 cancellation browser scenarios passed');console.log('Cancellation browser passed: '+passed+'/11 scenarios; manual review, source version, account and route guards, changed payment, duplicate prevention and lost-reply recovery for customers and staff.');
  }catch(error){testFailure=error;throw error;}
  finally{await Promise.allSettled(contexts.map(context=>context.close()));await cleanupBrowserTest({browser,server,runtime,dataDir,prefix},testFailure);}
})().catch(error=>{console.error(error);process.exitCode=1;});
