'use strict';

const {describe,test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {canonical,signature,configured,paymentUrl,verifiedParams,vietnamTimestamp,acceptsSource}=require('../../server/payments');
const {checkoutIdempotency}=require('../../server/checkout-idempotency');

const ENV=Object.freeze({VNPAY_TMN_CODE:'UNITTEST',VNPAY_HASH_SECRET:'unit-payment-secret',APP_URL:'https://tickets.example'});
const SIGNED_FIELDS=Object.freeze({vnp_Amount:'25000000',vnp_TmnCode:'UNITTEST',vnp_TxnRef:'T4TCASE'});
const KNOWN_HASH='0d8d0c7d907c0fd15bbaa2897e5cc5082516210869feb7a3648b2631959cd56affbcd32e242f57b973f893886719a4c399ae0dc87dbc1f8a58241aa4e5e4961c';
const NOW=Date.parse('2028-02-29T16:59:30.000Z');
const BOOKING=Object.freeze({code:'T4TCASE',source:'managed',paymentMethod:'vnpay',status:'pending_payment',paymentStatus:'pending',total:250000,expiresAt:'2028-02-29T17:14:30.000Z'});
function frozenDate(t,run){const original=Date;t.mock.timers.enable({apis:['Date'],now:NOW});try{return run();}finally{t.mock.timers.reset();assert.equal(Date,original,'Date mock must be restored in this test');}}
function fail(status,message,code){const error=new Error(message);Object.assign(error,{status,code});throw error;}
function request({key='unit-checkout-key-1234',body={phone:'0901234567',tripId:'trip-unit',seats:['A01']},path='/bookings',user,session}={}){return {get:name=>name==='Idempotency-Key'?key:undefined,body,path,user,session};}

describe('[UT-GROUP-VNPAY-SIGNATURE] VNPAY canonical encoding and signed callbacks',()=>{
  test('[UT-VNP-001] Canonical request orders keys and excludes both signature metadata fields',()=>{
    const params={vnp_TxnRef:'T4TCASE',vnp_SecureHash:'ignored',vnp_TmnCode:'UNITTEST',vnp_Amount:'25000000',vnp_SecureHashType:'SHA512'};
    assert.equal(canonical(params),'vnp_Amount=25000000&vnp_TmnCode=UNITTEST&vnp_TxnRef=T4TCASE');assert.equal(canonical({...params,vnp_SecureHash:'changed',vnp_SecureHashType:'changed'}),canonical(params));
  });
  test('[UT-VNP-002] Form encoding distinguishes spaces, plus signs, separators and Vietnamese text',()=>{
    assert.equal(canonical({vnp_OrderInfo:'Vé A+B & C=1 / 50%?'}),'vnp_OrderInfo=V%C3%A9+A%2BB+%26+C%3D1+%2F+50%25%3F');
    assert.notEqual(canonical({vnp_OrderInfo:'A B'}),canonical({vnp_OrderInfo:'A+B'}));
  });
  test('[UT-VNP-003] HMAC SHA512 matches a fixed merchant test vector independent of property order',()=>{
    assert.equal(signature(SIGNED_FIELDS,ENV.VNPAY_HASH_SECRET),KNOWN_HASH);
    assert.equal(signature(Object.fromEntries(Object.entries(SIGNED_FIELDS).reverse()),ENV.VNPAY_HASH_SECRET),KNOWN_HASH);
    assert.notEqual(signature(SIGNED_FIELDS,'different-secret'),KNOWN_HASH);
  });
  test('[UT-VNP-004] Signed callback validation returns a separate copy and accepts hexadecimal case equivalence',()=>{
    const query=Object.freeze({...SIGNED_FIELDS,vnp_SecureHash:KNOWN_HASH}),verified=verifiedParams(query,ENV);assert.deepEqual(verified,query);assert.notEqual(verified,query);
    assert.ok(verifiedParams({...query,vnp_SecureHash:KNOWN_HASH.toUpperCase()},ENV));
    assert.ok(verifiedParams({...query,vnp_SecureHashType:'SHA512'},ENV));
  });
  test('[UT-VNP-005] Changing any signed amount, merchant identity or order reference invalidates the callback',()=>{
    const query={...SIGNED_FIELDS,vnp_SecureHash:KNOWN_HASH};
    for(const [field,value] of [['vnp_Amount','25000001'],['vnp_TmnCode','ANOTHER'],['vnp_TxnRef','T4TOTHER']])assert.equal(verifiedParams({...query,[field]:value},ENV),null);
    assert.equal(verifiedParams(query,{...ENV,VNPAY_HASH_SECRET:'wrong-secret'}),null);
    const otherMerchant={...SIGNED_FIELDS,vnp_TmnCode:'ANOTHER'};assert.equal(verifiedParams({...otherMerchant,vnp_SecureHash:signature(otherMerchant,ENV.VNPAY_HASH_SECRET)},ENV),null);
  });
  test('[UT-VNP-006] Malformed or missing signatures return validation failure without timing comparison errors',()=>{
    for(const hash of [undefined,'','0'.repeat(127),'0'.repeat(129),'g'.repeat(128),' '+KNOWN_HASH,KNOWN_HASH+'\n',0,[],{}])assert.equal(verifiedParams({...SIGNED_FIELDS,vnp_SecureHash:hash},ENV),null);
  });
  test('[UT-VNP-007] Duplicate, non-string and unrelated query parameters are not silently canonicalized',()=>{
    const query={...SIGNED_FIELDS,vnp_SecureHash:KNOWN_HASH};
    for(const value of [['25000000','1'],25000000,null,{},undefined])assert.equal(verifiedParams({...query,vnp_Amount:value},ENV),null);
    assert.equal(verifiedParams({...query,tracking:'outside-signature'},ENV),null);
    assert.equal(verifiedParams({...query,vnp_Extra:['duplicate']},ENV),null);
  });
  test('[UT-VNP-008] Missing configuration disables both signing URLs and callback verification',()=>{
    assert.equal(configured(ENV),true);
    for(const field of ['VNPAY_TMN_CODE','VNPAY_HASH_SECRET','APP_URL']){
      const missing={...ENV,[field]:''};assert.equal(configured(missing),false);assert.equal(verifiedParams({...SIGNED_FIELDS,vnp_SecureHash:KNOWN_HASH},missing),null);assert.equal(paymentUrl(BOOKING,{},missing),null);
    }
  });
});

describe('[UT-GROUP-VNPAY-LINK] Payable states, deadlines and merchant URLs',()=>{
  test('[UT-VNP-009] Gateway timestamps use Vietnam calendar time across midnight and leap day',()=>{
    assert.equal(vietnamTimestamp(new Date('2028-02-29T16:59:59.000Z')),'20280229235959');assert.equal(vietnamTimestamp(new Date('2028-02-29T17:00:00.000Z')),'20280301000000');assert.equal(vietnamTimestamp(new Date('2027-12-31T17:00:00.000Z')),'20280101000000');
  });
  test('[UT-VNP-010] Payment URL signs exact transported bytes and retains the authoritative fare and original expiry',t=>frozenDate(t,()=>{
    const original=structuredClone(BOOKING),value=paymentUrl(BOOKING,{ip:'::ffff:192.0.2.10'},ENV),url=new URL(value),params=url.searchParams;
    assert.equal(url.origin,'https://sandbox.vnpayment.vn');assert.equal(params.get('vnp_Amount'),'25000000');assert.equal(params.get('vnp_TxnRef'),'T4TCASE');assert.equal(params.get('vnp_IpAddr'),'192.0.2.10');assert.equal(params.get('vnp_ReturnUrl'),'https://tickets.example/api/payments/vnpay/return');assert.equal(params.get('vnp_CreateDate'),'20280229235930');assert.equal(params.get('vnp_ExpireDate'),'20280301001430');
    const unsigned=value.slice(value.indexOf('?')+1,value.lastIndexOf('&vnp_SecureHash='));assert.equal(params.get('vnp_SecureHash'),crypto.createHmac('sha512',ENV.VNPAY_HASH_SECRET).update(unsigned).digest('hex'));assert.deepEqual(BOOKING,original);
  }));
  test('[UT-VNP-011] Loopback, missing IP and trailing application slash produce a usable return link',t=>frozenDate(t,()=>{
    for(const ip of [undefined,'::1']){const url=new URL(paymentUrl(BOOKING,{ip},{...ENV,APP_URL:'https://tickets.example/'}));assert.equal(url.searchParams.get('vnp_IpAddr'),'127.0.0.1');assert.equal(url.searchParams.get('vnp_ReturnUrl'),'https://tickets.example/api/payments/vnpay/return');}
  }));
  test('[UT-VNP-012] Payment links exist only for unpaid pending VNPAY reservations',t=>frozenDate(t,()=>{
    assert.ok(paymentUrl(BOOKING,{},ENV));
    for(const state of ['reserved','confirmed','cancelled','expired','refund_pending'])assert.equal(paymentUrl({...BOOKING,status:state},{},ENV),null);
    for(const state of ['paid','refund_pending','refunded'])assert.equal(paymentUrl({...BOOKING,paymentStatus:state},{},ENV),null);
    for(const paymentMethod of ['cash','momo','zalopay'])assert.equal(paymentUrl({...BOOKING,paymentMethod},{},ENV),null);
  }));
  test('[UT-VNP-013] Expiry is exclusive at the exact millisecond and invalid deadlines cannot create a link',t=>frozenDate(t,()=>{
    assert.equal(paymentUrl({...BOOKING,expiresAt:new Date(NOW).toISOString()},{},ENV),null);assert.equal(paymentUrl({...BOOKING,expiresAt:new Date(NOW-1).toISOString()},{},ENV),null);assert.ok(paymentUrl({...BOOKING,expiresAt:new Date(NOW+1).toISOString()},{},ENV));
    for(const expiresAt of [undefined,null,'','not-a-date'])assert.equal(paymentUrl({...BOOKING,expiresAt},{},ENV),null);
  }));
  test('[UT-VNP-014] Demo provenance permits the actual sandbox and rejects live, lookalike or insecure gateways',t=>frozenDate(t,()=>{
    const demo={...BOOKING,source:'demo'};assert.equal(acceptsSource(demo,ENV),true);assert.ok(paymentUrl(demo,{},ENV));
    for(const VNPAY_URL of ['https://pay.vnpay.vn/vpcpay.html','https://sandbox.vnpayment.vn.attacker.example/pay','http://sandbox.vnpayment.vn/paymentv2/vpcpay.html','not-a-url']){assert.equal(acceptsSource(demo,{...ENV,VNPAY_URL}),false);assert.equal(paymentUrl(demo,{},{...ENV,VNPAY_URL}),null);}
    assert.equal(acceptsSource({...BOOKING,isDemo:true},{...ENV,VNPAY_URL:'https://pay.vnpay.vn/vpcpay.html'}),false);
  }));
  test('[UT-VNP-015] Managed bookings retain their configured merchant gateway without exposing the signing secret',t=>frozenDate(t,()=>{
    const value=paymentUrl(BOOKING,{ip:'198.51.100.5'},{...ENV,VNPAY_URL:'https://pay.vnpay.vn/vpcpay.html'});assert.equal(new URL(value).origin,'https://pay.vnpay.vn');assert.ok(!value.includes(ENV.VNPAY_HASH_SECRET));assert.ok(!value.includes('VNPAY_HASH_SECRET'));
  }));
});

describe('[UT-GROUP-IDEMPOTENCY] Checkout capability and request fingerprint contracts',()=>{
  test('[UT-IDEM-001] Legacy requests without a checkout key retain the optional-key contract',()=>{
    assert.equal(checkoutIdempotency({...request(),get:()=>undefined},fail),null);
  });
  test('[UT-IDEM-002] Key length boundaries and supported capability characters are accepted',()=>{
    for(const key of ['a'.repeat(16),'a'.repeat(128),'Checkout.Key_2028:ABC-1234']){const fingerprint=checkoutIdempotency(request({key}),fail);assert.match(fingerprint.keyHash,/^[a-f0-9]{64}$/);assert.match(fingerprint.requestHash,/^[a-f0-9]{64}$/);}
  });
  test('[UT-IDEM-003] Invalid key lengths, duplicate headers and whitespace fail with a stable API error code',()=>{
    for(const key of ['',null,'a'.repeat(15),'a'.repeat(129),'has space in checkout key','checkout/key/with/slash','duplicate-checkout-key, second-key','x'.repeat(16)+'\n','khóa-không-hợp-lệ-123'])assert.throws(()=>checkoutIdempotency(request({key}),fail),error=>error.status===400&&error.code==='INVALID_IDEMPOTENCY_KEY');
  });
  test('[UT-IDEM-004] Equivalent nested JSON property order produces the same replay fingerprint',()=>{
    const first={phone:'0901234567',legs:[{tripId:'trip-one',seats:['A01','A02'],details:{pickup:'A',dropoff:'B'}}],couponCode:null},second={couponCode:null,legs:[{details:{dropoff:'B',pickup:'A'},seats:['A01','A02'],tripId:'trip-one'}],phone:'0901234567'};
    const original=structuredClone(first);assert.deepEqual(checkoutIdempotency(request({body:first}),fail),checkoutIdempotency(request({body:second}),fail));assert.deepEqual(first,original);
  });
  test('[UT-IDEM-005] Changed contacts, primitive types, array order and endpoint cannot replay another request',()=>{
    const original=request(),first=checkoutIdempotency(original,fail);
    for(const body of [{...original.body,phone:'0909999999'},{...original.body,phone:901234567},{...original.body,seats:['A02','A01']},{...original.body,seats:['A01'],extra:null}]){const changed=checkoutIdempotency(request({body}),fail);assert.equal(changed.keyHash,first.keyHash);assert.notEqual(changed.requestHash,first.requestHash);}
    assert.notEqual(checkoutIdempotency(request({path:'/orders'}),fail).requestHash,first.requestHash);
  });
  test('[UT-IDEM-006] Authenticated user scopes isolate the same key from other accounts and guests',()=>{
    const guest=checkoutIdempotency(request(),fail),one=checkoutIdempotency(request({user:{id:'customer-one'}}),fail),two=checkoutIdempotency(request({user:{id:'customer-two'}}),fail);
    assert.equal(new Set([guest.keyHash,one.keyHash,two.keyHash]).size,3);assert.equal(one.requestHash,two.requestHash);assert.equal(one.requestHash,guest.requestHash);
  });
  test('[UT-IDEM-007] Guest capabilities survive missing or regenerated session cookies without revealing personal data',()=>{
    const original=checkoutIdempotency(request({session:{holdOwner:'old-session'}}),fail),recovered=checkoutIdempotency(request({session:{holdOwner:'new-session'}}),fail),noCookie=checkoutIdempotency(request(),fail);
    assert.deepEqual(original,recovered);assert.deepEqual(original,noCookie);
    const serialized=JSON.stringify(original);for(const secret of ['unit-checkout-key-1234','0901234567','trip-unit','old-session'])assert.ok(!serialized.includes(secret));
  });
});
