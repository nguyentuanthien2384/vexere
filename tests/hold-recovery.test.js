'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createFeatureFixture}=require('./helpers/feature-fixture');

const fixture=t=>createFeatureFixture(t,{databaseUrl:process.env.TEST_DATABASE_URL});
const post=(body,cookie=null,key)=>({method:'POST',body,cookie,...(key ? {headers:{'Idempotency-Key':key}} : {})});
const detail=async(f,item,cookie=null)=>f.expect(await f.request('/trips/'+item.id,{cookie}),200).data;
const hold=async(f,item,{cookie=null,seats=['A01'],version}={})=>f.expect(await f.request('/holds',post({tripId:item.id,seats,...(version!==undefined ? {expectedBookingVersion:version} : {})},cookie)),201);
const counts=async f=>{
  const result={};
  for(const table of ['bookings','orders','reserved_seats','seat_holds','hold_seats','promotion_uses','checkout_requests','email_outbox'])result[table]=Number((await f.db.get('SELECT COUNT(*) AS n FROM '+table)).n);
  return result;
};
const promotion=async f=>f.expect(await f.request('/admin/promotions',post({code:'CONSENT50',title:'Ưu đãi xác nhận tổng tiền',type:'percentage',value:50,minSpend:0,maxDiscount:0,maxUses:20,perCustomer:5,startsAt:'2000-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'},f.adminCookie)),201).data.promotion;
const leg=(item,held,version)=>({tripId:item.id,seats:['A01'],pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0],holdToken:held.token,expectedBookingVersion:version});

test('[IT-HOLD-REC-001] fare changes between detail and hold require renewed booking terms consent before acquiring inventory',async t=>{
  const f=await fixture(t),item=await f.trip(),shown=await detail(f,item);
  assert.match(shown.bookingVersion,/^[a-f0-9]{64}$/);
  f.expect(await f.request('/admin/trips/'+item.id,{method:'PATCH',body:{price:300000}}),200);
  const before=await counts(f),stale=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A01'],expectedBookingVersion:shown.bookingVersion})),409);
  assert.equal(stale.data.code,'TRIP_CHANGED');assert.deepEqual(await counts(f),before);
  const current=await detail(f,item);assert.notEqual(current.bookingVersion,shown.bookingVersion);
  const held=await hold(f,item,{version:current.bookingVersion});
  const result=f.expect(await f.request('/bookings',post(f.bookingBody(item,{holdToken:held.data.hold.token,expectedBookingVersion:current.bookingVersion,expectedTotal:300000}))),201).data.booking;
  assert.equal(result.total,300000);
});

test('[IT-HOLD-REC-002] availability and operator presentation changes preserve the booking version for unchanged terms',async t=>{
  const f=await fixture(t),item=await f.trip(),before=await detail(f,item),held=await hold(f,item,{version:before.bookingVersion});
  const during=await detail(f,item,held.cookie);assert.equal(during.bookingVersion,before.bookingVersion);assert.equal(during.availableSeats,before.availableSeats-1);
  f.expect(await f.request('/admin/operators/'+item.operatorId,{method:'PATCH',body:{name:'Nhà xe đổi tên hiển thị'}}),200);
  const renamed=await detail(f,item);assert.equal(renamed.bookingVersion,before.bookingVersion);assert.equal(renamed.operatorName,'Nhà xe đổi tên hiển thị');
  const result=f.expect(await f.request('/bookings',post(f.bookingBody(item,{seats:['A02'],expectedBookingVersion:before.bookingVersion,expectedTotal:250000}))),201).data.booking;
  assert.equal(result.total,250000);assert.equal((await detail(f,item)).bookingVersion,before.bookingVersion);
});

test('[IT-HOLD-REC-003] malformed booking versions are rejected across holds quotes checkout and order legs without writes',async t=>{
  const f=await fixture(t),item=await f.trip(),back=await f.trip({from:'da-lat',to:'ho-chi-minh',date:require('../server/catalog').addDays(item.date,1)});
  const before=await counts(f);
  for(const expectedBookingVersion of [null,1,{},[],false,'','A'.repeat(64),'a'.repeat(63),'a'.repeat(65),'a'.repeat(64)+'\n']){
    const result=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A01'],expectedBookingVersion})),400);assert.equal(result.data.code,'VALIDATION_ERROR');
  }
  const invalidLeg={tripId:item.id,seats:['A01'],pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0],expectedBookingVersion:'invalid'};
  f.expect(await f.request('/promotions/quote',post({legs:[invalidLeg],phone:'0901234567'})),400);
  f.expect(await f.request('/bookings',post(f.bookingBody(item,{expectedBookingVersion:'invalid'}))),400);
  f.expect(await f.request('/orders',post({...f.bookingBody(item),legs:[invalidLeg,{tripId:back.id,seats:['A01'],pickup:back.pickupPoints[0],dropoff:back.dropoffPoints[0]}]})),400);
  assert.deepEqual(await counts(f),before);
});

test('[IT-HOLD-REC-004] rejected same owner replacement rolls back the original valid hold and its expiry',async t=>{
  const f=await fixture(t),item=await f.trip(),ready=f.expect(await f.request('/holds/session',post({})),200),shown=await detail(f,item);
  const original=await hold(f,item,{cookie:ready.cookie,version:shown.bookingVersion}),before=await counts(f);
  const rejected=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A02'],expectedBookingVersion:'0'.repeat(64)},ready.cookie)),409);
  assert.equal(rejected.data.code,'TRIP_CHANGED');assert.deepEqual(await counts(f),before);
  const remaining=await f.db.get('SELECT expires_at FROM seat_holds WHERE trip_id=?',[item.id]);assert.equal(remaining.expires_at,original.data.hold.expiresAt);
  const booked=f.expect(await f.request('/bookings',post(f.bookingBody(item,{holdToken:original.data.hold.token,expectedBookingVersion:shown.bookingVersion}),ready.cookie)),201).data.booking;
  assert.deepEqual(booked.seats,['A01']);
});

test('[IT-HOLD-REC-005] preparing a hold session creates no inventory and makes a lost first hold response safely replaceable',async t=>{
  const f=await fixture(t),item=await f.trip(),before=await counts(f);
  const ready=f.expect(await f.request('/holds/session',post({})),200);assert.deepEqual(ready.data,{ready:true});assert.ok(ready.cookie);
  f.expect(await f.request('/holds/session',post({},ready.cookie)),200);assert.deepEqual(await counts(f),before);
  const first=await hold(f,item,{cookie:ready.cookie});
  // Deliberately discard the first response's hold token and response cookie.
  const retried=await hold(f,item,{cookie:ready.cookie});assert.notEqual(retried.data.hold.token,first.data.hold.token);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM seat_holds WHERE trip_id=?',[item.id])).n),1);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM hold_seats WHERE trip_id=?',[item.id])).n),1);
  const old=f.expect(await f.request('/bookings',post(f.bookingBody(item,{holdToken:first.data.hold.token}),ready.cookie)),409);assert.equal(old.data.code,'HOLD_EXPIRED');
  f.expect(await f.request('/bookings',post(f.bookingBody(item,{holdToken:retried.data.hold.token}),ready.cookie)),201);
});

test('[IT-HOLD-REC-006] legacy clients can hold and book without new consent fields while server prices stay authoritative',async t=>{
  const f=await fixture(t),item=await f.trip({seatPrices:{A01:300000}}),held=await hold(f,item);
  const result=f.expect(await f.request('/bookings',post(f.bookingBody(item,{holdToken:held.data.hold.token,total:1}))),201).data.booking;
  assert.equal(result.total,300000);assert.equal(result.trip.price,250000);
});

test('[IT-HOLD-REC-007] stale checkout booking terms fail before inventory or idempotency records and a fresh consent can use the unused key',async t=>{
  const f=await fixture(t),item=await f.trip(),shown=await detail(f,item),key='trip-consent-checkout-key-0001';
  f.expect(await f.request('/admin/trips/'+item.id,{method:'PATCH',body:{pickupPoints:['Điểm đón mới'],price:300000}}),200);
  const before=await counts(f),stale=f.expect(await f.request('/bookings',post(f.bookingBody(item,{expectedBookingVersion:shown.bookingVersion}),null,key)),409);
  assert.equal(stale.data.code,'TRIP_CHANGED');assert.deepEqual(await counts(f),before);
  const current=await detail(f,item);
  f.expect(await f.request('/bookings',post(f.bookingBody(current,{expectedBookingVersion:current.bookingVersion,expectedTotal:300000}),null,key)),201);
});

test('[IT-HOLD-REC-008] guest preparation and hold ownership survive login session regeneration without changing the trip version',async t=>{
  const f=await fixture(t),customer=await f.customer('hold-login'),item=await f.trip(),shown=await detail(f,item);
  const ready=f.expect(await f.request('/holds/session',post({})),200),held=await hold(f,item,{cookie:ready.cookie,version:shown.bookingVersion});
  const login=f.expect(await f.request('/auth/login',post({email:customer.user.email,password:'Customer@12345'},ready.cookie)),200);assert.notEqual(login.cookie,ready.cookie);
  const trip=await detail(f,item,login.cookie);assert.equal(trip.seats.find(seat=>seat.label==='A01').ownHold,true);assert.equal(trip.bookingVersion,shown.bookingVersion);
  const booked=f.expect(await f.request('/bookings',post(f.bookingBody(item,{holdToken:held.data.hold.token,expectedBookingVersion:shown.bookingVersion,expectedTotal:250000}),login.cookie)),201).data.booking;
  assert.equal(booked.userId,customer.user.id);
});

test('[IT-HOLD-REC-009] changed single trip coupon totals reject stale consent without consuming hold coupon checkout key or email',async t=>{
  const f=await fixture(t),item=await f.trip(),shown=await detail(f,item);await promotion(f);
  const held=await hold(f,item,{version:shown.bookingVersion}),input=leg(item,held.data.hold,shown.bookingVersion);
  const quote=f.expect(await f.request('/promotions/quote',post({legs:[input],couponCode:'CONSENT50',phone:'0901234567'})),200).data;assert.equal(quote.total,125000);
  f.expect(await f.request('/admin/promotions/CONSENT50',{method:'PATCH',body:{value:20}}),200);
  const before=await counts(f),body=f.bookingBody(item,{...input,couponCode:'CONSENT50',expectedTotal:quote.total,total:1});
  const stale=f.expect(await f.request('/bookings',post(body,null,'single-price-consent-key-old')),409);assert.equal(stale.data.code,'PRICE_CHANGED');assert.deepEqual(await counts(f),before);
  const accepted=f.expect(await f.request('/bookings',post({...body,expectedTotal:200000},null,'single-price-consent-key-new')),201).data.booking;
  assert.equal(accepted.total,200000);assert.equal(accepted.discount,50000);
  const after=await counts(f);assert.equal(after.bookings,1);assert.equal(after.reserved_seats,1);assert.equal(after.promotion_uses,1);assert.equal(after.checkout_requests,1);assert.equal(after.seat_holds,0);
});

test('[IT-HOLD-REC-010] changed roundtrip totals roll back both holds and all aggregate records until the new amount is confirmed',async t=>{
  const f=await fixture(t),out=await f.trip(),back=await f.trip({from:'da-lat',to:'ho-chi-minh',date:require('../server/catalog').addDays(out.date,1)});await promotion(f);
  const outTrip=await detail(f,out),backTrip=await detail(f,back),a=await hold(f,out,{version:outTrip.bookingVersion}),b=await hold(f,back,{version:backTrip.bookingVersion});
  const legs=[leg(out,a.data.hold,outTrip.bookingVersion),leg(back,b.data.hold,backTrip.bookingVersion)];
  const quote=f.expect(await f.request('/promotions/quote',post({legs,couponCode:'CONSENT50',phone:'0901234567'})),200).data;assert.equal(quote.total,250000);
  f.expect(await f.request('/admin/promotions/CONSENT50',{method:'PATCH',body:{value:20}}),200);
  const before=await counts(f),body={...f.bookingBody(out),legs,couponCode:'CONSENT50',expectedTotal:quote.total};
  const stale=f.expect(await f.request('/orders',post(body,null,'roundtrip-price-consent-key-old')),409);assert.equal(stale.data.code,'PRICE_CHANGED');assert.deepEqual(await counts(f),before);
  const accepted=f.expect(await f.request('/orders',post({...body,expectedTotal:400000},null,'roundtrip-price-consent-key-new')),201).data.order;
  assert.equal(accepted.total,400000);assert.equal(accepted.bookings.reduce((sum,item)=>sum+item.total,0),400000);
  const after=await counts(f);assert.equal(after.orders,1);assert.equal(after.bookings,2);assert.equal(after.reserved_seats,2);assert.equal(after.promotion_uses,1);assert.equal(after.checkout_requests,1);assert.equal(after.seat_holds,0);
});

test('[IT-HOLD-REC-011] exact checkout replay retains the agreed result after coupon changes but changing consent under a used key conflicts',async t=>{
  const f=await fixture(t),item=await f.trip(),shown=await detail(f,item);await promotion(f);
  const held=await hold(f,item,{version:shown.bookingVersion}),body=f.bookingBody(item,{...leg(item,held.data.hold,shown.bookingVersion),couponCode:'CONSENT50',expectedTotal:125000}),key='agreed-total-exact-replay-key';
  const first=f.expect(await f.request('/bookings',post(body,null,key)),201).data.booking;
  f.expect(await f.request('/admin/promotions/CONSENT50',{method:'PATCH',body:{value:20}}),200);
  const before=await counts(f),replay=f.expect(await f.request('/bookings',post(body,null,key)),201);assert.equal(replay.data.replayed,true);assert.equal(replay.data.booking.code,first.code);assert.equal(replay.data.booking.total,125000);assert.deepEqual(await counts(f),before);
  const changed=f.expect(await f.request('/bookings',post({...body,expectedTotal:200000},null,key)),409);assert.equal(changed.data.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(await counts(f),before);
});

test('[IT-HOLD-REC-012] expected total validates numeric safe integers without coercion and zero is consent rather than an absent field',async t=>{
  const f=await fixture(t),item=await f.trip(),before=await counts(f);
  for(const expectedTotal of [null,'250000',true,[],{},-1,.5,Number.MAX_SAFE_INTEGER+1]){
    const result=f.expect(await f.request('/bookings',post(f.bookingBody(item,{expectedTotal}))),400);assert.equal(result.data.code,'VALIDATION_ERROR');
  }
  const zero=f.expect(await f.request('/bookings',post(f.bookingBody(item,{expectedTotal:0}))),409);assert.equal(zero.data.code,'PRICE_CHANGED');assert.deepEqual(await counts(f),before);
  f.expect(await f.request('/bookings',post(f.bookingBody(item,{expectedTotal:250000,total:0}))),201);
});

test('[IT-HOLD-REC-013] reschedule version conflicts retain both the original booking and target hold until current terms are confirmed',async t=>{
  const f=await fixture(t),source=await f.trip(),target=await f.trip({departureTime:'20:00'}),booking=await f.reserve(source),shown=await detail(f,target),held=await hold(f,target,{version:shown.bookingVersion});
  const before=await counts(f),body={...f.bookingBody(target),holdToken:held.data.hold.token,expectedBookingVersion:'0'.repeat(64)};
  const conflict=f.expect(await f.request('/bookings/'+booking.code+'/reschedule',post(body)),409);assert.equal(conflict.data.code,'TRIP_CHANGED');assert.deepEqual(await counts(f),before);
  const current=await f.db.get('SELECT trip_id FROM bookings WHERE code=?',[booking.code]);assert.equal(current.trip_id,source.id);
  const result=f.expect(await f.request('/bookings/'+booking.code+'/reschedule',post({...body,expectedBookingVersion:shown.bookingVersion})),200).data.booking;
  assert.equal(result.tripId,target.id);assert.equal(result.previousTrips.length,1);assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM seat_holds WHERE trip_id=?',[target.id])).n),0);
});

test('[IT-HOLD-REC-014] delayed conditional renewal preserves a newer same owner selection and only the current token may replace it',async t=>{
  const f=await fixture(t),item=await f.trip(),ready=f.expect(await f.request('/holds/session',post({})),200),cookie=ready.cookie;
  const first=await hold(f,item,{cookie}),newer=await hold(f,item,{cookie,seats:['A02']}),before=await counts(f);
  for(const expectedHoldToken of [first.data.hold.token,null]){
    const stale=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A01'],expectedHoldToken},cookie)),409);
    assert.equal(stale.data.code,'HOLD_CHANGED');assert.deepEqual(await counts(f),before);
    const remaining=await f.db.get('SELECT expires_at,data FROM seat_holds WHERE trip_id=?',[item.id]);
    assert.equal(remaining.expires_at,newer.data.hold.expiresAt);assert.deepEqual(JSON.parse(remaining.data).seats,['A02']);
  }
  const replacement=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A03'],expectedHoldToken:newer.data.hold.token},cookie)),201).data.hold;
  assert.notEqual(replacement.token,newer.data.hold.token);
  const shown=await detail(f,item,cookie);assert.equal(shown.seats.find(seat=>seat.label==='A02').status,'available');assert.equal(shown.seats.find(seat=>seat.label==='A03').ownHold,true);
  const booked=f.expect(await f.request('/bookings',post(f.bookingBody(item,{seats:['A03'],holdToken:replacement.token}),cookie)),201).data.booking;
  assert.deepEqual(booked.seats,['A03']);
});

test('[IT-HOLD-REC-015] conditional renewal validates tokens and accepts expired or absent own holds without disturbing another owner',async t=>{
  const f=await fixture(t),item=await f.trip(),ready=f.expect(await f.request('/holds/session',post({})),200),cookie=ready.cookie;
  const own=await hold(f,item,{cookie}),other=await hold(f,item,{seats:['A06']}),before=await counts(f);
  for(const expectedHoldToken of ['',false,1,{},[],['a'.repeat(64)],'A'.repeat(64),'a'.repeat(63),'a'.repeat(65),'a'.repeat(64)+'\n']){
    const invalid=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A02'],expectedHoldToken},cookie)),400);
    assert.equal(invalid.data.code,'VALIDATION_ERROR');assert.deepEqual(await counts(f),before);
  }
  const ownHash=crypto.createHash('sha256').update(own.data.hold.token).digest('hex');
  await f.db.run('UPDATE seat_holds SET expires_at=? WHERE hash=?',[new Date(Date.now()-1000).toISOString(),ownHash]);
  const renewed=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A02'],expectedHoldToken:own.data.hold.token},cookie)),201).data.hold;
  f.expect(await f.request('/holds/'+renewed.token,{method:'DELETE',cookie}),200);
  const fromNone=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A03'],expectedHoldToken:null},cookie)),201).data.hold;
  f.expect(await f.request('/holds/'+fromNone.token,{method:'DELETE',cookie}),200);
  const withAbsentToken=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A04'],expectedHoldToken:own.data.hold.token},cookie)),201).data.hold;
  assert.deepEqual(withAbsentToken.seats,['A04']);
  const shown=await detail(f,item,cookie);assert.equal(shown.seats.find(seat=>seat.label==='A04').ownHold,true);assert.equal(shown.seats.find(seat=>seat.label==='A06').status,'held');assert.equal(shown.seats.find(seat=>seat.label==='A06').ownHold,false);
  f.expect(await f.request('/bookings',post(f.bookingBody(item,{seats:['A06'],holdToken:other.data.hold.token}),other.cookie)),201);
});

test('[IT-HOLD-REC-016] lost conditional renewal responses can retry the same hashed predecessor and ordered seats without replacing newer choices',async t=>{
  const f=await fixture(t),item=await f.trip(),ready=f.expect(await f.request('/holds/session',post({})),200),cookie=ready.cookie;
  const original=await hold(f,item,{cookie}),anchor=original.data.hold.token;
  const body={tripId:item.id,seats:['A03','A04'],expectedHoldToken:anchor};
  // The renewal commits, but the client deliberately keeps only its old token.
  const lost=f.expect(await f.request('/holds',post(body,cookie)),201).data.hold;
  const stored=JSON.parse((await f.db.get('SELECT data FROM seat_holds WHERE trip_id=?',[item.id])).data);
  assert.equal(stored.renewalPredecessorHash,crypto.createHash('sha256').update(anchor).digest('hex'));
  assert.equal(JSON.stringify(stored).includes(anchor),false);
  const retried=f.expect(await f.request('/holds',post(body,cookie)),201).data.hold;
  assert.notEqual(retried.token,lost.token);assert.deepEqual(retried.seats,body.seats);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM seat_holds WHERE trip_id=?',[item.id])).n),1);
  const before=await counts(f);
  for(const changed of [{seats:['A04','A03']},{seats:['A05']},{expectedHoldToken:'f'.repeat(64)},{expectedHoldToken:null}]){
    const rejected=f.expect(await f.request('/holds',post({...body,...changed},cookie)),409);
    assert.equal(rejected.data.code,'HOLD_CHANGED');assert.deepEqual(await counts(f),before);
  }
  const manual=await hold(f,item,{cookie,seats:['A02']});
  const manualData=JSON.parse((await f.db.get('SELECT data FROM seat_holds WHERE trip_id=?',[item.id])).data);
  assert.equal(Object.hasOwn(manualData,'renewalPredecessorHash'),false);
  assert.equal(f.expect(await f.request('/holds',post(body,cookie)),409).data.code,'HOLD_CHANGED');
  f.expect(await f.request('/bookings',post(f.bookingBody(item,{seats:['A02'],holdToken:manual.data.hold.token}),cookie)),201);

  const empty=await f.trip({departureTime:'20:00'}),emptyBody={tripId:empty.id,seats:['A01','A02'],expectedHoldToken:null};
  f.expect(await f.request('/holds',post(emptyBody,cookie)),201);
  const nullStored=JSON.parse((await f.db.get('SELECT data FROM seat_holds WHERE trip_id=?',[empty.id])).data);
  assert.equal(Object.hasOwn(nullStored,'renewalPredecessorHash'),true);assert.equal(nullStored.renewalPredecessorHash,null);
  const emptyRetry=f.expect(await f.request('/holds',post(emptyBody,cookie)),201).data.hold;
  assert.deepEqual(emptyRetry.seats,emptyBody.seats);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM seat_holds WHERE trip_id=?',[empty.id])).n),1);
  assert.equal(f.expect(await f.request('/holds',post({...emptyBody,seats:['A03']},cookie)),409).data.code,'HOLD_CHANGED');
  assert.equal(f.expect(await f.request('/holds',post({...emptyBody,expectedHoldToken:anchor},cookie)),409).data.code,'HOLD_CHANGED');
  const emptyShown=await detail(f,empty,cookie);assert.equal(emptyShown.seats.find(seat=>seat.label==='A01').ownHold,true);assert.equal(emptyShown.seats.find(seat=>seat.label==='A02').ownHold,true);
});
