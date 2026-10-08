'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const {createApp}=require('../index');
const {addDays}=require('../server/catalog');
const {cleanupBrowserTest}=require('./browser-test-helpers');

// Credentials, bookings and inventory are local fixtures in an isolated database.
(async()=>{
  const prefix='ticket4t-browser-admin-reschedule-',dataDir=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  const screenshots=path.resolve('artifacts/screenshots');
  const env={NODE_ENV:'test',SEED_DEMO:'false',SESSION_SECRET:'admin-reschedule-browser-fixture-'.repeat(3),ADMIN_EMAIL:'admin-reschedule@example.test',ADMIN_PASSWORD:'AdminReschedule@12345'};
  const cacheKey='ticket4t_admin_reschedule_attempt',failures=[],errors=[],contexts=[];
  const selected=process.env.UI_ADMIN_RSCH_CASE;
  let runtime,server,browser,staff,base,operator,otherOperator,today,testFailure,passed=0,executed=0,sequence=0;
  async function json(response,status=200){const data=await response.json();assert.equal(response.status(),status,JSON.stringify(data));return data;}
  async function frame(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function deadline(promise,label){let timeout;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timeout=setTimeout(()=>reject(new Error(label+' timed out')),15000);})]);}finally{clearTimeout(timeout);}}
  async function check(id,title,work){
    if(selected&&!id.endsWith(selected))return;
    executed++;const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);const page=await context.newPage();page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(id+': '+error.message));
    page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to|Uncaught/i.test(message.text()))errors.push(id+': '+message.text());});
    try{await work(page,context);passed++;console.log('PASS ['+id+'] '+title);}
    catch(error){failures.push('['+id+'] '+title+': '+error.message);console.error('FAIL ['+id+'] '+title+'\n'+error.stack);await page.screenshot({path:path.join(screenshots,'admin-reschedule-failure-'+id.toLowerCase()+'.png'),fullPage:true,animations:'disabled'}).catch(()=>{});}
    finally{await context.close();}
  }
  async function trip(extra={}){
    sequence++;return (await json(await staff.request.post(base+'/api/admin/trips',{data:{operatorId:operator.id,from:'ho-chi-minh',to:'da-lat',date:addDays(today,3),departureTime:'08:00',type:'limousine',price:250000,totalSeats:9,durationMinutes:360,pickupPoints:['Bến xe thử nghiệm','Văn phòng thử nghiệm'],dropoffPoints:['Bến xe Đà Lạt thử nghiệm','Văn phòng Đà Lạt thử nghiệm'],provenance:'Kho ghế cục bộ kiểm thử đổi chuyến vận hành '+sequence,...extra}}),201)).trip;
  }
  function leg(item,seats=['A02']){return {tripId:item.id,seats,pickup:item.pickupPoints[1],dropoff:item.dropoffPoints[1]};}
  async function fixture(context,id){
    const original=await trip(),target=await trip();const saved=(await json(await context.request.post(base+'/api/bookings',{data:{tripId:original.id,seats:['A01'],fullName:'Hành khách riêng '+id,phone:'0912345678',email:id.toLowerCase()+'@example.test',pickup:original.pickupPoints[0],dropoff:original.dropoffPoints[0],paymentMethod:'cash'}}),201)).booking;
    return {original,target,booking:saved};
  }
  async function account(id,operatorId=operator.id){return (await json(await staff.request.post(base+'/api/admin/users',{data:{fullName:'Nhân viên '+id,email:id.toLowerCase()+'@example.test',phone:'0901234567',password:'OperatorReschedule@12345',role:'operator',operatorId}}),201)).user;}
  async function login(page,user){
    await page.goto(base+'/admin');await page.locator('#login-form').waitFor({state:'visible'});await page.fill('#login-form [name="email"]',user?.email||env.ADMIN_EMAIL);await page.fill('#login-form [name="password"]',user?'OperatorReschedule@12345':env.ADMIN_PASSWORD);
    await page.locator('#login-form [type="submit"]').click();await page.locator('#portal').waitFor({state:'visible'});await page.locator('.stats-grid').first().waitFor();
  }
  async function go(page,name){
    await page.evaluate(name=>{location.hash=name;},name);await page.waitForFunction(name=>location.hash==='#'+name&&document.querySelector('#sidebar [data-page="'+name+'"]')?.classList.contains('active'),name);
    await page.locator('#filters').waitFor();await page.locator('#content .loading').waitFor({state:'hidden'});
  }
  async function findBooking(page,item){
    await go(page,'bookings');await page.fill('#filters [name="q"]',item.code);const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/bookings'&&new URL(response.url()).searchParams.get('q')===item.code);
    await page.locator('#filters [type="submit"]').click();await json(await response);await page.locator('[data-action="booking-detail"][data-id="'+item.code+'"]').waitFor();
  }
  async function confirm(page){const input=page.locator('#editor-form [name="rescheduleConfirmed"]');if(await input.count())await input.check();}
  async function begin(page,item,target,user){
    await login(page,user);await findBooking(page,item);await page.locator('[data-action="reschedule-booking"][data-id="'+item.code+'"]').click();await page.locator('#editor-dialog').waitFor({state:'visible'});
    await page.locator('#editor-form [name="tripId"]:enabled').waitFor();await page.selectOption('#editor-form [name="tripId"]',target.id);await page.locator('[data-action="toggle-reschedule-seat"][data-seat="A02"]:enabled').waitFor();
    await page.locator('[data-action="toggle-reschedule-seat"][data-seat="A02"]').click();await page.selectOption('#editor-form [name="pickup"]',{index:1});await page.selectOption('#editor-form [name="dropoff"]',{index:1});await confirm(page);
  }
  async function lookup(item){const data=await json(await staff.request.get(base+'/api/admin/bookings?'+new URLSearchParams({code:item.code})));assert.equal(data.bookings.length,1);return data.bookings[0];}
  async function historyCount(item){return Number((await runtime.api.db.get("SELECT COUNT(*) AS n FROM booking_events WHERE booking_code=? AND event='rescheduled'",[item.code])).n);}
  async function auditCount(item){return Number((await runtime.api.db.get("SELECT COUNT(*) AS n FROM admin_audit_events WHERE entity_id=? AND action='booking_rescheduled'",[item.code])).n);}
  async function cache(page){return page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'null'),cacheKey);}
  async function assertCacheCleared(page){assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),cacheKey),null,'Prior account passenger and request cache must be removed');}
  function isReschedule(response,item){return new URL(response.url()).pathname==='/api/admin/bookings/'+item.code+'/reschedule'&&response.request().method()==='POST';}
  function snapshot(route){return {body:route.request().postData(),key:route.request().headers()['idempotency-key']};}
  async function loseReply(page,item){
    let committed,request;const handler=async route=>{request=snapshot(route);const response=await route.fetch();committed=await json(response);await route.abort('failed');};
    await page.route('**/api/admin/bookings/'+item.code+'/reschedule',handler);
    try{await page.locator('#editor-form [type="submit"]').click();await page.locator('#editor-error').filter({hasText:/\S/}).waitFor();assert.ok(committed?.booking);return {request,booking:committed.booking};}
    finally{await page.unroute('**/api/admin/bookings/'+item.code+'/reschedule',handler);}
  }
  async function resume(page){
    await page.locator('#admin-reschedule-pending').waitFor();await page.locator('[data-action="resume-reschedule-request"]').click();await page.locator('#admin-reschedule-recovery-notice').waitFor();await page.locator('#editor-dialog').waitFor({state:'visible'});
  }
  async function retry(page,item,status=200){const response=page.waitForResponse(response=>isReschedule(response,item));await confirm(page);await page.locator('#editor-form [type="submit"]').click();const received=await response;return {response:received,data:await json(received,status)};}
  async function done(page,item){await page.waitForFunction(code=>document.getElementById('editor-title')?.textContent==='Đơn '+code&&document.getElementById('editor-dialog')?.open,item.code);await page.locator('#editor-fields .detail-list').waitFor();assert.ok(await page.locator('#editor-form [type="submit"]').isHidden(),'Completed reschedule must display the current booking details');}
  async function currentRow(page,item){await done(page,item);await page.locator('#editor-dialog [data-close-dialog]').first().click();await page.locator('#editor-dialog').waitFor({state:'hidden'});await findBooking(page,item);return page.locator('[data-action="booking-detail"][data-id="'+item.code+'"]').locator('xpath=ancestor::tr');}

  try{
    await fs.mkdir(screenshots,{recursive:true});runtime=await createApp({env,dataDir,seedDemo:false,disableRateLimit:true});server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=env.APP_URL='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});staff=await browser.newContext();contexts.push(staff);await json(await staff.request.post(base+'/api/auth/login',{data:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}));({today}=await json(await staff.request.get(base+'/api/bootstrap')));
    operator=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe QA đổi chuyến vận hành',phone:'0901234567'}}),201)).operator;otherOperator=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe QA tài khoản khác',phone:'0901111222'}}),201)).operator;

    await check('UI-ADMIN-RSCH-001','Lost committed response survives reload and replays the exact request after manual mobile recovery',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-001');await begin(page,f.booking,f.target);const lost=await loseReply(page,f.booking);
      assert.ok(lost.request.key,'Staff reschedule must send an idempotency key');const body=JSON.parse(lost.request.body);assert.match(body.expectedSourceVersion,/^[a-f0-9]{64}$/);assert.match(body.expectedBookingVersion,/^[a-f0-9]{64}$/);assert.equal(body.phone,undefined);assert.equal(body.holdToken,undefined);
      assert.equal(await historyCount(f.booking),1);assert.equal(await auditCount(f.booking),1);const saved=await cache(page);assert.equal(JSON.stringify(saved.body),lost.request.body);assert.equal(saved.key,lost.request.key);
      await page.reload();await resume(page);assert.equal(await page.isChecked('#editor-form [name="rescheduleConfirmed"]'),false);await page.setViewportSize({width:390,height:844});await frame(page);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Recovery layout must fit mobile');for(const selector of ['#admin-reschedule-recovery-notice','#editor-form [name="pickup"]','#editor-form [name="dropoff"]','[data-action="restore-reschedule-request"]','#editor-form [type="submit"]']){const box=await page.locator(selector).boundingBox();assert.ok(box&&box.width>0&&box.x>=-1&&box.x+box.width<=391,selector+' must fit mobile');}
      await page.setViewportSize({width:1440,height:1000});await frame(page);const requests=[];const recorder=route=>{requests.push(snapshot(route));return route.continue();};await page.route('**/api/admin/bookings/'+f.booking.code+'/reschedule',recorder);
      try{
        await page.evaluate(()=>{document.querySelector('#editor-form [name="pickup"]').value='Bến xe thử nghiệm';});await confirm(page);await page.locator('#editor-form [type="submit"]').click();await page.locator('#editor-error').filter({hasText:/khôi phục|ban đầu|gốc/i}).waitFor();await frame(page);assert.equal(requests.length,0,'Changing an uncertain request must not send a new request');assert.deepEqual(await cache(page),saved);
        await page.locator('[data-action="restore-reschedule-request"]').click();await page.waitForFunction(body=>document.querySelector('#editor-form [name="pickup"]')?.value===body.pickup&&document.querySelector('#editor-form [name="dropoff"]')?.value===body.dropoff,body);assert.equal(await page.isChecked('#editor-form [name="rescheduleConfirmed"]'),false);
        const recovered=await retry(page,f.booking);assert.equal(recovered.response.headers()['idempotency-replayed'],'true');assert.equal(recovered.data.booking.tripId,f.target.id);assert.deepEqual(requests,[lost.request]);await done(page,f.booking);await assertCacheCleared(page);assert.equal(await historyCount(f.booking),1);assert.equal(await auditCount(f.booking),1);
      }finally{await page.unroute('**/api/admin/bookings/'+f.booking.code+'/reschedule',recorder);}
    });

    await check('UI-ADMIN-RSCH-002','Two simultaneous staff submits create one reservation move and one audit event',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-002');await begin(page,f.booking,f.target);let release,intercept,complete,routeFailure,count=0;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
      const handler=async route=>{count++;try{const response=await route.fetch();await json(response);intercept();await gate;await route.fulfill({response});}catch(error){routeFailure=error;intercept();}finally{complete();}};await page.route('**/api/admin/bookings/'+f.booking.code+'/reschedule',handler);
      try{await page.evaluate(()=>{const form=document.getElementById('editor-form');form.requestSubmit();form.requestSubmit();});await deadline(intercepted,'Concurrent staff submit');assert.ifError(routeFailure);await frame(page);assert.equal(count,1);release();await deadline(completed,'Concurrent staff reply');assert.ifError(routeFailure);await done(page,f.booking);assert.equal(await historyCount(f.booking),1);assert.equal(await auditCount(f.booking),1);}
      finally{release();await page.unroute('**/api/admin/bookings/'+f.booking.code+'/reschedule',handler);}
    });

    await check('UI-ADMIN-RSCH-003','A changed original booking requires current source review and new manual consent',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-003'),elsewhere=await trip({departureTime:'13:00'});await begin(page,f.booking,f.target);await json(await staff.request.post(base+'/api/admin/bookings/'+f.booking.code+'/reschedule',{data:leg(elsewhere,['A04'])}));
      const rejected=await retry(page,f.booking,409);assert.equal(rejected.data.code,'BOOKING_CHANGED');await page.locator('#admin-reschedule-review-notice').waitFor();assert.match(await page.locator('#editor-fields').innerText(),/13:00/);assert.equal(await page.isChecked('#editor-form [name="rescheduleConfirmed"]'),false);assert.equal(await historyCount(f.booking),1);await assertCacheCleared(page);
      await page.locator('[data-action="toggle-reschedule-seat"][data-seat="A02"]').waitFor();const button=page.locator('[data-action="toggle-reschedule-seat"][data-seat="A02"]');if(await button.getAttribute('aria-pressed')!=='true')await button.click();const current=await lookup(f.booking),accepted=await retry(page,f.booking);assert.equal(accepted.response.request().postDataJSON().expectedSourceVersion,current.rescheduleVersion);assert.notEqual(accepted.response.request().headers()['idempotency-key'],rejected.response.request().headers()['idempotency-key']);assert.equal(accepted.data.booking.tripId,f.target.id);await done(page,f.booking);assert.equal(await historyCount(f.booking),2);
    });

    await check('UI-ADMIN-RSCH-004','Changed target schedule and stops are refreshed without an automatic reschedule',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-004');await begin(page,f.booking,f.target);const changed={departureTime:'11:00',pickupPoints:['Điểm đón cập nhật'],dropoffPoints:['Điểm trả cập nhật']};await json(await staff.request.patch(base+'/api/admin/trips/'+f.target.id,{data:changed}));let count=0;const recorder=route=>{count++;return route.continue();};await page.route('**/api/admin/bookings/'+f.booking.code+'/reschedule',recorder);
      try{const rejected=await retry(page,f.booking,409);assert.equal(rejected.data.code,'TRIP_CHANGED');await page.locator('#admin-reschedule-review-notice').waitFor();await page.waitForFunction(()=>document.querySelector('#editor-form [name="pickup"]')?.value==='Điểm đón cập nhật');assert.equal(await page.inputValue('#editor-form [name="dropoff"]'),'Điểm trả cập nhật');assert.equal(await page.isChecked('#editor-form [name="rescheduleConfirmed"]'),false);await frame(page);assert.equal(count,1);assert.equal(await historyCount(f.booking),0);await assertCacheCleared(page);
        const seat=page.locator('[data-action="toggle-reschedule-seat"][data-seat="A02"]');if(await seat.getAttribute('aria-pressed')!=='true')await seat.click();const current=(await json(await context.request.get(base+'/api/trips/'+f.target.id))),accepted=await retry(page,f.booking);assert.equal(accepted.response.request().postDataJSON().expectedBookingVersion,current.bookingVersion);assert.equal(accepted.data.booking.trip.departureTime,'11:00');assert.equal(accepted.data.booking.pickup,changed.pickupPoints[0]);await done(page,f.booking);assert.equal(count,2);assert.equal(await historyCount(f.booking),1);
      }finally{await page.unroute('**/api/admin/bookings/'+f.booking.code+'/reschedule',recorder);}
    });

    await check('UI-ADMIN-RSCH-005','A delayed committed reply cannot close or overwrite a newly opened editor',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-005');await begin(page,f.booking,f.target);let release,intercept,complete,routeFailure;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});const handler=async route=>{try{const response=await route.fetch();await json(response);intercept();await gate;await route.fulfill({response});}catch(error){routeFailure=error;intercept();}finally{complete();}};await page.route('**/api/admin/bookings/'+f.booking.code+'/reschedule',handler);
      try{await page.locator('#editor-form [type="submit"]').click();await deadline(intercepted,'Delayed staff commit');assert.ifError(routeFailure);await go(page,'trips');await page.locator('#editor-dialog').waitFor({state:'hidden'});await page.locator('[data-action="new-trip"]').click();await page.fill('#editor-form [name="provenance"]','Bản nháp mới cần giữ lại');const title=await page.locator('#editor-title').innerText();const received=page.waitForResponse(response=>isReschedule(response,f.booking));release();await deadline(completed,'Delayed editor reply');assert.ifError(routeFailure);await(await received).finished();await frame(page);assert.equal(new URL(page.url()).hash,'#trips');assert.equal(await page.locator('#editor-title').innerText(),title);assert.equal(await page.inputValue('#editor-form [name="provenance"]'),'Bản nháp mới cần giữ lại');assert.ok(await page.locator('#editor-dialog').isVisible());assert.equal(await historyCount(f.booking),1);assert.ok(await cache(page),'Detached success remains recoverable by the same owner');assert.ok(!(await page.locator('#toast-stack').innerText()).includes('Đã đổi chuyến'));}
      finally{release();await page.unroute('**/api/admin/bookings/'+f.booking.code+'/reschedule',handler);}
    });

    await check('UI-ADMIN-RSCH-006','Revoked staff permissions clear recovery and passenger data before returning to login',async(page,context)=>{
      const user=await account('OPERATOR-RSCH-006'),f=await fixture(context,'PRIVATE-ADMIN-RSCH-006');await begin(page,f.booking,f.target,user);await json(await staff.request.patch(base+'/api/admin/users/'+user.id,{data:{active:false}}));
      let posts=0;const count=request=>{if(new URL(request.url()).pathname==='/api/admin/bookings/'+f.booking.code+'/reschedule'&&request.method()==='POST')posts++;};page.on('request',count);const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/me');await page.locator('#editor-form [type="submit"]').click();const session=await response;assert.ok([200,401,403].includes(session.status()));await page.locator('#login-screen').waitFor({state:'visible'});await assertCacheCleared(page);assert.ok(await page.locator('#portal').isHidden());assert.equal(await page.locator('#editor-fields').innerText(),'');assert.equal(await page.locator('#content').innerText(),'');assert.ok(!(await page.locator('body').innerText()).includes(f.booking.code));assert.equal(await historyCount(f.booking),0);assert.equal(posts,0,'Revoked access detected before posting must not create a reschedule');page.off('request',count);
    });

    await check('UI-ADMIN-RSCH-007','A different staff account after cookie change and reload cannot recover the previous passenger request',async(page,context)=>{
      const alice=await account('ALICE-ADMIN-RSCH-007'),bob=await account('BOB-ADMIN-RSCH-007',otherOperator.id),f=await fixture(context,'PRIVATE-ADMIN-RSCH-007');await begin(page,f.booking,f.target,alice);await loseReply(page,f.booking);assert.ok(await cache(page));await json(await context.request.post(base+'/api/auth/login',{data:{email:bob.email,password:'OperatorReschedule@12345'}}));await page.reload();await page.locator('#portal').waitFor({state:'visible'});await page.waitForFunction(name=>document.getElementById('profile-name')?.textContent===name,bob.fullName);await page.locator('#content .loading').waitFor({state:'hidden'});await assertCacheCleared(page);assert.equal(await page.locator('#admin-reschedule-pending:visible').count(),0);assert.ok(!(await page.locator('body').innerText()).includes(f.booking.code));assert.ok(!(await page.locator('#editor-fields').innerText()).includes(f.booking.fullName));assert.equal(await historyCount(f.booking),1);
    });

    await check('UI-ADMIN-RSCH-008','Recovery returns the current cancelled booking without recreating its reservation',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-008');await begin(page,f.booking,f.target);const lost=await loseReply(page,f.booking);await json(await staff.request.patch(base+'/api/admin/bookings/'+f.booking.code,{data:{status:'cancelled'}}));await page.reload();await resume(page);const result=await retry(page,f.booking);assert.equal(result.data.booking.status,'cancelled');assert.equal(result.response.headers()['idempotency-replayed'],'true');assert.equal(result.response.request().postData(),lost.request.body);const row=await currentRow(page,f.booking);assert.match(await row.innerText(),/Đã hủy/);assert.equal(await historyCount(f.booking),1);assert.equal(await auditCount(f.booking),1);assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM reserved_seats WHERE booking_code=?',[f.booking.code])).n),0);
    });

    await check('UI-ADMIN-RSCH-009','Recovery displays a later replacement and never restores the previous target',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-009'),later=await trip({departureTime:'15:00'});await begin(page,f.booking,f.target);const lost=await loseReply(page,f.booking);await json(await staff.request.post(base+'/api/admin/bookings/'+f.booking.code+'/reschedule',{data:leg(later,['A04'])}));await page.reload();await resume(page);const result=await retry(page,f.booking);assert.equal(result.data.booking.tripId,later.id);assert.deepEqual(result.data.booking.seats,['A04']);assert.equal(result.response.headers()['idempotency-replayed'],'true');assert.equal(result.response.request().postData(),lost.request.body);const row=await currentRow(page,f.booking);assert.match(await row.innerText(),/15:00/);assert.match(await row.innerText(),/A04/);assert.equal(await historyCount(f.booking),2);assert.equal(await auditCount(f.booking),2);assert.equal((await lookup(f.booking)).tripId,later.id);
    });

    await check('UI-ADMIN-RSCH-010','Malformed, expired and mismatched cached attempts are removed without sending a reschedule',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-010');await begin(page,f.booking,f.target);await loseReply(page,f.booking);const saved=await cache(page);assert.ok(saved);let posts=0;const recorder=route=>{posts++;return route.continue();};await page.route('**/api/admin/bookings/*/reschedule',recorder);
      const variants=['{broken',JSON.stringify({...saved,createdAt:Date.now()-25*3600000}),JSON.stringify({...saved,ownerId:'another-staff-account'}),JSON.stringify({...saved,path:'/admin/bookings/ANOTHER_CODE/reschedule'}),JSON.stringify({...saved,key:'!'}),JSON.stringify({...saved,key:'k'.repeat(129)}),JSON.stringify({...saved,body:{...saved.body,tripId:'another-target'}}),JSON.stringify({...saved,target:{...saved.target,pickupPoints:['unrelated']}}),JSON.stringify({...saved,target:{...saved.target,date:'2026-02-30'}}),JSON.stringify({...saved,target:{...saved.target,departureTime:'25:61'}}),'x'.repeat(160001)];
      try{for(const value of variants){await page.evaluate(({key,value})=>sessionStorage.setItem(key,value),{key:cacheKey,value});await page.reload();await page.locator('#portal').waitFor({state:'visible'});await page.locator('#content .loading').waitFor({state:'hidden'});await assertCacheCleared(page);assert.equal(await page.locator('#admin-reschedule-pending:visible').count(),0);}await frame(page);assert.equal(posts,0);assert.equal(await historyCount(f.booking),1);}
      finally{await page.unroute('**/api/admin/bookings/*/reschedule',recorder);}
    });

    await check('UI-ADMIN-RSCH-011','An old staff account reply cannot affect the new staff account editor or expose its passenger',async(page,context)=>{
      const alice=await account('ALICE-ADMIN-RSCH-011'),bob=await account('BOB-ADMIN-RSCH-011',otherOperator.id),f=await fixture(context,'PRIVATE-ADMIN-RSCH-011');await begin(page,f.booking,f.target,alice);let release,intercept,complete,routeFailure;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});const handler=async route=>{try{const response=await route.fetch();await json(response);intercept();await gate;await route.fulfill({response});}catch(error){routeFailure=error;intercept();}finally{complete();}};await page.route('**/api/admin/bookings/'+f.booking.code+'/reschedule',handler);
      try{await page.locator('#editor-form [type="submit"]').click();await deadline(intercepted,'Previous staff commit');assert.ifError(routeFailure);await page.evaluate(()=>document.dispatchEvent(new CustomEvent('ticket4t:session-expired')));await page.locator('#login-screen').waitFor({state:'visible'});await assertCacheCleared(page);await page.fill('#login-form [name="email"]',bob.email);await page.fill('#login-form [name="password"]','OperatorReschedule@12345');await page.locator('#login-form [type="submit"]').click();await page.locator('#portal').waitFor({state:'visible'});await page.waitForFunction(name=>document.getElementById('profile-name')?.textContent===name,bob.fullName);await go(page,'trips');await page.locator('[data-action="new-trip"]').click();await page.fill('#editor-form [name="provenance"]','Bản nháp nhà xe mới');const title=await page.locator('#editor-title').innerText();const received=page.waitForResponse(response=>isReschedule(response,f.booking));release();await deadline(completed,'Previous staff reply');assert.ifError(routeFailure);await(await received).finished();await frame(page);assert.equal(new URL(page.url()).hash,'#trips');assert.equal(await page.locator('#editor-title').innerText(),title);assert.equal(await page.inputValue('#editor-form [name="provenance"]'),'Bản nháp nhà xe mới');await assertCacheCleared(page);assert.ok(!(await page.locator('body').innerText()).includes(f.booking.code));assert.ok(!(await page.locator('body').innerText()).includes(f.booking.fullName));assert.equal(await historyCount(f.booking),1);}
      finally{release();await page.unroute('**/api/admin/bookings/'+f.booking.code+'/reschedule',handler);}
    });

    await check('UI-ADMIN-RSCH-012','Logout removes an uncertain staff request and reopening another editor remains usable',async(page,context)=>{
      const f=await fixture(context,'PRIVATE-ADMIN-RSCH-012');await begin(page,f.booking,f.target);await loseReply(page,f.booking);assert.ok(await cache(page));await page.locator('#editor-dialog [data-close-dialog]').first().click();await page.locator('#logout-button').click();await page.locator('#login-screen').waitFor({state:'visible'});await assertCacheCleared(page);assert.equal(await page.locator('#editor-fields').innerText(),'');assert.ok(!(await page.locator('body').innerText()).includes(f.booking.fullName));await login(page);await go(page,'trips');await page.locator('[data-action="new-trip"]').click();assert.ok(await page.locator('#editor-form [type="submit"]').isEnabled());assert.equal(await page.locator('#editor-form').getAttribute('aria-busy'),null);assert.equal(await page.locator('#admin-reschedule-pending:visible').count(),0);assert.equal(await historyCount(f.booking),1);
    });

    await check('UI-ADMIN-RSCH-013','A delayed error refresh cannot mutate a newer editor for the same booking',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-013'),elsewhere=await trip({departureTime:'13:00'}),alternate=await trip({departureTime:'16:00'});await begin(page,f.booking,f.target);await json(await staff.request.post(base+'/api/admin/bookings/'+f.booking.code+'/reschedule',{data:leg(elsewhere,['A04'])}));
      let release,intercept,complete,routeFailure,gated=false;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
      const handler=async route=>{const url=new URL(route.request().url());if(gated||url.pathname!=='/api/admin/trips'||!url.searchParams.has('operator'))return route.continue();gated=true;try{const response=await route.fetch();await json(response);intercept();await gate;await route.fulfill({response});}catch(error){routeFailure=error;intercept();}finally{complete();}};await page.route('**/api/admin/trips?*',handler);
      try{
        const rejected=await retry(page,f.booking,409);assert.equal(rejected.data.code,'BOOKING_CHANGED');await deadline(intercepted,'Error refresh candidate search');assert.ifError(routeFailure);await page.locator('#editor-dialog [data-close-dialog]').first().click();await page.locator('#editor-dialog').waitFor({state:'hidden'});
        await page.locator('[data-action="reschedule-booking"][data-id="'+f.booking.code+'"]').click();await page.locator('#editor-form [name="tripId"]:enabled').waitFor();await page.selectOption('#editor-form [name="tripId"]',alternate.id);await page.locator('[data-action="toggle-reschedule-seat"][data-seat="A03"]:enabled').waitFor();await page.locator('[data-action="toggle-reschedule-seat"][data-seat="A03"]').click();await page.selectOption('#editor-form [name="pickup"]',{index:0});await page.selectOption('#editor-form [name="dropoff"]',{index:0});await confirm(page);
        release();await deadline(completed,'Old error refresh candidate reply');assert.ifError(routeFailure);await frame(page);assert.equal(await page.inputValue('#editor-form [name="tripId"]'),alternate.id);assert.equal(await page.inputValue('#editor-form [name="pickup"]'),alternate.pickupPoints[0]);assert.equal(await page.inputValue('#editor-form [name="dropoff"]'),alternate.dropoffPoints[0]);assert.equal(await page.getAttribute('[data-action="toggle-reschedule-seat"][data-seat="A03"]','aria-pressed'),'true');assert.equal(await page.isChecked('#editor-form [name="rescheduleConfirmed"]'),true,'An old error must not revoke the newer editor consent');assert.equal(await page.locator('#admin-reschedule-review-notice').count(),0);assert.equal(await historyCount(f.booking),1);await assertCacheCleared(page);
      }finally{release();await page.unroute('**/api/admin/trips?*',handler);}
    });

    await check('UI-ADMIN-RSCH-014','A delayed success list refresh cannot reopen an old receipt after route changes',async(page,context)=>{
      const f=await fixture(context,'UI-ADMIN-RSCH-014');await begin(page,f.booking,f.target);let release,intercept,complete,routeFailure,gated=false;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
      const handler=async route=>{const url=new URL(route.request().url());if(gated||url.pathname!=='/api/admin/bookings')return route.continue();gated=true;try{const response=await route.fetch();await json(response);intercept();await gate;await route.fulfill({response});}catch(error){routeFailure=error;intercept();}finally{complete();}};await page.route('**/api/admin/bookings?*',handler);
      try{
        const accepted=await retry(page,f.booking);assert.equal(accepted.data.booking.tripId,f.target.id);await deadline(intercepted,'Success followup bookings list');assert.ifError(routeFailure);await page.locator('#editor-dialog').waitFor({state:'hidden'});await go(page,'trips');await go(page,'bookings');await page.locator('[data-action="booking-detail"][data-id="'+f.booking.code+'"]').waitFor();assert.ok(await page.locator('#editor-dialog').isHidden());
        release();await deadline(completed,'Old success followup list reply');assert.ifError(routeFailure);await frame(page);assert.equal(new URL(page.url()).hash,'#bookings');assert.ok(await page.locator('#editor-dialog').isHidden(),'Returning to bookings must not reopen the detached request receipt');await assertCacheCleared(page);assert.equal(await historyCount(f.booking),1);assert.equal(await auditCount(f.booking),1);
      }finally{release();await page.unroute('**/api/admin/bookings?*',handler);}
    });

    assert.ok(executed,'A requested case must match at least one scenario');assert.deepEqual(errors,[],'Staff recovery must not raise browser exceptions or CSP errors');if(failures.length)throw new AggregateError(failures.map(message=>new Error(message)),passed+'/'+executed+' admin reschedule browser scenarios passed');console.log('Admin reschedule browser passed: '+passed+'/'+executed+' scenarios; exact uncertain recovery, original and target review, mobile, staff scope, privacy and late-response protection.');
  }catch(error){testFailure=error;throw error;}
  finally{await Promise.allSettled(contexts.map(context=>context.close()));await cleanupBrowserTest({browser,server,runtime,dataDir,prefix},testFailure);}
})().catch(error=>{console.error(error);process.exitCode=1;});
