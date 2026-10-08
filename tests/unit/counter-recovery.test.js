'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const recovery=require('../../public/admin/counter-recovery');
const now=Date.parse('2028-02-20T00:00:00Z');
const actor={id:'staff-a',role:'operator',operatorId:'operator-a'};
const trip={id:'trip-a',operatorId:'operator-a',from:'from-a',to:'to-a',source:'managed',date:'2028-02-29',departureTime:'08:30',price:100000,bookingVersion:'a'.repeat(64),pickupPoints:['Văn phòng','Bến xe'],dropoffPoints:['Điểm cuối'],seats:[{label:'A01',price:90000,status:'available',deck:1},{label:'A02',price:110000,status:'available',deck:1},{label:'A03',price:100000,status:'held'}]};
const passenger={fullName:'Hành khách tại quầy',phone:'0901234567',email:'',pickup:'Bến xe',dropoff:'Điểm cuối'};
const input=()=>({actor:{...actor},trip:structuredClone(trip),seats:['A02','A01'],passenger:{...passenger},key:'counter.request:123456',now});
const saved=()=>recovery.create(input());
const encoded=value=>JSON.stringify(value);

test('[UT-COUNTER-001] reload preserves exact staff endpoint ordered seats key fare and reviewed trip version',()=>{
  const attempt=saved();assert.deepEqual(recovery.read(encoded(attempt),actor,now+1),attempt);assert.equal(attempt.path,'/admin/bookings');assert.deepEqual(attempt.body.seats,['A02','A01']);assert.equal(attempt.body.expectedTotal,200000);assert.equal(attempt.body.expectedBookingVersion,trip.bookingVersion);assert.equal(attempt.body.email,'');assert.equal(attempt.body.paymentMethod,'cash');
});
test('[UT-COUNTER-002] immutable request does not change when form selection live trip or actor changes',()=>{
  const request=input(),attempt=recovery.create(request);request.trip.seats[0].price=1;request.seats.reverse();request.passenger.phone='0909999999';request.actor.operatorId='other';assert.deepEqual(attempt.body.seats,['A02','A01']);assert.equal(attempt.body.expectedTotal,200000);assert.equal(attempt.body.phone,passenger.phone);assert.equal(attempt.actor.operatorId,actor.operatorId);assert.throws(()=>{attempt.body.email='other@example.test';},TypeError);assert.throws(()=>{attempt.trip.seats[0].price=1;},TypeError);
});
test('[UT-COUNTER-003] cached passenger recovery is bound to identity role operator and a valid staff role',()=>{
  for(const owner of [null,{...actor,id:'staff-b'},{...actor,role:'admin'},{...actor,operatorId:'operator-b'},{...actor,role:'customer'}])assert.equal(recovery.read(encoded(saved()),owner,now+1),null);
  assert.throws(()=>recovery.create({...input(),actor:{...actor,operatorId:'operator-b'}}));assert.ok(recovery.create({...input(),actor:{id:'root',role:'admin',operatorId:null}}));
});
test('[UT-COUNTER-004] twenty four hour expiry future malformed and oversize cache cannot restore',()=>{
  const value=saved();assert.ok(recovery.read(encoded(value),actor,now+recovery.TTL-1));assert.equal(recovery.read(encoded(value),actor,now+recovery.TTL),null);
  for(const createdAt of [now+1,-1,'2028-02-20',null])assert.equal(recovery.read(encoded({...value,createdAt}),actor,now),null);
  for(const raw of ['',null,'{','[]','null','x'.repeat(recovery.MAX_LENGTH+1),encoded({...value,schema:2}),encoded({...value,extra:true})])assert.equal(recovery.read(raw,actor,now+1),null);
});
test('[UT-COUNTER-005] payload path fare trip version payment method and unexpected body fields must match snapshot',()=>{
  for(const mutate of [value=>value.path='/bookings',value=>value.body.tripId='other',value=>value.body.expectedTotal++,value=>value.body.expectedBookingVersion='b'.repeat(64),value=>value.body.paymentMethod='momo',value=>value.body.holdToken='extra',value=>value.actor.extra='data',value=>value.body.pickup='Missing']){const value=JSON.parse(encoded(saved()));mutate(value);assert.equal(recovery.read(encoded(value),actor,now+1),null);}
});
test('[UT-COUNTER-006] invalid calendar clocks key lengths and source terms are rejected',()=>{
  for(const change of [{date:'2028-02-30'},{date:'2027-02-29'},{departureTime:'24:00'},{departureTime:'12:60'},{bookingVersion:'short'}])assert.throws(()=>recovery.create({...input(),trip:{...structuredClone(trip),...change}}));
  for(const key of ['short','a'.repeat(129),'invalid key with spaces'])assert.throws(()=>recovery.create({...input(),key}));assert.ok(recovery.create({...input(),key:'a'.repeat(128)}));
});
test('[UT-COUNTER-007] invalid passenger route points duplicate unavailable labels and unsafe total cannot be cached',()=>{
  for(const mutate of [value=>value.passenger.phone='invalid1234',value=>value.passenger.email='not-email',value=>value.passenger.fullName='A',value=>value.passenger.pickup='Missing',value=>value.seats=[],value=>value.seats=['A01','A01'],value=>value.seats=['A03'],value=>value.seats=['Missing'],value=>value.trip.seats[0].price=Number.MAX_SAFE_INTEGER,value=>value.trip.seats.push({...value.trip.seats[0]})]){const value=input();mutate(value);assert.throws(()=>recovery.create(value));}
});
test('[UT-COUNTER-008] any edited passenger contact points ordered seats or trip requires restoring original request',()=>{
  const attempt=saved(),choices={tripId:trip.id,seats:['A02','A01'],passenger:{...passenger}};assert.equal(recovery.matches(attempt,choices),true);
  for(const changed of [{tripId:'other'},{seats:['A01','A02']},{passenger:{...passenger,phone:'0909999999'}},{passenger:{...passenger,email:'new@example.test'}},{passenger:{...passenger,fullName:'Khách mới'}},{passenger:{...passenger,pickup:'Văn phòng'}}])assert.equal(recovery.matches(attempt,{...choices,...changed}),false);
});
