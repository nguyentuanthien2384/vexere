'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createFeatureFixture}=require('./helpers/feature-fixture');

const fixture=t=>createFeatureFixture(t,{databaseUrl:process.env.TEST_DATABASE_URL});
const post=(body,cookie,key)=>({method:'POST',body,cookie,...(key ? {headers:{'Idempotency-Key':key}} : {})});
const current=async(f,booking,cookie=f.adminCookie)=>{
  const result=f.expect(await f.request('/admin/bookings?code='+booking.code,{cookie}),200).data;
  assert.equal(result.total,1);assert.equal(result.bookings.length,1);return result.bookings[0];
};
const target=async(f,trip)=>f.expect(await f.request('/trips/'+trip.id,{cookie:null}),200).data;
const payload=(booking,trip,extra={})=>({tripId:trip.id,seats:['A01'],pickup:trip.pickupPoints[0],dropoff:trip.dropoffPoints[0],expectedSourceVersion:booking.rescheduleVersion,expectedBookingVersion:trip.bookingVersion,...extra});
const move=(f,booking,body,key,cookie=f.adminCookie)=>f.request('/admin/bookings/'+booking.code+'/reschedule',post(body,cookie,key));
const count=async(f,table,where='',params=[])=>Number((await f.db.get('SELECT COUNT(*) AS n FROM '+table+(where?' WHERE '+where:''),params)).n);
const effects=async(f,booking)=>({
  history:await count(f,'booking_events',"booking_code=? AND event='rescheduled'",[booking.code]),
  audit:await count(f,'admin_audit_events',"entity_id=? AND action='booking_rescheduled'",[booking.code]),
  keys:await count(f,'checkout_requests'),
  seats:await f.db.all('SELECT trip_id,seat FROM reserved_seats WHERE booking_code=? ORDER BY seat',[booking.code]),
  receipts:await f.db.all('SELECT reference,provider,amount,status FROM payments WHERE booking_code=? ORDER BY reference',[booking.code])
});
async function setup(t) {
  const f=await fixture(t),source=await f.trip(),destination=await f.trip({departureTime:'20:00'}),later=await f.trip({departureTime:'22:00'});
  const staff=await f.staff(),cookie=(await f.login(staff.email,'StaffTest@12345')).cookie;
  const booking=await current(f,await f.reserve(source),cookie);
  return {f,source,destination,later,staff,cookie,booking};
}

// Pause one request after middleware/origin lookup, before transaction entry.
// The competing mutation uses the ordinary HTTP API and completes before the
// paused request acquires any lock. This is deterministic on both databases.
async function queued(f,action,change) {
  const original=f.db.transaction;let entered,release,first=true,pending;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.db.transaction=work=>{if(first){first=false;return (async()=>{entered();await gate;return original(work);})();}return original(work);};
  try {pending=action();await ready;await change();release();return await pending;}
  finally {release();f.db.transaction=original;if(pending)await pending;}
}

test('[IT-ADMIN-RSCH-001] scoped admin list supplies stable origin consent despite other inventory and source closure',async t=>{
  const {f,source,destination,cookie,booking}=await setup(t);
  assert.match(booking.rescheduleVersion,/^[a-f0-9]{64}$/);const shown=await target(f,destination);assert.match(shown.bookingVersion,/^[a-f0-9]{64}$/);
  await f.reserve(source,{seats:['A02']});
  f.expect(await f.request('/admin/trips/'+source.id,{method:'DELETE'}),200);
  const refreshed=await current(f,booking,cookie);assert.equal(refreshed.rescheduleVersion,booking.rescheduleVersion);assert.equal(refreshed.trip.active,true);assert.equal(refreshed.trip.pickupPoints[0],booking.pickup);
  const other=f.expect(await f.request('/admin/operators',{method:'POST',body:{name:'Nhà xe ngoài phạm vi đổi chuyến',phone:'0907654321'}}),201).data.operator;
  const outside=await f.trip({operatorId:other.id});const outsider=await f.reserve(outside);
  const invisible=f.expect(await f.request('/admin/bookings?code='+outsider.code,{cookie}),200).data;assert.equal(invisible.total,0);assert.deepEqual(invisible.bookings,[]);
  const stored=JSON.parse((await f.db.get('SELECT data FROM bookings WHERE code=?',[booking.code])).data);assert.equal(Object.hasOwn(stored,'rescheduleVersion'),false);assert.equal((await effects(f,booking)).history,0);
});

test('[IT-ADMIN-RSCH-002] operator can change another customer booking without customer phone and preserves its identity and finances',async t=>{
  const {f,source,destination,cookie}=await setup(t),owner=await f.customer('admin-reschedule-owner');
  const booking=await current(f,await f.reserve(source,{cookie:owner.cookie,seats:['A02']}),cookie),shown=await target(f,destination),body=payload(booking,shown,{seats:['A02']}),key='admin-reschedule-without-phone-002';
  assert.equal(Object.hasOwn(body,'phone'),false);assert.equal(Object.hasOwn(body,'holdToken'),false);
  f.expect(await move(f,booking,body,key,null),403);f.expect(await move(f,booking,body,key,owner.cookie),403);
  assert.equal((await effects(f,booking)).keys,0);
  const changed=f.expect(await move(f,booking,body,key,cookie),200).data.booking;
  for(const field of ['code','userId','fullName','phone','email','subtotal','discount','total','paymentMethod','paymentStatus','couponCode','orderCode','source'])assert.equal(changed[field],booking[field],field);
  assert.equal(changed.tripId,destination.id);assert.deepEqual(changed.seats,['A02']);assert.equal(changed.previousTrips.length,1);
  const writes=await effects(f,booking);assert.equal(writes.history,1);assert.equal(writes.audit,1);assert.equal(writes.keys,1);
});

test('[IT-ADMIN-RSCH-003] receipt committed while staff request queues invalidates source consent and corrected request reuses the rejected key',async t=>{
  const {f,destination,cookie,booking}=await setup(t),shown=await target(f,destination),body=payload(booking,shown),key='admin-reschedule-paid-source-003';
  const rejected=await queued(f,()=>move(f,booking,body,key,cookie),async()=>{
    f.expect(await f.request('/admin/bookings/'+booking.code+'/cash-receipt',{method:'POST',cookie,body:{reference:'ADMIN-RSCH-CASH-003',amount:booking.total}}),200);
  });
  assert.equal(f.expect(rejected,409).data.code,'BOOKING_CHANGED');const before=await effects(f,booking);assert.equal(before.keys,0);assert.equal(before.history,0);assert.equal(before.receipts.length,1);
  const paid=await current(f,booking,cookie);assert.notEqual(paid.rescheduleVersion,booking.rescheduleVersion);assert.equal(paid.status,'confirmed');assert.equal(paid.paymentStatus,'paid');
  const changed=f.expect(await move(f,paid,payload(paid,shown),key,cookie),200).data.booking;assert.equal(changed.paymentStatus,'paid');assert.equal(changed.status,'confirmed');assert.equal(changed.total,booking.total);assert.deepEqual((await effects(f,booking)).receipts,before.receipts);
});

test('[IT-ADMIN-RSCH-004] staff confirmation and cancellation require a fresh origin review and cannot create a new move on canceled booking',async t=>{
  const {f,destination,later,cookie,booking}=await setup(t),shown=await target(f,destination),key='admin-reschedule-confirm-source-004';
  const confirmed=f.expect(await f.request('/admin/bookings/'+booking.code,{method:'PATCH',cookie,body:{status:'confirmed'}}),200).data.booking;
  assert.notEqual(confirmed.rescheduleVersion,booking.rescheduleVersion);
  assert.equal(f.expect(await move(f,booking,payload(booking,shown),key,cookie),409).data.code,'BOOKING_CHANGED');assert.equal((await effects(f,booking)).keys,0);
  const moved=f.expect(await move(f,confirmed,payload(confirmed,shown),key,cookie),200).data.booking;
  const canceled=f.expect(await f.request('/admin/bookings/'+booking.code,{method:'PATCH',cookie,body:{status:'cancelled'}}),200).data.booking,another=await target(f,later),before=await effects(f,booking);
  assert.equal(f.expect(await move(f,moved,payload(moved,another),'admin-reschedule-cancel-stale-004',cookie),409).data.code,'BOOKING_CHANGED');
  assert.equal(f.expect(await move(f,canceled,payload(canceled,another),'admin-reschedule-cancel-fresh-004',cookie),409).data.code,'INVALID_TRANSITION');
  assert.deepEqual(await effects(f,booking),before);assert.deepEqual(before.seats,[]);
});

test('[IT-ADMIN-RSCH-005] changed target consent takes precedence over removed points and leaves its key reusable after staff review',async t=>{
  const {f,destination,cookie,booking}=await setup(t),shown=await target(f,destination),body=payload(booking,shown),key='admin-reschedule-target-consent-005',before=await effects(f,booking);
  f.expect(await f.request('/admin/trips/'+destination.id,{method:'PATCH',body:{departureTime:'21:00',pickupPoints:['Điểm đón mới đã xác nhận'],dropoffPoints:['Điểm trả mới đã xác nhận']}}),200);
  assert.equal(f.expect(await move(f,booking,body,key,cookie),409).data.code,'TRIP_CHANGED');assert.deepEqual(await effects(f,booking),before);
  const fresh=await target(f,destination);assert.notEqual(fresh.bookingVersion,shown.bookingVersion);
  const result=f.expect(await move(f,booking,payload(booking,fresh),key,cookie),200).data.booking;assert.equal(result.trip.departureTime,'21:00');assert.equal(result.pickup,fresh.pickupPoints[0]);assert.equal(result.dropoff,fresh.dropoffPoints[0]);assert.equal(result.total,booking.total);
});

test('[IT-ADMIN-RSCH-006] staff exact replay after refund returns current financial state even when old target is closed',async t=>{
  const {f,destination,cookie,booking}=await setup(t),shown=await target(f,destination),body=payload(booking,shown),key='admin-reschedule-refunded-replay-006';
  f.expect(await move(f,booking,body,key,cookie),200);
  f.expect(await f.request('/admin/bookings/'+booking.code+'/cash-receipt',{method:'POST',cookie,body:{reference:'ADMIN-RSCH-CASH-006',amount:booking.total}}),200);
  const pending=f.expect(await f.request('/admin/bookings/'+booking.code,{method:'PATCH',cookie,body:{status:'cancelled'}}),200).data.booking;assert.equal(pending.status,'refund_pending');
  f.expect(await f.request('/admin/bookings/'+booking.code+'/refund-receipt',{method:'POST',cookie,body:{reference:'ADMIN-RSCH-REFUND-006',amount:booking.total}}),200);
  f.expect(await f.request('/admin/trips/'+destination.id,{method:'DELETE'}),200);const before=await effects(f,booking);
  const replay=f.expect(await move(f,booking,body,key,cookie),200);assert.equal(replay.data.replayed,true);assert.equal(replay.headers.get('Idempotency-Replayed'),'true');assert.equal(replay.data.booking.status,'cancelled');assert.equal(replay.data.booking.paymentStatus,'refunded');assert.notEqual(replay.data.booking.rescheduleVersion,booking.rescheduleVersion);assert.deepEqual(await effects(f,booking),before);assert.deepEqual(before.seats,[]);assert.equal(before.receipts.length,2);
});

test('[IT-ADMIN-RSCH-007] saved staff request is isolated by account while its owner replay returns a later move without rollback',async t=>{
  const {f,destination,later,staff,cookie,booking}=await setup(t),shown=await target(f,destination),body=payload(booking,shown),key='admin-reschedule-account-key-007';
  const moved=f.expect(await move(f,booking,body,key,cookie),200).data.booking;
  const second=await f.staff({email:'second-reschedule-staff@example.test'}),otherCookie=(await f.login(second.email,'StaffTest@12345')).cookie;assert.notEqual(second.id,staff.id);
  const before=await effects(f,booking),stale=f.expect(await move(f,booking,body,key,otherCookie),409);assert.equal(stale.data.code,'BOOKING_CHANGED');assert.deepEqual(await effects(f,booking),before);
  const next=await target(f,later);f.expect(await move(f,moved,payload(moved,next),key,otherCookie),200);const after=await effects(f,booking);assert.equal(after.keys,2);assert.equal(after.history,2);assert.equal(after.audit,2);
  const replay=f.expect(await move(f,booking,body,key,cookie),200);assert.equal(replay.data.replayed,true);assert.equal(replay.data.booking.tripId,later.id);assert.equal(replay.data.booking.previousTrips.length,2);assert.deepEqual(await effects(f,booking),after);
});
