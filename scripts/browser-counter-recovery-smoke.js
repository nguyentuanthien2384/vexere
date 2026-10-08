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
  const prefix='ticket4t-browser-counter-recovery-',dataDir=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  const env={NODE_ENV:'test',SEED_DEMO:'false',SESSION_SECRET:'counter-recovery-isolated-browser-secret',ADMIN_EMAIL:'counter-admin@example.test',ADMIN_PASSWORD:'CounterAdmin@12345'};
  const contexts=[],errors=[],failures=[],cacheKey='ticket4t_counter_attempt',screenshots=path.resolve('artifacts/screenshots');
  let runtime,server,browser,staff,base,operator,today,testFailure,passed=0,executed=0;
  async function json(response,status=200){const data=await response.json();assert.equal(response.status(),status,JSON.stringify(data));return data;}
  async function frame(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function deadline(promise,label){let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),15000);})]);}finally{clearTimeout(timer);}}
  async function check(id,title,work){
    if(process.env.UI_COUNTER_CASE&&!id.endsWith(process.env.UI_COUNTER_CASE))return;
    executed++;const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);const page=await context.newPage();page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(id+': '+error.message));page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to|Uncaught/i.test(message.text()))errors.push(id+': '+message.text());});
    try{await work(page,context);passed++;console.log('PASS ['+id+'] '+title);}
    catch(error){failures.push('['+id+'] '+title+': '+error.message);console.error('FAIL ['+id+'] '+title+'\n'+error.stack);await page.screenshot({path:path.join(screenshots,'counter-recovery-failure-'+id.toLowerCase()+'.png'),fullPage:true,animations:'disabled'}).catch(()=>{});}
    finally{await context.close();}
  }
  async function trip(extra={}){return (await json(await staff.request.post(base+'/api/admin/trips',{data:{operatorId:operator.id,from:'ho-chi-minh',to:'da-lat',date:addDays(today,3),departureTime:'08:00',type:'limousine',price:250000,totalSeats:9,durationMinutes:360,pickupPoints:['Bến kiểm thử','Văn phòng kiểm thử'],dropoffPoints:['Bến Đà Lạt','Văn phòng Đà Lạt'],provenance:'Kho ghế QA bán tại quầy',...extra}}),201)).trip;}
  function person(id){return {fullName:'Hành khách quầy '+id,phone:'0912345678',email:id.toLowerCase()+'@example.test'};}
  function leg(item,seats=['A01']){return {tripId:item.id,seats,pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0]};}
  async function login(page,user){await page.goto(base+'/admin');await page.fill('#login-form [name="email"]',user?.email||env.ADMIN_EMAIL);await page.fill('#login-form [name="password"]',user?'CounterStaff@12345':env.ADMIN_PASSWORD);await page.locator('#login-form [type="submit"]').click();await page.locator('#portal').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#content .loading'));}
  async function go(page,name){await page.evaluate(name=>{location.hash=name;},name);await page.waitForFunction(name=>location.hash==='#'+name&&document.querySelector('#sidebar [data-page="'+name+'"]')?.classList.contains('active')&&!document.querySelector('#content .loading'),name);}
  async function begin(page,item,id,user){
    await login(page,user);await go(page,'trips');await page.fill('#filters [name="date"]',item.date);await page.locator('#filters [type="submit"]').click();await page.locator('[data-action="counter-booking"][data-id="'+item.id+'"]').waitFor();await page.locator('[data-action="counter-booking"][data-id="'+item.id+'"]').click();await page.locator('.counter-seat[data-seat="A01"]:enabled').waitFor();await page.locator('.counter-seat[data-seat="A01"]').click();
    for(const [name,value] of Object.entries(person(id)))await page.fill('#counter-form [name="'+name+'"]',value);await page.selectOption('#counter-form [name="pickup"]',{index:1});await page.selectOption('#counter-form [name="dropoff"]',{index:1});await consent(page);
  }
  async function consent(page){await page.check('#counter-form [name="counterConfirmed"]');}
  const isCounter=response=>new URL(response.url()).pathname==='/api/admin/bookings'&&response.request().method()==='POST';
  const requestSnapshot=route=>({key:route.request().headers()['idempotency-key'],body:route.request().postData()});
  async function cache(page){return page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'null'),cacheKey);}
  async function cleared(page){assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),cacheKey),null);}
  async function rows(item){return runtime.api.db.all('SELECT code FROM bookings WHERE trip_id=?',[item.id]);}
  async function auditCount(booking){return Number((await runtime.api.db.get("SELECT COUNT(*) AS n FROM admin_audit_events WHERE entity_id=? AND action='counter_booking_created'",[booking.code])).n);}
  async function done(page,booking){await page.waitForFunction(code=>document.querySelector('#editor-dialog')?.open&&document.getElementById('editor-title')?.textContent==='Đơn '+code,booking.code);await page.locator('#editor-fields .detail-list').waitFor();}
  async function submit(page,status=201){const response=page.waitForResponse(isCounter);await consent(page);await page.locator('#counter-submit').click();const received=await response;return {response:received,data:await json(received,status)};}
  async function loseReply(page){let lost;const handler=async route=>{if(route.request().method()!=='POST')return route.continue();lost={request:requestSnapshot(route),data:await json(await route.fetch(),201)};await route.abort('failed');};await page.route('**/api/admin/bookings',handler);try{await page.locator('#counter-submit').click();await page.locator('#counter-recovery-notice').waitFor();assert.ok(lost);return lost;}finally{await page.unroute('**/api/admin/bookings',handler);}}
  async function resume(page){await page.locator('#portal').waitFor({state:'visible'});await page.locator('#admin-counter-pending [data-action="resume-counter-request"]').click();await page.locator('#counter-recovery-notice').waitFor();}
  async function account(id){return (await json(await staff.request.post(base+'/api/admin/users',{data:{fullName:'Nhân viên quầy '+id,email:id.toLowerCase()+'@example.test',phone:'0901234567',password:'CounterStaff@12345',role:'operator',operatorId:operator.id}}),201)).user;}
  function gateReply(page,pattern,predicate=()=>true){
    let release,intercept,complete,failure,used=false;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{intercept=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
    const handler=async route=>{if(used||!predicate(route.request()))return route.continue();used=true;try{const response=await route.fetch();intercept();await gate;await route.fulfill({response});}catch(error){failure=error;intercept();}finally{complete();}};
    return {handler,release,started,completed,assert:()=>assert.ifError(failure),pattern};
  }
  try{
    await fs.mkdir(screenshots,{recursive:true});runtime=await createApp({env,dataDir,seedDemo:false,disableRateLimit:true});server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=env.APP_URL='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});staff=await browser.newContext();contexts.push(staff);await json(await staff.request.post(base+'/api/auth/login',{data:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}));({today}=await json(await staff.request.get(base+'/api/bootstrap')));operator=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe QA khôi phục quầy',phone:'0901234567'}}),201)).operator;

    await check('UI-COUNTER-001','Lost committed reply restores exact request after reload and requires manual mobile confirmation',async page=>{
      const item=await trip();await begin(page,item,'UI-COUNTER-001');const lost=await loseReply(page),booking=lost.data.booking,saved=await cache(page),body=JSON.parse(lost.request.body);assert.match(lost.request.key,/^[A-Za-z0-9._:-]{16,128}$/);assert.match(body.expectedBookingVersion,/^[a-f0-9]{64}$/);assert.equal(body.expectedTotal,250000);assert.equal(body.holdToken,undefined);assert.equal(saved.key,lost.request.key);assert.equal((await rows(item)).length,1);
      await page.reload();await resume(page);assert.equal(await page.isChecked('[name="counterConfirmed"]'),false);await page.setViewportSize({width:390,height:844});await frame(page);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));for(const selector of ['#counter-dialog','#counter-recovery-notice','#counter-form [name="fullName"]','#counter-submit']){const box=await page.locator(selector).boundingBox();assert.ok(box&&box.width>0&&box.x>=-1&&box.x+box.width<=391,selector+' fits mobile');}await page.screenshot({path:path.join(screenshots,'counter-recovery-mobile.png'),fullPage:true,animations:'disabled'});await page.setViewportSize({width:1440,height:1000});
      const requests=[],handler=route=>{if(route.request().method()==='POST')requests.push(requestSnapshot(route));return route.continue();};await page.route('**/api/admin/bookings',handler);
      try{await page.evaluate(()=>{document.querySelector('#counter-form [name="fullName"]').value='Lựa chọn đã bị sửa';});await consent(page);await page.locator('#counter-submit').click();await page.locator('#counter-error').filter({hasText:/khôi phục|ban đầu|gốc/i}).waitFor();assert.equal(requests.length,0);await page.locator('#counter-restore-request').click();assert.equal(await page.isChecked('[name="counterConfirmed"]'),false);const replay=await submit(page,200);assert.equal(replay.response.headers()['idempotency-replayed'],'true');assert.equal(replay.data.booking.code,booking.code);assert.deepEqual(requests,[lost.request]);await done(page,booking);await cleared(page);assert.equal((await rows(item)).length,1);assert.equal(await auditCount(booking),1);}finally{await page.unroute('**/api/admin/bookings',handler);}
    });

    await check('UI-COUNTER-002','Concurrent confirmations submit once and preserve a single reservation and audit',async page=>{
      const item=await trip();await begin(page,item,'UI-COUNTER-002');const gate=gateReply(page,'**/api/admin/bookings',request=>request.method()==='POST');let count=0;const recorder=route=>{if(route.request().method()==='POST')count++;return gate.handler(route);};await page.route(gate.pattern,recorder);
      try{await page.evaluate(()=>{const form=document.getElementById('counter-form');form.requestSubmit();form.requestSubmit();});await deadline(gate.started,'Duplicate counter submit');gate.assert();assert.equal(count,1);await page.keyboard.press('Escape');assert.ok(await page.locator('#counter-dialog').isVisible());gate.release();await deadline(gate.completed,'Counter completion');gate.assert();const booked=await rows(item);assert.equal(booked.length,1);await done(page,booked[0]);assert.equal(await auditCount(booked[0]),1);}finally{gate.release();await page.unroute(gate.pattern,recorder);}
    });

    await check('UI-COUNTER-003','Changed fare and stops refresh current terms before a fresh confirmation',async page=>{
      const item=await trip();await begin(page,item,'UI-COUNTER-003');await json(await staff.request.patch(base+'/api/admin/trips/'+item.id,{data:{price:300000,pickupPoints:['Điểm đón mới'],dropoffPoints:['Điểm trả mới'],departureTime:'09:00'}}));const rejected=await submit(page,409);assert.equal(rejected.data.code,'TRIP_CHANGED');await page.locator('#counter-review-notice').waitFor();await page.waitForFunction(()=>document.querySelector('#counter-form [name="pickup"]')?.value==='Điểm đón mới');assert.equal(await page.isChecked('[name="counterConfirmed"]'),false);assert.match(await page.locator('#counter-total').innerText(),/300.000/);assert.equal((await rows(item)).length,0);await cleared(page);const accepted=await submit(page);assert.equal(accepted.data.booking.total,300000);assert.equal(accepted.data.booking.pickup,'Điểm đón mới');await done(page,accepted.data.booking);
    });

    await check('UI-COUNTER-004','A seat race removes the unavailable selection and requires another reviewed seat',async(page,context)=>{
      const item=await trip();await begin(page,item,'UI-COUNTER-004');await json(await staff.request.post(base+'/api/bookings',{data:{...leg(item),...person('COMPETITOR-004'),paymentMethod:'cash'}}),201);const rejected=await submit(page,409);assert.equal(rejected.data.code,'SEAT_UNAVAILABLE');await page.waitForFunction(()=>document.getElementById('counter-selected')?.textContent==='Chưa chọn ghế');assert.equal(await page.locator('.counter-seat.selected').count(),0);assert.equal(await page.isChecked('[name="counterConfirmed"]'),false);await cleared(page);await page.locator('.counter-seat[data-seat="A02"]:enabled').click();const accepted=await submit(page);assert.deepEqual(accepted.data.booking.seats,['A02']);await done(page,accepted.data.booking);assert.equal((await rows(item)).length,2);
    });

    await check('UI-COUNTER-005','Revoked staff is rejected before posting and all passenger fields are removed',async page=>{
      const item=await trip(),user=await account('REVOKED-005');await begin(page,item,'UI-COUNTER-005',user);await json(await staff.request.patch(base+'/api/admin/users/'+user.id,{data:{active:false}}));let posts=0;const handler=route=>{if(route.request().method()==='POST')posts++;return route.continue();};await page.route('**/api/admin/bookings',handler);
      try{await page.locator('#counter-submit').click();await page.locator('#login-screen').waitFor({state:'visible'});await cleared(page);assert.equal(posts,0);assert.equal(await page.locator('#counter-dialog').innerText(),'');assert.equal((await rows(item)).length,0);}finally{await page.unroute('**/api/admin/bookings',handler);}
    });

    await check('UI-COUNTER-006','Uncertain replay returns the current refunded booking and never restores its seats',async page=>{
      const item=await trip();await begin(page,item,'UI-COUNTER-006');const lost=await loseReply(page),booking=lost.data.booking;await json(await staff.request.post(base+'/api/admin/bookings/'+booking.code+'/cash-receipt',{data:{reference:'COUNTER-CASH-'+booking.code,amount:booking.total}}));await json(await staff.request.patch(base+'/api/admin/bookings/'+booking.code,{data:{status:'cancelled'}}));await json(await staff.request.post(base+'/api/admin/bookings/'+booking.code+'/refund-receipt',{data:{reference:'COUNTER-REFUND-'+booking.code,amount:booking.total}}));await json(await staff.request.delete(base+'/api/admin/trips/'+item.id));const replay=await submit(page,200);assert.equal(replay.data.booking.status,'cancelled');assert.equal(replay.data.booking.paymentStatus,'refunded');await done(page,booking);assert.match(await page.locator('#editor-fields').innerText(),/Đã hủy|Đã hoàn/);await cleared(page);assert.equal(await auditCount(booking),1);assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM reserved_seats WHERE booking_code=?',[booking.code])).n),0);
    });

    await check('UI-COUNTER-007','A different account on reload cannot restore the previous passenger request',async(page,context)=>{
      const item=await trip(),alice=await account('ALICE-007'),bob=await account('BOB-007');await begin(page,item,'PRIVATE-007',alice);await loseReply(page);await json(await context.request.post(base+'/api/auth/login',{data:{email:bob.email,password:'CounterStaff@12345'}}));await page.reload();await page.locator('#portal').waitFor({state:'visible'});await page.waitForFunction(name=>document.getElementById('profile-name')?.textContent===name,bob.fullName);await cleared(page);assert.equal(await page.locator('#admin-counter-pending:visible').count(),0);assert.ok(!(await page.locator('body').innerText()).includes(person('PRIVATE-007').fullName));assert.equal(await page.locator('#counter-dialog').innerText(),'');
    });

    await check('UI-COUNTER-008','A late committed counter response cannot overwrite a newer trip editor',async page=>{
      const item=await trip();await begin(page,item,'UI-COUNTER-008');const gate=gateReply(page,'**/api/admin/bookings',request=>request.method()==='POST');await page.route(gate.pattern,gate.handler);
      try{await page.locator('#counter-submit').click();await deadline(gate.started,'Old counter commit');gate.assert();await go(page,'bookings');await go(page,'trips');await page.locator('[data-action="new-trip"]').click();await page.fill('#editor-form [name="provenance"]','Thông tin mới cần giữ');const title=await page.locator('#editor-title').innerText();gate.release();await deadline(gate.completed,'Old counter reply');gate.assert();await frame(page);assert.equal(new URL(page.url()).hash,'#trips');assert.equal(await page.locator('#editor-title').innerText(),title);assert.equal(await page.inputValue('#editor-form [name="provenance"]'),'Thông tin mới cần giữ');assert.equal((await rows(item)).length,1);assert.ok(await cache(page),'Uncertain request remains recoverable after navigation');}finally{gate.release();await page.unroute(gate.pattern,gate.handler);}
    });

    await check('UI-COUNTER-009','An old success list refresh cannot reopen details after navigation away and back',async page=>{
      const item=await trip();await begin(page,item,'UI-COUNTER-009');const gate=gateReply(page,'**/api/admin/bookings?*',request=>request.method()==='GET');await page.route(gate.pattern,gate.handler);
      try{const accepted=await submit(page);await deadline(gate.started,'Counter followup list');gate.assert();await page.locator('#counter-dialog').waitFor({state:'hidden'});await go(page,'trips');await go(page,'bookings');gate.release();await deadline(gate.completed,'Old followup list reply');gate.assert();await frame(page);assert.ok(await page.locator('#editor-dialog').isHidden());assert.equal(new URL(page.url()).hash,'#bookings');await cleared(page);assert.equal(await auditCount(accepted.data.booking),1);}finally{gate.release();await page.unroute(gate.pattern,gate.handler);}
    });

    await check('UI-COUNTER-010','A malformed successful reply preserves the committed request for exact recovery',async page=>{
      const item=await trip();await begin(page,item,'UI-COUNTER-010');let original,booking;const handler=async route=>{if(route.request().method()!=='POST')return route.continue();original=requestSnapshot(route);booking=(await json(await route.fetch(),201)).booking;await route.fulfill({status:201,contentType:'application/json',body:'null'});};await page.route('**/api/admin/bookings',handler);
      try{await page.locator('#counter-submit').click();await page.locator('#counter-recovery-notice').waitFor();assert.equal((await cache(page)).key,original.key);assert.equal((await rows(item)).length,1);}finally{await page.unroute('**/api/admin/bookings',handler);}
      const received=[];const recorder=route=>{if(route.request().method()==='POST')received.push(requestSnapshot(route));return route.continue();};await page.route('**/api/admin/bookings',recorder);try{const recovered=await submit(page,200);assert.equal(recovered.data.booking.code,booking.code);assert.deepEqual(received,[original]);await done(page,booking);await cleared(page);assert.equal(await auditCount(booking),1);}finally{await page.unroute('**/api/admin/bookings',recorder);}
    });

    await check('UI-COUNTER-011','Logout clears uncertain contact data and the next editor remains usable',async page=>{
      const item=await trip();await begin(page,item,'PRIVATE-COUNTER-011');await loseReply(page);await page.locator('#counter-dialog [data-counter-close]').first().click();await page.locator('#logout-button').click();await page.locator('#login-screen').waitFor({state:'visible'});await cleared(page);assert.equal(await page.locator('#counter-dialog').innerText(),'');assert.ok(!(await page.locator('body').innerText()).includes(person('PRIVATE-COUNTER-011').fullName));await login(page);await go(page,'trips');await page.locator('[data-action="new-trip"]').click();assert.ok(await page.locator('#editor-form [type="submit"]').isEnabled());assert.equal(await page.locator('#admin-counter-pending:visible').count(),0);
    });

    await check('UI-COUNTER-012','Corrupt, expired and modified cached requests cannot submit on reload',async page=>{
      const item=await trip();await begin(page,item,'UI-COUNTER-012');await loseReply(page);const saved=await cache(page);let posts=0;const handler=route=>{if(route.request().method()==='POST')posts++;return route.continue();};await page.route('**/api/admin/bookings',handler);
      try{for(const value of ['{bad',JSON.stringify({...saved,createdAt:Date.now()-25*3600000}),JSON.stringify({...saved,key:'k'.repeat(129)}),JSON.stringify({...saved,body:{...saved.body,expectedTotal:1}}),JSON.stringify({...saved,trip:{...saved.trip,date:'2026-02-30'}}),'x'.repeat(160001)]){await page.evaluate(({key,value})=>sessionStorage.setItem(key,value),{key:cacheKey,value});await page.reload();await page.locator('#portal').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#content .loading'));await cleared(page);assert.equal(await page.locator('#admin-counter-pending:visible').count(),0);}assert.equal(posts,0);assert.equal((await rows(item)).length,1);}finally{await page.unroute('**/api/admin/bookings',handler);}
    });

    assert.ok(executed);assert.deepEqual(errors,[],'Counter recovery must not raise browser or CSP exceptions');if(failures.length)throw new AggregateError(failures.map(message=>new Error(message)),passed+'/'+executed+' counter scenarios passed');console.log('Counter recovery browser passed: '+passed+'/'+executed+' scenarios.');
  }catch(error){testFailure=error;throw error;}
  finally{await Promise.allSettled(contexts.map(context=>context.close()));await cleanupBrowserTest({browser,server,runtime,dataDir,prefix},testFailure);}
})().catch(error=>{console.error(error);process.exitCode=1;});
