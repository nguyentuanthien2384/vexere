'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {bookingTermsVersion,validateBookingVersion,validateExpectedTotal}=require('../../server/booking-terms');
const {checkoutIdempotency}=require('../../server/checkout-idempotency');

const trip={id:'trip-terms',operatorId:'operator-one',from:'ho-chi-minh',to:'da-lat',date:'2028-02-29',departureTime:'23:30',durationMinutes:360,type:'cabin',totalSeats:5,price:250000,seatPrices:{B02:350000,A01:300000},pickupPoints:['Văn phòng','Bến xe'],dropoffPoints:['Trung tâm','Bến xe Đà Lạt'],source:'managed'};
const invalid=error=>error.status===400;
const request=body=>({get:()=> 'terms-checkout-key-12345',path:'/bookings',body});

test('[UT-TERMS-001] booking versions are stable lowercase SHA256 values independent of object and seat fare property order',()=>{
  const original=structuredClone(trip),version=bookingTermsVersion(trip);
  assert.match(version,/^[a-f0-9]{64}$/);assert.equal(version.length,64);
  const reordered={...Object.fromEntries(Object.entries(trip).reverse()),seatPrices:{A01:300000,B02:350000}};
  assert.equal(bookingTermsVersion(reordered),version);assert.deepEqual(trip,original);
});

test('[UT-TERMS-002] every booking relevant schedule route capacity price point and source change invalidates prior consent',()=>{
  const changes={id:'trip-other',operatorId:'operator-other',from:'ha-noi',to:'nha-trang',date:'2028-03-01',departureTime:'23:31',durationMinutes:361,type:'sleeper',totalSeats:6,price:250001,seatPrices:{...trip.seatPrices,A01:300001},pickupPoints:['Bến xe','Văn phòng'],dropoffPoints:['Địa chỉ mới'],source:'demo'};
  const original=bookingTermsVersion(trip);
  for(const [field,value] of Object.entries(changes))assert.notEqual(bookingTermsVersion({...trip,[field]:value}),original,field);
});

test('[UT-TERMS-003] volatile seat counts ratings and cutoff decorations never invalidate unchanged booking terms',()=>{
  const decorated={...trip,availableSeats:0,heldSeats:3,bookedSeats:2,occupiedSeats:5,rating:1,reviewCount:999,bookingCutoffAt:'2028-02-29T15:00:00Z',bookingOpen:false,displayPrice:null,minAvailablePrice:null,maxAvailablePrice:null,matchingSeats:0,seats:[{label:'A01',status:'held'}],image:'/new-image.jpg',amenities:['Wifi'],bookingVersion:'untrusted old decoration'};
  assert.equal(bookingTermsVersion(decorated),bookingTermsVersion(trip));
});

test('[UT-TERMS-004] absent seat overrides and empty overrides are equivalent while point text remains literal',()=>{
  const {seatPrices,...base}=trip;
  assert.equal(bookingTermsVersion(base),bookingTermsVersion({...base,seatPrices:{}}));
  assert.equal(bookingTermsVersion({...base,seatPrices:null}),bookingTermsVersion({...base,seatPrices:{}}));
  assert.notEqual(bookingTermsVersion({...trip,pickupPoints:['Van phong','Bến xe']}),bookingTermsVersion(trip));
  assert.notEqual(bookingTermsVersion({...trip,pickupPoints:trip.pickupPoints.map(value=>value.normalize('NFD'))}),bookingTermsVersion(trip));
});

test('[UT-TERMS-005] optional expected version accepts only exactly sixty four lowercase hexadecimal characters',()=>{
  assert.equal(validateBookingVersion(undefined),undefined);
  const value='a1'.repeat(32);assert.equal(validateBookingVersion(value),value);
  for(const input of ['',null,0,{},[],value.toUpperCase(),'a'.repeat(63),'a'.repeat(65),'g'.repeat(64),value+'\n',' '+value])assert.throws(()=>validateBookingVersion(input),invalid);
});

test('[UT-TERMS-006] expected total is optional and permits zero through the largest safe integer without coercion',()=>{
  assert.equal(validateExpectedTotal(undefined),undefined);
  for(const value of [0,1,250000,Number.MAX_SAFE_INTEGER])assert.equal(validateExpectedTotal(value),value);
  for(const value of [null,'250000',true,[],{},-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateExpectedTotal(value),invalid);
});

test('[UT-TERMS-007] consent validators use the supplied API error path for invalid values',()=>{
  const fail=(status,message)=>{const error=new Error(message);error.status=status;error.code='VALIDATION_ERROR';throw error;};
  for(const action of [()=>validateBookingVersion('invalid',fail),()=>validateExpectedTotal(-1,fail)])assert.throws(action,error=>error.status===400&&error.code==='VALIDATION_ERROR');
  assert.equal(validateBookingVersion('0'.repeat(64),fail),'0'.repeat(64));assert.equal(validateExpectedTotal(250000,fail),250000);
});

test('[UT-TERMS-008] legacy checkout fingerprint remains byte compatible when expected total is omitted',()=>{
  const body={tripId:'trip-legacy',seats:['A01'],phone:'0901234567'},fingerprint=checkoutIdempotency(request(body));
  assert.equal(fingerprint.requestHash,'3b22a2142f5f95bae9d8544ed58de6adb6510fbef6ff6888e1f27eb974fe83a8');
  assert.equal(Object.hasOwn(body,'expectedTotal'),false);
});

test('[UT-TERMS-009] supplied total and booking version participate in durable replay fingerprints without changing the key scope',()=>{
  const body={tripId:'trip-legacy',seats:['A01'],phone:'0901234567'},base=checkoutIdempotency(request(body));
  for(const changed of [{...body,expectedTotal:250000},{...body,expectedTotal:0},{...body,expectedBookingVersion:'a'.repeat(64)}]){
    const fingerprint=checkoutIdempotency(request(changed));assert.equal(fingerprint.keyHash,base.keyHash);assert.notEqual(fingerprint.requestHash,base.requestHash);
  }
  assert.notEqual(checkoutIdempotency(request({...body,expectedTotal:250000})).requestHash,checkoutIdempotency(request({...body,expectedTotal:250001})).requestHash);
});

test('[UT-TERMS-010] equivalent consent payload property order preserves the exact retry identity',()=>{
  const one={tripId:'trip-consent',seats:['A01'],expectedBookingVersion:'a'.repeat(64),expectedTotal:300000},two={expectedTotal:300000,expectedBookingVersion:'a'.repeat(64),seats:['A01'],tripId:'trip-consent'};
  assert.deepEqual(checkoutIdempotency(request(one)),checkoutIdempotency(request(two)));
});
