'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {rescheduleVersion,validateSourceVersion}=require('../../server/reschedule-state');
const {checkoutIdempotency}=require('../../server/checkout-idempotency');

const trip={id:'trip-a',operatorId:'op-a',from:'ho-chi-minh',to:'da-lat',date:'2028-02-29',departureTime:'18:00',durationMinutes:360,type:'limousine',totalSeats:9,price:250000,pickupPoints:['Văn phòng'],dropoffPoints:['Bến xe'],source:'managed',seatPrices:{A02:300000,A01:250000}};
const booking={code:'T4TTEST',tripId:trip.id,userId:'user-a',fullName:'Hành khách',phone:'0901234567',email:'customer@example.test',status:'reserved',paymentStatus:'pending',paymentMethod:'cash',total:225000,subtotal:250000,discount:25000,seats:['A01'],pickup:'Văn phòng',dropoff:'Bến xe',createdAt:'2028-01-01T00:00:00Z',expiresAt:null,orderCode:null,couponCode:'PROMO',source:'managed',trip};
const request=(body,path='/bookings/T4TTEST/reschedule')=>({get:()=> 'reschedule-state-key-12345',path,body});

test('[UT-RESCHED-001] source version is a deterministic lowercase SHA256 value independent of object insertion order',()=>{
  const original=structuredClone(booking),version=rescheduleVersion(booking);
  assert.match(version,/^[a-f0-9]{64}$/);
  const reordered={...Object.fromEntries(Object.entries(booking).reverse()),trip:{...trip,seatPrices:{A01:250000,A02:300000}}};
  assert.equal(rescheduleVersion(reordered),version);assert.deepEqual(booking,original);
});

test('[UT-RESCHED-002] ownership contact state payment and financial changes invalidate the source version',()=>{
  const changes={code:'T4TOTHER',tripId:'trip-b',userId:'user-b',fullName:'Hành khách mới',phone:'0907654321',email:'other@example.test',status:'confirmed',paymentStatus:'paid',paymentMethod:'momo',total:225001,subtotal:250001,discount:24999,seats:['A02'],pickup:'Điểm khác',dropoff:'Điểm khác',createdAt:'2028-01-02T00:00:00Z',expiresAt:'2028-01-02T00:00:00Z',orderCode:'ORDER1',couponCode:'OTHER',source:'demo'};
  for(const [field,value] of Object.entries(changes))assert.notEqual(rescheduleVersion({...booking,[field]:value}),rescheduleVersion(booking),field);
});

test('[UT-RESCHED-003] immutable booked trip terms are bound while live inventory counts and derived stamps are ignored',()=>{
  assert.notEqual(rescheduleVersion({...booking,trip:{...trip,departureTime:'19:00'}}),rescheduleVersion(booking));
  const decorated={...booking,rescheduleVersion:'untrusted',trip:{...trip,availableSeats:0,heldSeats:8,bookedSeats:1,bookingOpen:false,bookingVersion:'untrusted',operatorName:'Tên mới',rating:1}};
  assert.equal(rescheduleVersion(decorated),rescheduleVersion(booking));
});

test('[UT-RESCHED-004] successful move count prevents an A to B to A return from accepting the original consent',()=>{
  const returned={...booking,previousTrips:[{tripId:'trip-a'},{tripId:'trip-b'}]};
  assert.notEqual(rescheduleVersion(returned),rescheduleVersion(booking));
  assert.equal(rescheduleVersion({...returned,previousTrips:[{tripId:'other',changedAt:'different'},{tripId:'other'}]}),rescheduleVersion(returned));
});

test('[UT-RESCHED-005] legacy absent fields normalize to null and financial defaults without mutating the snapshot',()=>{
  const minimal={code:'LEGACY',total:250000},copy=structuredClone(minimal);
  assert.equal(rescheduleVersion(minimal),rescheduleVersion({...minimal,userId:null,expiresAt:null,seats:[],trip:{},subtotal:250000,discount:0,previousTrips:[]}));
  assert.deepEqual(minimal,copy);
});

test('[UT-RESCHED-006] optional source version accepts exactly sixty four lowercase hexadecimal characters',()=>{
  assert.equal(validateSourceVersion(undefined),undefined);assert.equal(validateSourceVersion('a1'.repeat(32)),'a1'.repeat(32));
  for(const value of ['',null,0,true,{},[],'A'.repeat(64),'a'.repeat(63),'a'.repeat(65),'g'.repeat(64),'a'.repeat(64)+'\n',' '+'a'.repeat(64)])assert.throws(()=>validateSourceVersion(value),error=>error.status===400);
});

test('[UT-RESCHED-007] invalid source versions use the API validation error callback',()=>{
  assert.throws(()=>validateSourceVersion('bad',(status,message)=>{const error=new Error(message);error.status=status;error.code='VALIDATION_ERROR';throw error;}),error=>error.status===400&&error.code==='VALIDATION_ERROR');
});

test('[UT-RESCHED-008] reschedule canonical identity binds booking code endpoint and optional source version',()=>{
  const body={tripId:'trip-b',seats:['A01'],phone:'0901234567'},base=checkoutIdempotency(request(body));
  for(const changed of [request(body,'/bookings/OTHER/reschedule'),request(body,'/admin/bookings/T4TTEST/reschedule'),request({...body,expectedSourceVersion:'a'.repeat(64)})]){
    const value=checkoutIdempotency(changed);assert.equal(value.keyHash,base.keyHash);assert.notEqual(value.requestHash,base.requestHash);
  }
});

test('[UT-RESCHED-009] equivalent reschedule JSON property order retains exact retry identity',()=>{
  const one={tripId:'trip-b',seats:['A02'],phone:'0901234567',expectedSourceVersion:'a'.repeat(64)},two={expectedSourceVersion:'a'.repeat(64),phone:'0901234567',seats:['A02'],tripId:'trip-b'};
  assert.deepEqual(checkoutIdempotency(request(one)),checkoutIdempotency(request(two)));
});

test('[UT-RESCHED-010] ordered seat choices and target terms remain significant to the durable request identity',()=>{
  const body={tripId:'trip-b',seats:['A01','A02']},base=checkoutIdempotency(request(body));
  for(const changed of [{...body,seats:['A02','A01']},{...body,expectedBookingVersion:'b'.repeat(64)},{...body,holdToken:'c'.repeat(64)}])assert.notEqual(checkoutIdempotency(request(changed)).requestHash,base.requestHash);
});
