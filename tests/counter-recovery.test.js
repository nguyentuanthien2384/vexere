'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createFeatureFixture}=require('./helpers/feature-fixture');

const fixture=t=>createFeatureFixture(t,{databaseUrl:process.env.TEST_DATABASE_URL});
const post=(body,cookie,key)=>({method:'POST',body,cookie,...(key ? {headers:{'Idempotency-Key':key}} : {})});
const sell=(f,body,key,cookie=f.adminCookie)=>f.request('/admin/bookings',post(body,cookie,key));
const count=async(f,table,where='',params=[])=>Number((await f.db.get('SELECT COUNT(*) AS n FROM '+table+(where ? ' WHERE '+where : ''),params)).n);
const effects=async(f,booking)=>({
  bookings:await count(f,'bookings'),keys:await count(f,'checkout_requests'),uses:await count(f,'promotion_uses'),
  events:await f.db.all('SELECT event,data FROM booking_events WHERE booking_code=? ORDER BY created_at,id',[booking.code]),
  audit:await f.db.all('SELECT action,data FROM admin_audit_events WHERE entity_id=? ORDER BY created_at,id',[booking.code]),
  seats:await f.db.all('SELECT trip_id,seat FROM reserved_seats WHERE booking_code=? ORDER BY seat',[booking.code]),
  receipts:await f.db.all('SELECT reference,provider,amount,status FROM payments WHERE booking_code=? ORDER BY reference',[booking.code]),
  mail:await count(f,'email_outbox')
});
async function setup(t) {
  const f=await fixture(t),trip=await f.trip(),shown=f.expect(await f.request('/trips/'+trip.id,{cookie:null}),200).data;
  const staff=await f.staff(),cookie=(await f.login(staff.email,'StaffTest@12345')).cookie;
  return {f,trip,staff,cookie,body:f.bookingBody(trip,{email:'',expectedBookingVersion:shown.bookingVersion,expectedTotal:trip.price})};
}
async function queued(f,action,change) {
  const original=f.db.transaction;let entered,release,first=true,pending;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.db.transaction=work=>{if(first){first=false;return (async()=>{entered();await gate;return original(work);})();}return original(work);};
  try {pending=action();await ready;await change();release();return await pending;}
  finally {release();f.db.transaction=original;if(pending)await pending;}
}

test('[IT-COUNTER-001] concurrent staff retries create one customer booking, coupon use and audit without sending email',async t=>{
  const {f,trip,staff,cookie,body}=await setup(t),key='counter-concurrent-recovery-001';
  f.expect(await f.request('/admin/promotions',{method:'POST',body:{code:'COUNTER10',title:'Ưu đãi tại quầy',type:'percentage',value:10,maxUses:1,perCustomer:1}}),201);
  const payload={...body,couponCode:'COUNTER10',expectedTotal:225000};
  const results=await Promise.all(Array.from({length:6},()=>sell(f,payload,key,cookie)));
  assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===200).length,5);
  assert.equal(new Set(results.map(r=>r.data.booking.code)).size,1);
  for(const replay of results.filter(r=>r.status===200)){assert.equal(replay.headers.get('Idempotency-Replayed'),'true');assert.equal(replay.data.replayed,true);}
  const booking=results[0].data.booking;assert.equal(booking.userId,null);assert.equal(booking.createdBy,staff.id);assert.equal(booking.channel,'counter');assert.equal(booking.email,'');assert.equal(booking.tripId,trip.id);assert.equal(booking.total,225000);
  const writes=await effects(f,booking);assert.equal(writes.bookings,1);assert.equal(writes.keys,1);assert.equal(writes.uses,1);assert.equal(writes.events.length,1);assert.equal(writes.audit.length,1);assert.equal(writes.mail,0);assert.equal(writes.seats.length,1);
  const record=await f.db.get('SELECT key_hash,result FROM checkout_requests');assert.ok(!JSON.stringify(record).includes(key));
});

test('[IT-COUNTER-002] omitted cash and equivalent JSON ordering recover identically while legacy no-key clients remain supported',async t=>{
  const {f,body,cookie}=await setup(t),key='counter-default-cash-key-002';const omitted={...body};delete omitted.paymentMethod;
  const created=f.expect(await sell(f,omitted,key,cookie),201).data.booking;
  const reordered=Object.fromEntries(Object.entries({...omitted,paymentMethod:'cash'}).reverse());
  const replay=f.expect(await sell(f,reordered,key,cookie),200);assert.equal(replay.data.booking.code,created.code);assert.equal(replay.data.replayed,true);
  f.expect(await sell(f,{...body,seats:['A02']},undefined,cookie),201);assert.equal(await count(f,'checkout_requests'),1);
  for(const invalid of ['short','a'.repeat(129),'invalid key with spaces'])assert.equal(f.expect(await sell(f,{...body,seats:['A03']},invalid,cookie),400).data.code,'INVALID_IDEMPOTENCY_KEY');
  assert.equal(await count(f,'bookings'),2);
});

test('[IT-COUNTER-003] saved staff keys reject changed contact, seats, totals and endpoint before returning private booking data',async t=>{
  const {f,body,cookie}=await setup(t),key='counter-body-bound-key-003',created=f.expect(await sell(f,body,key,cookie),201).data.booking,before=await effects(f,created);
  for(const changed of [{phone:'0909999999'},{seats:['A02']},{expectedTotal:1},{email:'changed@example.test'},{pickup:'Điểm khác'}]){
    const result=f.expect(await sell(f,{...body,...changed},key,cookie),409);assert.equal(result.data.code,'IDEMPOTENCY_CONFLICT');assert.equal(Object.hasOwn(result.data,'booking'),false);
  }
  const different=f.expect(await f.request('/bookings',post(body,cookie,key)),409);assert.equal(different.data.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(await effects(f,created),before);
});

test('[IT-COUNTER-004] validation and stale trip/price errors leave keys reusable after a fresh staff review',async t=>{
  const {f,trip,body,cookie}=await setup(t),key='counter-rejected-key-004';
  assert.equal(f.expect(await sell(f,{...body,expectedTotal:1},key,cookie),409).data.code,'PRICE_CHANGED');assert.equal(await count(f,'checkout_requests'),0);
  f.expect(await f.request('/admin/trips/'+trip.id,{method:'PATCH',body:{price:280000}}),200);
  assert.equal(f.expect(await sell(f,body,key,cookie),409).data.code,'TRIP_CHANGED');assert.equal(await count(f,'checkout_requests'),0);
  const fresh=f.expect(await f.request('/trips/'+trip.id,{cookie:null}),200).data;
  const created=f.expect(await sell(f,{...body,expectedBookingVersion:fresh.bookingVersion,expectedTotal:280000},key,cookie),201).data.booking;assert.equal(created.total,280000);assert.equal(await count(f,'checkout_requests'),1);
});

test('[IT-COUNTER-005] replay after collection, cancellation, refund and source closure returns current state without repeating effects',async t=>{
  const {f,trip,body,cookie}=await setup(t),key='counter-current-refunded-005',created=f.expect(await sell(f,body,key,cookie),201).data.booking;
  f.expect(await f.request('/admin/bookings/'+created.code+'/cash-receipt',{method:'POST',cookie,body:{reference:'COUNTER-CASH-005',amount:created.total}}),200);
  f.expect(await f.request('/admin/bookings/'+created.code,{method:'PATCH',cookie,body:{status:'cancelled'}}),200);
  f.expect(await f.request('/admin/bookings/'+created.code+'/refund-receipt',{method:'POST',cookie,body:{reference:'COUNTER-REFUND-005',amount:created.total}}),200);
  f.expect(await f.request('/admin/trips/'+trip.id,{method:'DELETE'}),200);const before=await effects(f,created);
  const replay=f.expect(await sell(f,body,key,cookie),200).data.booking;assert.equal(replay.code,created.code);assert.equal(replay.status,'cancelled');assert.equal(replay.paymentStatus,'refunded');assert.deepEqual(await effects(f,created),before);assert.equal(before.seats.length,0);assert.equal(before.receipts.length,2);
});

test('[IT-COUNTER-006] replay follows later rescheduling and enforces both historical and actual operator scope',async t=>{
  const {f,trip,body,cookie}=await setup(t),key='counter-current-trip-006',created=f.expect(await sell(f,body,key,cookie),201).data.booking,target=await f.trip({departureTime:'20:00'});
  f.expect(await f.request('/admin/bookings/'+created.code+'/reschedule',{method:'POST',cookie,body:{tripId:target.id,seats:['A02'],pickup:target.pickupPoints[0],dropoff:target.dropoffPoints[0]}}),200);
  const before=await effects(f,created),replay=f.expect(await sell(f,body,key,cookie),200).data.booking;assert.equal(replay.tripId,target.id);assert.deepEqual(replay.seats,['A02']);assert.equal(replay.createdBy,created.createdBy);assert.deepEqual(await effects(f,created),before);
  const other=f.expect(await f.request('/admin/operators',{method:'POST',body:{name:'Nhà xe ngoài quầy',phone:'0907654321'}}),201).data.operator;
  // Fixture-only corruption distinguishes immutable booking scope from actual
  // inventory scope. Production editing cannot move an occupied trip.
  await f.db.transaction(tx=>tx.run('UPDATE trips SET operator_id=? WHERE id=?',[other.id,target.id]));
  assert.equal(f.expect(await sell(f,body,key,cookie),403).data.code,'FORBIDDEN');assert.deepEqual(await effects(f,created),before);
  assert.equal(trip.operatorId,created.trip.operatorId);
});

test('[IT-COUNTER-007] identical key text is isolated by staff account and unavailable to guests or customers',async t=>{
  const {f,body,cookie}=await setup(t),key='counter-account-namespace-007',first=f.expect(await sell(f,body,key,cookie),201).data.booking;
  const staff=await f.staff({email:'second-counter@example.test'}),secondCookie=(await f.login(staff.email,'StaffTest@12345')).cookie;
  const second=f.expect(await sell(f,{...body,seats:['A02']},key,secondCookie),201).data.booking;assert.notEqual(first.code,second.code);assert.equal(second.createdBy,staff.id);assert.equal(await count(f,'checkout_requests'),2);
  const customer=await f.customer('counter-denied');
  f.expect(await sell(f,body,key,null),403);f.expect(await sell(f,body,key,customer.cookie),403);assert.equal(await count(f,'bookings'),2);
});

test('[IT-COUNTER-008] queued staff revocation and changed operator assignment deny saved results without repeating writes',async t=>{
  const {f,staff,body,cookie}=await setup(t),key='counter-revoked-session-008',booking=f.expect(await sell(f,body,key,cookie),201).data.booking,before=await effects(f,booking);
  const revoked=await queued(f,()=>sell(f,body,key,cookie),async()=>{f.expect(await f.request('/admin/users/'+staff.id,{method:'PATCH',body:{active:false}}),200);});
  assert.equal(f.expect(revoked,403).data.code,'FORBIDDEN');assert.deepEqual(await effects(f,booking),before);
  const other=f.expect(await f.request('/admin/operators',{method:'POST',body:{name:'Nhà xe chuyển nhân viên',phone:'0907654321'}}),201).data.operator;
  f.expect(await f.request('/admin/users/'+staff.id,{method:'PATCH',body:{active:true,operatorId:other.id}}),200);const changed=(await f.login(staff.email,'StaffTest@12345')).cookie;
  assert.equal(f.expect(await sell(f,body,key,changed),403).data.code,'FORBIDDEN');assert.deepEqual(await effects(f,booking),before);
});

async function replayRace(f,booking,body,key,cookie,failures) {
  const original=f.db.transaction;let reads=0,remaining=failures;
  f.db.transaction=work=>original(tx=>{const get=tx.get;return work({...tx,get:async(sql,params)=>{
    const row=await get(sql,params);
    if(sql.startsWith('SELECT trip_id FROM bookings WHERE code=')&&params[0]===booking.code){reads++;if(remaining>0){remaining--;return {...row,trip_id:'moved-after-counter-trip-lock'};}}
    return row;
  }});});
  try{return {result:await sell(f,body,key,cookie),reads};}finally{f.db.transaction=original;}
}

test('[IT-COUNTER-009] replay lock-race fault injection retries fresh transactions and returns current booking once stable',async t=>{
  const {f,body,cookie}=await setup(t),key='counter-lock-race-retry-009',booking=f.expect(await sell(f,body,key,cookie),201).data.booking,before=await effects(f,booking);
  const {result,reads}=await replayRace(f,booking,body,key,cookie,2);f.expect(result,200);assert.equal(reads,3);assert.equal(result.data.replayed,true);assert.equal(result.data.booking.code,booking.code);assert.deepEqual(await effects(f,booking),before);
});

test('[IT-COUNTER-010] repeated replay lock-race faults return bounded retryable failure and retain the saved result',async t=>{
  const {f,body,cookie}=await setup(t),key='counter-lock-race-exhaust-010',booking=f.expect(await sell(f,body,key,cookie),201).data.booking,before=await effects(f,booking);
  const {result,reads}=await replayRace(f,booking,body,key,cookie,10);assert.equal(f.expect(result,503).data.code,'COUNTER_RETRY');assert.equal(reads,3);assert.deepEqual(await effects(f,booking),before);
  const recovered=f.expect(await sell(f,body,key,cookie),200);assert.equal(recovered.data.replayed,true);assert.deepEqual(await effects(f,booking),before);
});
