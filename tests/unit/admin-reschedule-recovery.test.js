'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const recovery=require('../../public/admin/reschedule-recovery');
const now=Date.parse('2028-02-20T00:00:00Z');
const owner={id:'staff-a',role:'operator',operatorId:'operator-a'};
const trip={id:'trip-a',operatorId:'operator-a',from:'from-a',to:'to-a',source:'managed',date:'2028-02-29',departureTime:'08:30',price:100000,pickupPoints:['Văn phòng','Bến xe'],dropoffPoints:['Điểm cuối']};
const booking={code:'T4TTEST',tripId:trip.id,fullName:'Khách hàng',seats:['A01','A02'],status:'reserved',paymentStatus:'pending',total:180000,subtotal:200000,pickup:'Văn phòng',dropoff:'Điểm cuối',expiresAt:null,rescheduleVersion:'a'.repeat(64),trip};
const target={...trip,id:'trip-b',departureTime:'12:00',bookingVersion:'b'.repeat(64),seats:[{label:'B01',price:90000,status:'available'},{label:'B02',price:110000,status:'available'}]};
const input=()=>({ownerId:owner.id,ownerRole:owner.role,ownerOperatorId:owner.operatorId,booking:structuredClone(booking),target:structuredClone(target),seats:['B02','B01'],pickup:'Bến xe',dropoff:'Điểm cuối',key:'staff.reschedule:key-123',now});
const saved=()=>recovery.create(input());
const encoded=value=>JSON.stringify(value);

test('[UT-ADMIN-RSCH-001] lost-response reload restores exact endpoint key ordered choices and both reviewed versions',()=>{
  const attempt=saved(),restored=recovery.read(encoded(attempt),owner,now+1000);
  assert.deepEqual(restored,attempt);assert.deepEqual(restored.body.seats,['B02','B01']);assert.equal(restored.path,'/admin/bookings/T4TTEST/reschedule');assert.equal(restored.body.expectedSourceVersion,booking.rescheduleVersion);assert.equal(restored.body.expectedBookingVersion,target.bookingVersion);
});
test('[UT-ADMIN-RSCH-002] request is detached from subsequent live booking target and selection mutations',()=>{
  const request=input(),attempt=recovery.create(request);request.booking.fullName='Changed';request.target.seats[0].price=1;request.seats.reverse();
  assert.equal(attempt.booking.fullName,'Khách hàng');assert.equal(attempt.target.seats[0].price,90000);assert.deepEqual(attempt.body.seats,['B02','B01']);assert.throws(()=>{attempt.body.pickup='Changed';},TypeError);
});
test('[UT-ADMIN-RSCH-003] cash booking without expiry and discounted financial snapshot remains recoverable',()=>{
  const attempt=saved();assert.equal(attempt.booking.expiresAt,null);assert.equal(attempt.booking.total,180000);assert.equal(attempt.booking.subtotal,200000);
  const request=input();delete request.booking.expiresAt;assert.equal(recovery.read(encoded(recovery.create(request)),owner,now+1).booking.expiresAt,null);
});
test('[UT-ADMIN-RSCH-004] another staff identity or changed role and operator scope cannot load private recovery',()=>{
  for(const changed of [{...owner,id:'staff-b'},{...owner,role:'admin'},{...owner,operatorId:'operator-b'},null])assert.equal(recovery.read(encoded(saved()),changed,now+1),null);
});
test('[UT-ADMIN-RSCH-005] recovery expires at twenty four hours and rejects future or malformed timestamps',()=>{
  assert.ok(recovery.read(encoded(saved()),owner,now+recovery.TTL-1));assert.equal(recovery.read(encoded(saved()),owner,now+recovery.TTL),null);
  for(const createdAt of [now+1,'2028-02-20',null,-1])assert.equal(recovery.read(encoded({...saved(),createdAt}),owner,now),null);
});
test('[UT-ADMIN-RSCH-006] malformed oversize and unknown schema caches cannot expose saved passenger details',()=>{
  for(const raw of ['',null,'{','[]','null','x'.repeat(recovery.MAX_BYTES+1),encoded({...saved(),schema:2}),encoded({...saved(),unexpected:'data'})])assert.equal(recovery.read(raw,owner,now+1),null);
});
test('[UT-ADMIN-RSCH-007] body code path target stamp source stamp and added payload fields must match the original snapshots',()=>{
  const changed=mutate=>{const value=JSON.parse(encoded(saved()));mutate(value);return encoded(value);};
  for(const mutate of [value=>value.path='/admin/bookings/OTHER/reschedule',value=>value.body.tripId='trip-c',value=>value.body.expectedSourceVersion='c'.repeat(64),value=>value.body.expectedBookingVersion='d'.repeat(64),value=>value.body.phone='0901234567',value=>value.booking.tripId='another',value=>value.target.operatorId='other'])assert.equal(recovery.read(changed(mutate),owner,now+1),null);
});
test('[UT-ADMIN-RSCH-008] impossible calendar dates clock times and API-invalid idempotency keys are rejected safely',()=>{
  for(const field of ['booking','target'])for(const changed of [{date:'2028-99-99'},{date:'2027-02-29'},{date:'2028-02-30'},{departureTime:'24:00'},{departureTime:'18:60'}]){const value=JSON.parse(encoded(saved()));Object.assign(field==='booking'?value.booking.trip:value.target,changed);assert.equal(recovery.read(encoded(value),owner,now+1),null);}
  for(const key of ['short','a'.repeat(129),'key with spaces 12345'])assert.throws(()=>recovery.create({...input(),key}));
  assert.ok(recovery.create({...input(),key:'a'.repeat(128)}));
});
test('[UT-ADMIN-RSCH-009] changed ordered seats trip points and booking code require restoring original choices',()=>{
  const attempt=saved(),choices={code:booking.code,tripId:target.id,seats:['B02','B01'],pickup:'Bến xe',dropoff:'Điểm cuối'};
  assert.equal(recovery.matches(attempt,choices),true);
  for(const changed of [{code:'OTHER'},{tripId:'trip-c'},{seats:['B01','B02']},{pickup:'Văn phòng'},{dropoff:'Khác'}])assert.equal(recovery.matches(attempt,{...choices,...changed}),false);
});
test('[UT-ADMIN-RSCH-010] wrong route duplicate or unavailable labels invalid price and mismatched seat count cannot form a request',()=>{
  for(const mutate of [value=>value.target.from='other',value=>value.target.id=value.booking.tripId,value=>value.seats=['B01'],value=>value.seats=['B01','B01'],value=>value.seats=['B01','OTHER'],value=>value.target.seats[0].price=90001,value=>value.pickup='Missing',value=>value.booking.code='invalid/path']){const value=input();mutate(value);assert.throws(()=>recovery.create(value));}
});
