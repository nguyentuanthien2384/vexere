'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createFeatureFixture}=require('./helpers/feature-fixture');

const fixture=t=>createFeatureFixture(t,{databaseUrl:process.env.TEST_DATABASE_URL});
const count=async(f,table,where='',params=[])=>Number((await f.db.get('SELECT COUNT(*) AS n FROM '+table+(where?' WHERE '+where:''),params)).n);
const current=async(f,booking)=>f.expect(await f.request('/bookings/lookup?code='+booking.code+'&phone='+booking.phone,{cookie:null}),200).data.booking;
const cancel=(f,booking,extra={},cookie=null,staff=false)=>f.request((staff ? '/admin/bookings/' : '/bookings/')+booking.code+(staff ? '' : '/cancel'),{method:staff ? 'PATCH' : 'POST',cookie,body:{phone:booking.phone,...(staff ? {status:'cancelled'} : {}),...extra}});
const effects=async(f,booking)=>({
  row:await f.db.get('SELECT trip_id,status,payment_status,expires_at,data FROM bookings WHERE code=?',[booking.code]),
  seats:await f.db.all('SELECT trip_id,seat FROM reserved_seats WHERE booking_code=? ORDER BY seat',[booking.code]),
  events:await f.db.all('SELECT event,data FROM booking_events WHERE booking_code=? ORDER BY created_at,id',[booking.code]),
  receipts:await f.db.all('SELECT reference,status,amount FROM payments WHERE booking_code=? ORDER BY reference',[booking.code])
});
async function move(f,booking,trip,seats=['A01']) {
  return f.expect(await f.request('/admin/bookings/'+booking.code+'/reschedule',{method:'POST',body:{tripId:trip.id,seats,pickup:trip.pickupPoints[0],dropoff:trip.dropoffPoints[0]}}),200).data.booking;
}
async function queued(f,action,change) {
  const original=f.db.transaction;let entered,release,first=true,pending;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.db.transaction=work=>{if(first){first=false;return (async()=>{entered();await gate;return original(work);})();}return original(work);};
  try{pending=action();await ready;await change();release();return await pending;}
  finally{release();f.db.transaction=original;if(pending)await pending;}
}

test('[IT-CANCEL-001] origin consent rejects a later move and an A-to-B-to-A change before releasing inventory',async t=>{
  const f=await fixture(t),source=await f.trip(),target=await f.trip({departureTime:'20:00'}),booking=await current(f,await f.reserve(source));
  const moved=await move(f,booking,target),afterMove=await effects(f,booking);
  assert.equal(f.expect(await cancel(f,booking,{expectedSourceVersion:booking.rescheduleVersion}),409).data.code,'BOOKING_CHANGED');assert.deepEqual(await effects(f,booking),afterMove);
  const restored=await move(f,moved,source),afterReturn=await effects(f,booking);assert.notEqual(restored.rescheduleVersion,booking.rescheduleVersion);
  assert.equal(f.expect(await cancel(f,booking,{expectedSourceVersion:booking.rescheduleVersion}),409).data.code,'BOOKING_CHANGED');assert.deepEqual(await effects(f,booking),afterReturn);
  const canceled=f.expect(await cancel(f,restored,{expectedSourceVersion:restored.rescheduleVersion}),200).data.booking;assert.equal(canceled.status,'cancelled');assert.equal((await effects(f,booking)).seats.length,0);
});

test('[IT-CANCEL-002] payment collected while cancellation queues requires fresh review before requesting a refund',async t=>{
  const f=await fixture(t),trip=await f.trip(),booking=await current(f,await f.reserve(trip));
  const result=await queued(f,()=>cancel(f,booking,{expectedSourceVersion:booking.rescheduleVersion}),async()=>{
    f.expect(await f.request('/admin/bookings/'+booking.code+'/cash-receipt',{method:'POST',body:{reference:'CANCEL-CASH-002',amount:booking.total}}),200);
  });
  assert.equal(f.expect(result,409).data.code,'BOOKING_CHANGED');const paid=await current(f,booking);assert.equal(paid.paymentStatus,'paid');assert.equal(paid.status,'confirmed');assert.equal((await effects(f,booking)).seats.length,1);assert.equal(await count(f,'booking_events',"booking_code=? AND event='refund_requested'",[booking.code]),0);
  const canceled=f.expect(await cancel(f,paid,{expectedSourceVersion:paid.rescheduleVersion}),200).data.booking;assert.equal(canceled.status,'refund_pending');assert.equal(canceled.paymentStatus,'refund_pending');assert.equal((await effects(f,booking)).receipts.length,1);
});

test('[IT-CANCEL-003] staff status changes invalidate old consent and scope remains enforced before cancellation',async t=>{
  const f=await fixture(t),trip=await f.trip(),booking=await current(f,await f.reserve(trip)),staff=await f.staff(),cookie=(await f.login(staff.email,'StaffTest@12345')).cookie;
  const confirmed=f.expect(await f.request('/admin/bookings/'+booking.code,{method:'PATCH',cookie,body:{status:'confirmed'}}),200).data.booking,before=await effects(f,booking);
  assert.equal(f.expect(await cancel(f,booking,{expectedSourceVersion:booking.rescheduleVersion},cookie,true),409).data.code,'BOOKING_CHANGED');assert.deepEqual(await effects(f,booking),before);
  const other=f.expect(await f.request('/admin/operators',{method:'POST',body:{name:'Nhà xe ngoài phạm vi hủy',phone:'0907654321'}}),201).data.operator,outside=await f.trip({operatorId:other.id}),outsideBooking=await current(f,await f.reserve(outside));
  f.expect(await cancel(f,outsideBooking,{expectedSourceVersion:outsideBooking.rescheduleVersion},cookie,true),403);assert.equal((await current(f,outsideBooking)).status,'reserved');
  assert.equal(f.expect(await cancel(f,confirmed,{expectedSourceVersion:confirmed.rescheduleVersion},cookie,true),200).data.booking.status,'cancelled');
});

test('[IT-CANCEL-004] malformed active consent is rejected, legacy cancellation and terminal retries remain compatible',async t=>{
  const f=await fixture(t),trip=await f.trip(),booking=await current(f,await f.reserve(trip)),before=await effects(f,booking);
  for(const version of [null,123,'short','A'.repeat(64),'a'.repeat(65)])f.expect(await cancel(f,booking,{expectedSourceVersion:version}),400);
  assert.deepEqual(await effects(f,booking),before);
  const canceled=f.expect(await cancel(f,booking),200).data.booking;assert.equal(canceled.status,'cancelled');const after=await effects(f,booking);
  const replay=f.expect(await cancel(f,booking,{expectedSourceVersion:booking.rescheduleVersion}),200);assert.equal(replay.data.booking.status,'cancelled');assert.deepEqual(await effects(f,booking),after);
});

test('[IT-CANCEL-005] other passengers do not invalidate origin consent and version knowledge cannot bypass booking ownership',async t=>{
  const f=await fixture(t),trip=await f.trip(),booking=await current(f,await f.reserve(trip));
  await f.reserve(trip,{seats:['A02']});assert.equal((await current(f,booking)).rescheduleVersion,booking.rescheduleVersion);
  f.expect(await f.request('/bookings/'+booking.code+'/cancel',{method:'POST',cookie:null,body:{phone:'0909999999',expectedSourceVersion:booking.rescheduleVersion}}),404);assert.equal((await current(f,booking)).status,'reserved');
  const canceled=f.expect(await cancel(f,booking,{expectedSourceVersion:booking.rescheduleVersion}),200);assert.equal(canceled.data.booking.status,'cancelled');assert.equal(await count(f,'reserved_seats'),1);
});

test('[IT-CANCEL-006] staff revocation queued before locked cancellation denies both stale and otherwise valid consent',async t=>{
  const f=await fixture(t),trip=await f.trip(),booking=await current(f,await f.reserve(trip)),staff=await f.staff(),cookie=(await f.login(staff.email,'StaffTest@12345')).cookie,before=await effects(f,booking);
  const result=await queued(f,()=>cancel(f,booking,{expectedSourceVersion:booking.rescheduleVersion},cookie,true),async()=>{
    f.expect(await f.request('/admin/users/'+staff.id,{method:'PATCH',body:{active:false}}),200);
  });
  assert.equal(f.expect(result,403).data.code,'FORBIDDEN');assert.deepEqual(await effects(f,booking),before);
});

test('[IT-CANCEL-007] rescheduling committed before queued cancellation acquires locks returns source-changed consent error',async t=>{
  const f=await fixture(t),source=await f.trip(),target=await f.trip({departureTime:'20:00'}),booking=await current(f,await f.reserve(source));let afterMove;
  const result=await queued(f,()=>cancel(f,booking,{expectedSourceVersion:booking.rescheduleVersion}),async()=>{
    await move(f,booking,target);afterMove=await effects(f,booking);
  });
  assert.equal(f.expect(result,409).data.code,'BOOKING_CHANGED');assert.deepEqual(await effects(f,booking),afterMove);const moved=await current(f,booking);assert.equal(moved.tripId,target.id);assert.equal(moved.status,'reserved');
  const legacy=await queued(f,()=>cancel(f,moved),async()=>{await move(f,moved,source);});
  assert.equal(f.expect(legacy,409).data.code,'CONFLICT');assert.equal((await current(f,booking)).status,'reserved');
});
