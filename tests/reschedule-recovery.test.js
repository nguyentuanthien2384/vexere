'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createFeatureFixture}=require('./helpers/feature-fixture');
const {addDays}=require('../server/catalog');
const {createApp}=require('../index');

const fixture=t=>createFeatureFixture(t,{databaseUrl:process.env.TEST_DATABASE_URL});
const post=(body,cookie=null,key)=>({method:'POST',body,cookie,...(key ? {headers:{'Idempotency-Key':key}} : {})});
const leg=(target,extra={})=>({tripId:target.id,seats:['A01'],pickup:target.pickupPoints[0],dropoff:target.dropoffPoints[0],phone:'0901234567',...extra});
const move=(f,booking,body,key,cookie=null,staff=false)=>f.request((staff?'/admin':'')+'/bookings/'+booking.code+'/reschedule',post(body,cookie,key));
const lookup=async(f,booking)=>f.expect(await f.request('/bookings/lookup?code='+booking.code+'&phone='+booking.phone,{cookie:null}),200).data.booking;
const reserve=async(f,item,options)=>lookup(f,await f.reserve(item,options));
const count=async(f,table,where='',params=[])=>Number((await f.db.get('SELECT COUNT(*) AS n FROM '+table+(where?' WHERE '+where:''),params)).n);
const effects=async(f,booking)=>({events:await count(f,'booking_events',"booking_code=? AND event='rescheduled'",[booking.code]),admin:await count(f,'admin_audit_events',"entity_id=? AND action='booking_rescheduled'",[booking.code]),keys:await count(f,'checkout_requests'),reserved:await f.db.all('SELECT trip_id,seat FROM reserved_seats WHERE booking_code=? ORDER BY seat',[booking.code]),holds:await count(f,'seat_holds'),holdSeats:await count(f,'hold_seats')});
const held=async(f,target,seats=['A01'])=>f.expect(await f.request('/holds',post({tripId:target.id,seats})),201).data.hold;
const targets=async f=>({source:await f.trip(),target:await f.trip({departureTime:'20:00'}),later:await f.trip({departureTime:'22:00'})});

// Hold a request before entering its transaction, after middleware authorization.
// Mutations use the original transaction method, so this gate works on both
// SQLite and PostgreSQL without timers or an application-wide transaction lock.
async function queued(f,action,change) {
  const original=f.db.transaction;let entered,release,first=true;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.db.transaction=work=>{if(first){first=false;return (async()=>{entered();await gate;return original(work);})();}return original(work);};
  let pending;
  try {pending=action();await ready;await original(change);release();return await pending;}
  finally {release();f.db.transaction=original;if(pending)await pending;}
}

test('[IT-RESCHED-001] simultaneous exact public retries move seats and append history and audit exactly once',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source),body=leg(target,{expectedSourceVersion:booking.rescheduleVersion}),key='reschedule-public-concurrent-001';
  assert.match(booking.rescheduleVersion,/^[a-f0-9]{64}$/);
  const results=await Promise.all([move(f,booking,body,key),move(f,booking,body,key)]);results.forEach(result=>f.expect(result,200));
  assert.equal(results.filter(result=>result.data.replayed===true).length,1);
  const current=await lookup(f,booking),writes=await effects(f,booking);assert.equal(current.tripId,target.id);assert.equal(current.previousTrips.length,1);assert.notEqual(current.rescheduleVersion,booking.rescheduleVersion);
  assert.equal(writes.events,1);assert.equal(writes.keys,1);assert.deepEqual(writes.reserved.map(row=>row.trip_id),[target.id]);
  const stored=JSON.parse((await f.db.get('SELECT data FROM bookings WHERE code=?',[booking.code])).data);assert.equal(Object.hasOwn(stored,'rescheduleVersion'),false);
});

test('[IT-RESCHED-002] held exact replay succeeds after the token is consumed and target terms stop being eligible',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source),hold=await held(f,target),shown=f.expect(await f.request('/trips/'+target.id),200).data;
  const body=leg(target,{holdToken:hold.token,expectedSourceVersion:booking.rescheduleVersion,expectedBookingVersion:shown.bookingVersion}),key='reschedule-consumed-hold-002';
  f.expect(await move(f,booking,body,key),200);assert.equal(await count(f,'seat_holds'),0);
  f.expect(await f.request('/admin/trips/'+target.id,{method:'DELETE'}),200);
  const before=await effects(f,booking),replay=f.expect(await move(f,booking,body,key),200);assert.equal(replay.data.replayed,true);assert.equal(replay.headers.get('Idempotency-Replayed'),'true');assert.equal(replay.data.booking.total,250000);assert.deepEqual(await effects(f,booking),before);
});

test('[IT-RESCHED-003] reschedule replay is durable in a newly initialized application using the same isolated database',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source),body=leg(target),key='reschedule-durable-recovery-003';
  f.expect(await move(f,booking,body,key),200);
  const runtime=await createApp({env:{...f.env,...(f.db.filename?{SQLITE_FILE:f.db.filename}:{})},seedDemo:false,disableRateLimit:true});let server;
  try {
    server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/bookings/'+booking.code+'/reschedule',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(Object.fromEntries(Object.entries(body).reverse()))});
    assert.equal(response.status,200);const replay=await response.json();assert.equal(replay.replayed,true);assert.equal(replay.booking.tripId,target.id);assert.equal(replay.booking.previousTrips.length,1);assert.equal((await effects(f,booking)).events,1);
  } finally {if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});await runtime.close();}
});

test('[IT-RESCHED-004] a used key binds every supplied field booking code and public versus staff endpoint',async t=>{
  const f=await fixture(t),{source,target,later}=await targets(f),booking=await reserve(f,source,{cookie:f.adminCookie}),other=await reserve(f,source,{cookie:f.adminCookie,seats:['A02']}),body=leg(target),key='reschedule-identity-conflict-004';
  f.expect(await move(f,booking,body,key,f.adminCookie),200);const before=await effects(f,booking);
  for(const [item,payload,staff] of [[booking,{...body,tripId:later.id},false],[booking,{...body,seats:['A02']},false],[booking,{...body,expectedSourceVersion:booking.rescheduleVersion},false],[other,body,false],[booking,body,true]]){
    const conflict=f.expect(await move(f,item,payload,key,f.adminCookie,staff),409);assert.equal(conflict.data.code,'IDEMPOTENCY_CONFLICT');
  }
  assert.deepEqual(await effects(f,booking),before);
});

test('[IT-RESCHED-005] validation and target conflicts roll back the key so a corrected request can reuse it',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source),key='reschedule-failed-reuse-key-005',before=await effects(f,booking);
  for(const expectedSourceVersion of [null,{},'bad','A'.repeat(64),'a'.repeat(64)+'\n'])f.expect(await move(f,booking,leg(target,{expectedSourceVersion}),key),400);
  const competitor=await reserve(f,target);assert.equal(f.expect(await move(f,booking,leg(target),key),409).data.code,'SEAT_UNAVAILABLE');
  assert.equal((await effects(f,booking)).keys,before.keys);assert.equal((await effects(f,booking)).events,0);assert.equal((await lookup(f,booking)).tripId,source.id);
  f.expect(await f.request('/bookings/'+competitor.code+'/cancel',post({phone:competitor.phone})),200);
  f.expect(await move(f,booking,leg(target,{expectedSourceVersion:booking.rescheduleVersion}),key),200);assert.equal((await effects(f,booking)).keys,1);
});

test('[IT-RESCHED-006] two different keys submitted from the same source version allow only one successful move',async t=>{
  const f=await fixture(t),{source,target,later}=await targets(f),booking=await reserve(f,source),bodies=[leg(target,{expectedSourceVersion:booking.rescheduleVersion}),leg(later,{expectedSourceVersion:booking.rescheduleVersion})];
  const results=await Promise.all(bodies.map((body,index)=>move(f,booking,body,'reschedule-stale-source-006-'+index)));
  assert.equal(results.filter(result=>result.status===200).length,1);const conflict=results.find(result=>result.status!==200);f.expect(conflict,409);assert.equal(conflict.data.code,'BOOKING_CHANGED');
  const current=await lookup(f,booking);assert.equal(current.previousTrips.length,1);assert.equal((await effects(f,booking)).keys,1);assert.equal((await effects(f,booking)).events,1);
});

test('[IT-RESCHED-007] returning to the original trip does not restore a stale source version',async t=>{
  const f=await fixture(t),{source,target,later}=await targets(f),booking=await reserve(f,source);
  const first=f.expect(await move(f,booking,leg(target,{expectedSourceVersion:booking.rescheduleVersion}),'reschedule-aba-first-007'),200).data.booking;
  const back=f.expect(await move(f,booking,leg(source,{expectedSourceVersion:first.rescheduleVersion}),'reschedule-aba-second-007'),200).data.booking;assert.equal(back.tripId,source.id);assert.equal(back.previousTrips.length,2);assert.notEqual(back.rescheduleVersion,booking.rescheduleVersion);
  const before=await effects(f,booking),stale=f.expect(await move(f,booking,leg(later,{expectedSourceVersion:booking.rescheduleVersion}),'reschedule-aba-stale-007'),409);assert.equal(stale.data.code,'BOOKING_CHANGED');assert.deepEqual(await effects(f,booking),before);
});

test('[IT-RESCHED-008] exact replay returns current cancellation state and cannot reserve seats again',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source),body=leg(target,{expectedSourceVersion:booking.rescheduleVersion}),key='reschedule-cancelled-replay-008';
  f.expect(await move(f,booking,body,key),200);f.expect(await f.request('/bookings/'+booking.code+'/cancel',post({phone:booking.phone})),200);
  const before=await effects(f,booking),result=f.expect(await move(f,booking,body,key),200);assert.equal(result.data.replayed,true);assert.equal(result.data.booking.status,'cancelled');assert.deepEqual(await effects(f,booking),before);assert.deepEqual(before.reserved,[]);
  assert.equal(f.expect(await move(f,booking,leg(source,{expectedSourceVersion:booking.rescheduleVersion}),'reschedule-cancelled-new-008'),409).data.code,'BOOKING_CHANGED');
});

test('[IT-RESCHED-009] replay after a later successful move returns that current trip without rolling it back',async t=>{
  const f=await fixture(t),{source,target,later}=await targets(f),booking=await reserve(f,source),body=leg(target,{expectedSourceVersion:booking.rescheduleVersion}),key='reschedule-earlier-replay-009';
  const first=f.expect(await move(f,booking,body,key),200).data.booking;
  f.expect(await move(f,booking,leg(later,{expectedSourceVersion:first.rescheduleVersion}),'reschedule-later-success-009'),200);
  const before=await effects(f,booking),result=f.expect(await move(f,booking,body,key),200);assert.equal(result.data.replayed,true);assert.equal(result.data.booking.tripId,later.id);assert.equal(result.data.booking.previousTrips.length,2);assert.deepEqual(await effects(f,booking),before);
});

test('[IT-RESCHED-010] legacy requests without a key or source version remain compatible and validate transitions',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source);
  const moved=f.expect(await move(f,booking,leg(target)),200);assert.equal(moved.data.replayed,undefined);assert.equal(moved.headers.get('Idempotency-Replayed'),null);assert.equal((await effects(f,booking)).keys,0);
  f.expect(await f.request('/bookings/'+booking.code+'/cancel',post({phone:booking.phone})),200);
  assert.equal(f.expect(await move(f,booking,leg(source)),409).data.code,'INVALID_TRANSITION');
  assert.equal(f.expect(await move(f,booking,leg(source),'bad-key'),400).data.code,'INVALID_IDEMPOTENCY_KEY');
});

test('[IT-RESCHED-011] exact staff retries append the operator audit once and revoked staff cannot replay while queued',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source),staff=await f.staff(),cookie=(await f.login(staff.email,'StaffTest@12345')).cookie,body=leg(target),key='reschedule-staff-replay-011';
  const results=await Promise.all([move(f,booking,body,key,cookie,true),move(f,booking,body,key,cookie,true)]);results.forEach(result=>f.expect(result,200));assert.equal(results.filter(result=>result.data.replayed).length,1);const before=await effects(f,booking);assert.equal(before.admin,1);
  const revoked=await queued(f,()=>move(f,booking,body,key,cookie,true),tx=>tx.run('UPDATE users SET active=0,auth_version=auth_version+1 WHERE id=?',[staff.id]));f.expect(revoked,403);assert.equal(revoked.data.code,'FORBIDDEN');assert.deepEqual(await effects(f,booking),before);
});

test('[IT-RESCHED-012] queued staff scope changes and locked current trip scope prevent replay disclosure',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source),staff=await f.staff(),cookie=(await f.login(staff.email,'StaffTest@12345')).cookie,body=leg(target),key='reschedule-staff-scope-012';
  f.expect(await move(f,booking,body,key,cookie,true),200);const other=f.expect(await f.request('/admin/operators',{method:'POST',body:{name:'Nhà xe ngoài phạm vi',phone:'0907654321'}}),201).data.operator,before=await effects(f,booking);
  const changed=await queued(f,()=>move(f,booking,body,key,cookie,true),tx=>tx.run('UPDATE users SET operator_id=? WHERE id=?',[other.id,staff.id]));f.expect(changed,403);assert.deepEqual(await effects(f,booking),before);
  await f.db.run('UPDATE users SET operator_id=? WHERE id=?',[source.operatorId,staff.id]);
  await f.db.run('UPDATE trips SET operator_id=? WHERE id=?',[other.id,target.id]);
  assert.equal(f.expect(await move(f,booking,body,key,cookie,true),403).data.code,'FORBIDDEN');assert.deepEqual(await effects(f,booking),before);
});

test('[IT-RESCHED-013] ownership is checked again after a replay request queues and used guest keys do not bypass the phone check',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),customer=await f.customer('source-owner'),other=await f.customer('other-owner'),booking=await reserve(f,source,{cookie:customer.cookie}),body=leg(target);delete body.phone;
  const key='reschedule-owner-recheck-013';f.expect(await move(f,booking,body,key,customer.cookie),200);const before=await effects(f,booking);
  const changed=await queued(f,()=>move(f,booking,body,key,customer.cookie),tx=>tx.run('UPDATE bookings SET user_id=? WHERE code=?',[other.user.id,booking.code]));f.expect(changed,404);assert.deepEqual(await effects(f,booking),before);
  const guest=await reserve(f,source,{seats:['A02']}),guestBody=leg(target,{seats:['A02']}),guestKey='reschedule-guest-owner-013';f.expect(await move(f,guest,guestBody,guestKey),200);
  f.expect(await move(f,guest,{...guestBody,phone:'0907654321'},guestKey),404);
});

test('[IT-RESCHED-014] roundtrip ordering and discounted financial allocation stay atomic across moves and replay',async t=>{
  const f=await fixture(t),source=await f.trip(),back=await f.trip({from:'da-lat',to:'ho-chi-minh',date:addDays(f.today,3),departureTime:'09:00'}),target=await f.trip({departureTime:'20:00'}),invalid=await f.trip({date:back.date,departureTime:'06:00'});
  f.expect(await f.request('/admin/promotions',{method:'POST',body:{code:'RESCHED50',title:'Ưu đãi khứ hồi',type:'percentage',value:50,minSpend:0,maxDiscount:0,maxUses:20,perCustomer:5,startsAt:'2000-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',roundTripOnly:true}}),201);
  const order=f.expect(await f.request('/orders',post({...f.bookingBody(source),couponCode:'RESCHED50',legs:[leg(source),leg(back)]})),201).data.order,booking=order.bookings[0],original={subtotal:booking.subtotal,discount:booking.discount,total:booking.total,paymentMethod:booking.paymentMethod,couponCode:booking.couponCode,orderCode:booking.orderCode};
  const before=await effects(f,booking);f.expect(await move(f,booking,leg(invalid,{expectedSourceVersion:booking.rescheduleVersion}),'reschedule-roundtrip-invalid-014'),400);assert.deepEqual(await effects(f,booking),before);
  const body=leg(target,{expectedSourceVersion:booking.rescheduleVersion}),key='reschedule-roundtrip-valid-014',moved=f.expect(await move(f,booking,body,key),200).data.booking;for(const [field,value] of Object.entries(original))assert.equal(moved[field],value,field);
  const after=f.expect(await f.request('/orders/lookup?code='+order.code+'&phone=0901234567',{cookie:null}),200).data.order;assert.equal(after.total,order.total);assert.equal(after.discount,order.discount);assert.equal(after.bookings[1].tripId,back.id);assert.equal(await count(f,'promotion_uses'),1);
  f.expect(await move(f,booking,body,key),200);assert.equal((await effects(f,booking)).events,1);
});

async function replayRace(f,booking,body,key,failures) {
  const original=f.db.transaction;let reads=0,remaining=failures;
  f.db.transaction=work=>original(tx=>{const get=tx.get;let bookingReads=0;const wrapped={...tx,get:async(sql,params)=>{
    const row=await get(sql,params);
    if(sql.startsWith('SELECT * FROM bookings WHERE code=')&&params[0]===booking.code){bookingReads++;if(bookingReads===2){reads++;if(remaining>0){remaining--;return {...row,trip_id:'moved-after-trip-lock'};}}}
    return row;
  }};return work(wrapped);});
  try {return {result:await move(f,booking,body,key),reads};}finally{f.db.transaction=original;}
}

test('[IT-RESCHED-015] replay retries trip lock races with fresh transactions and eventually returns unchanged current state',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source),body=leg(target),key='reschedule-lock-retry-015';f.expect(await move(f,booking,body,key),200);const before=await effects(f,booking);
  const {result,reads}=await replayRace(f,booking,body,key,2);f.expect(result,200);assert.equal(result.data.replayed,true);assert.equal(reads,3);assert.equal(result.data.booking.tripId,target.id);assert.deepEqual(await effects(f,booking),before);
});

test('[IT-RESCHED-016] a third replay lock race returns retryable 503 without writing or consuming the saved request',async t=>{
  const f=await fixture(t),{source,target}=await targets(f),booking=await reserve(f,source),body=leg(target),key='reschedule-lock-exhaust-016';f.expect(await move(f,booking,body,key),200);const before=await effects(f,booking);
  const {result,reads}=await replayRace(f,booking,body,key,10);f.expect(result,503);assert.equal(result.data.code,'RESCHEDULE_RETRY');assert.equal(reads,3);assert.deepEqual(await effects(f,booking),before);
  const recovered=f.expect(await move(f,booking,body,key),200);assert.equal(recovered.data.replayed,true);assert.deepEqual(await effects(f,booking),before);
});

