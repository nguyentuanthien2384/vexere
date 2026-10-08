'use strict';

const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const express=require('express');
const session=require('express-session');
const {createApi}=require('../server/app');
const {todayVietnam,addDays}=require('../server/catalog');
const {signature}=require('../server/payments');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ticket4t-recovery-'));
const suffix=()=>crypto.randomBytes(10).toString('hex');
const env={NODE_ENV:'test',SEED_DEMO:'true',DATA_DIR:directory,ADMIN_EMAIL:'recovery-'+suffix()+'@example.test',ADMIN_PASSWORD:'Recovery@12345',APP_URL:'http://localhost:3000',VNPAY_TMN_CODE:'RECOVERY',VNPAY_HASH_SECRET:'recovery-test-secret',...(process.env.TEST_DATABASE_URL?{DATABASE_URL:process.env.TEST_DATABASE_URL}:{})};
let api,server,base,adminCookie,operatorId;
async function start() {
  api=await createApi({env,dataDir:directory,seedDays:2});
  const app=express();app.use(express.json());app.use(session({secret:'recovery-test-session',store:api.sessionStore,resave:false,saveUninitialized:false}));app.use('/api',api.router);
  server=await new Promise(resolve=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});base='http://127.0.0.1:'+server.address().port;
}
async function stop(){if(server)await new Promise(resolve=>server.close(resolve));if(api)await api.close();server=null;api=null;}
async function req(route,{method='GET',body,cookie,key}={}) {
  const response=await fetch(base+'/api'+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],replayed:response.headers.get('idempotency-replayed')};
}
async function trip(extra={}) {
  const response=await req('/admin/trips',{method:'POST',cookie:adminCookie,body:{operatorId,from:'ho-chi-minh',to:'da-lat',date:addDays(todayVietnam(),4),departureTime:'06:00',durationMinutes:360,price:250000,totalSeats:9,type:'limousine',pickupPoints:['Điểm đón kiểm thử'],dropoffPoints:['Điểm trả kiểm thử'],provenance:'Kho vé kiểm thử phục hồi',...extra}});
  assert.equal(response.status,201,JSON.stringify(response.data));return response.data.trip;
}
function leg(item,seats=['A01']) {return {tripId:item.id,seats,pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0]};}
function customer(extra={}) {return {fullName:'Khách thử phục hồi',email:'recovery@example.test',phone:'0901234567',paymentMethod:'cash',...extra};}
function body(item,extra={}) {return {...customer(),...leg(item),...extra};}
before(async()=>{
  await start();
  const login=await req('/auth/login',{method:'POST',body:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}});assert.equal(login.status,200);adminCookie=login.cookie;
  const op=await req('/admin/operators',{method:'POST',cookie:adminCookie,body:{name:'Nhà xe phục hồi '+suffix(),phone:'0901234567'}});assert.equal(op.status,201);operatorId=op.data.operator.id;
});
after(async()=>{await stop();const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith('ticket4t-recovery-'));fs.rmSync(resolved,{recursive:true,force:true});});

test('concurrent identical checkout requests recover one booking, one coupon use and one email after consuming a hold',async()=>{
  const item=await trip(),key=suffix(),held=await req('/holds',{method:'POST',body:{tripId:item.id,seats:['A01']}});
  const p=await req('/admin/promotions',{method:'POST',cookie:adminCookie,body:{code:'REC'+suffix(),title:'Ưu đãi phục hồi',type:'percentage',value:10,perCustomer:1,maxUses:1}});assert.equal(p.status,201);
  const payload=body(item,{holdToken:held.data.hold.token,couponCode:p.data.promotion.code});
  const responses=await Promise.all(Array.from({length:6},()=>req('/bookings',{method:'POST',body:payload,key})));
  assert.ok(responses.every(r=>r.status===201),JSON.stringify(responses));
  const codes=new Set(responses.map(r=>r.data.booking.code));assert.equal(codes.size,1);
  assert.equal(responses.filter(r=>r.replayed==='true').length,5);
  const code=responses[0].data.booking.code;
  assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM reserved_seats WHERE booking_code=?',[code])).n),1);
  assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM promotion_uses WHERE booking_code=?',[code])).n),1);
  assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM email_outbox WHERE subject=?',['Đặt chỗ Ticket4T '+code])).n),1);
  assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM booking_events WHERE booking_code=? AND event=?',[code,'created'])).n),1);
  assert.equal((await req('/bookings',{method:'POST',body:{...payload,phone:'0909999999'},key})).data.code,'IDEMPOTENCY_CONFLICT');
  assert.equal((await req('/bookings',{method:'POST',body:{...payload,phone:'invalid'},key})).data.code,'IDEMPOTENCY_CONFLICT');
  const record=await api.db.get('SELECT key_hash,result FROM checkout_requests WHERE result LIKE ?',['%'+code+'%']);assert.ok(record);assert.ok(!JSON.stringify(record).includes(key));
});

test('checkout replay is durable across restart and accepts equivalent JSON key ordering',async()=>{
  const item=await trip(),key=suffix(),payload=body(item),first=await req('/bookings',{method:'POST',body:payload,key});assert.equal(first.status,201);
  if(!process.env.TEST_DATABASE_URL){await stop();await start();}
  const reordered=Object.fromEntries(Object.entries(payload).reverse()),replay=await req('/bookings',{method:'POST',body:reordered,key});
  assert.equal(replay.status,201);assert.equal(replay.data.booking.code,first.data.booking.code);assert.equal(replay.data.replayed,true);
});

test('failed checkout does not consume a key; invalid keys and changed endpoint are rejected',async()=>{
  const item=await trip(),key=suffix();
  assert.equal((await req('/bookings',{method:'POST',body:body(item,{seats:['missing']}),key})).status,400);
  assert.equal((await req('/bookings',{method:'POST',body:body(item),key})).status,201);
  assert.equal((await req('/bookings',{method:'POST',body:body(item,{seats:['A02']}),key:'short'})).data.code,'INVALID_IDEMPOTENCY_KEY');
  const returning=await trip({from:'da-lat',to:'ho-chi-minh',date:addDays(todayVietnam(),5)});
  const conflict=await req('/orders',{method:'POST',key,body:{...customer(),legs:[leg(item,['A02']),leg(returning)]}});assert.equal(conflict.data.code,'IDEMPOTENCY_CONFLICT');
});

test('roundtrip retry returns one order and the confirmation email contains both legs',async()=>{
  const outward=await trip(),returning=await trip({from:'da-lat',to:'ho-chi-minh',date:addDays(todayVietnam(),5)}),key=suffix(),payload={...customer(),legs:[leg(outward),leg(returning)]};
  const first=await req('/orders',{method:'POST',body:payload,key}),replay=await req('/orders',{method:'POST',body:payload,key});
  assert.equal(first.status,201);assert.equal(replay.status,201);assert.equal(replay.data.order.code,first.data.order.code);assert.equal(replay.data.replayed,true);
  const emails=await api.db.all('SELECT body FROM email_outbox WHERE subject=?',['Đặt chỗ Ticket4T '+first.data.order.code]);assert.equal(emails.length,1);
  for(const booking of first.data.order.bookings){assert.ok(emails[0].body.includes(booking.code));assert.ok(emails[0].body.includes(booking.trip.fromName+' → '+booking.trip.toName));}
});

test('authenticated idempotency keys are isolated from other accounts and guest capabilities',async()=>{
  const one=await req('/auth/register',{method:'POST',body:{fullName:'Tài khoản một',phone:'0901234567',email:suffix()+'@example.test',password:'Recovery@12345'}});
  const two=await req('/auth/register',{method:'POST',body:{fullName:'Tài khoản hai',phone:'0901234567',email:suffix()+'@example.test',password:'Recovery@12345'}});
  assert.equal(one.status,201);assert.equal(two.status,201);
  const item=await trip(),key=suffix(),a=await req('/bookings',{method:'POST',body:body(item),cookie:one.cookie,key});assert.equal(a.status,201);
  const b=await req('/bookings',{method:'POST',body:body(item,{seats:['A02']}),cookie:two.cookie,key});assert.equal(b.status,201);assert.notEqual(a.data.booking.userId,b.data.booking.userId);
  const guest=await req('/bookings',{method:'POST',body:body(item,{seats:['A03']}),key});assert.equal(guest.status,201);assert.equal(guest.data.booking.userId,null);
});

test('payment-link recovery requires ownership and never extends the reservation or confirms payment',async()=>{
  const item=await trip(),key=suffix(),payload=body(item,{paymentMethod:'vnpay'}),created=await req('/bookings',{method:'POST',body:payload,key}),booking=created.data.booking;assert.equal(created.status,201);
  assert.equal((await req('/bookings/'+booking.code+'/payment-link',{method:'POST',body:{phone:'0909999999'}})).status,404);
  const resumed=await req('/bookings/'+booking.code+'/payment-link',{method:'POST',body:{phone:booking.phone}});assert.equal(resumed.status,200);assert.ok(resumed.data.paymentUrl);
  assert.equal(resumed.data.booking.expiresAt,booking.expiresAt);assert.equal(resumed.data.booking.paymentStatus,'pending');
  const replay=await req('/bookings',{method:'POST',body:payload,key});assert.equal(replay.status,201);assert.ok(replay.data.paymentUrl);
  const parameters={vnp_TmnCode:env.VNPAY_TMN_CODE,vnp_TxnRef:booking.code,vnp_Amount:String(booking.total*100),vnp_ResponseCode:'00',vnp_TransactionStatus:'00',vnp_TransactionNo:suffix()};parameters.vnp_SecureHash=signature(parameters,env.VNPAY_HASH_SECRET);
  assert.equal((await req('/payments/vnpay/ipn?'+new URLSearchParams(parameters))).data.RspCode,'00');
  assert.equal((await req('/bookings/'+booking.code+'/payment-link',{method:'POST',body:{phone:booking.phone}})).data.code,'PAYMENT_NOT_PAYABLE');
  const paidReplay=await req('/bookings',{method:'POST',body:payload,key});assert.equal(paidReplay.data.booking.paymentStatus,'paid');assert.ok(!paidReplay.data.paymentUrl);
});

test('expired checkout replay releases its seats and cannot recreate a payment link',async()=>{
  const item=await trip(),key=suffix(),payload=body(item,{paymentMethod:'vnpay'}),created=await req('/bookings',{method:'POST',body:payload,key}),booking=created.data.booking;
  await api.db.transaction(tx=>tx.run('UPDATE bookings SET expires_at=? WHERE code=?',[new Date(Date.now()-1000).toISOString(),booking.code]));
  const replay=await req('/bookings',{method:'POST',body:payload,key});assert.equal(replay.status,201);assert.equal(replay.data.booking.status,'expired');assert.ok(!replay.data.paymentUrl);
  assert.equal((await req('/bookings/'+booking.code+'/payment-link',{method:'POST',body:{phone:booking.phone}})).data.code,'PAYMENT_NOT_PAYABLE');
  assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM reserved_seats WHERE booking_code=?',[booking.code])).n),0);
});

test('demo bookings cannot create or resume a live payment and disabled gateways remain recoverable',async()=>{
  const row=await api.db.get("SELECT id FROM trips WHERE source='demo' AND departure_at>? ORDER BY departure_at LIMIT 1",[new Date(Date.now()+3600000).toISOString()]),item=(await req('/trips/'+row.id)).data;
  const seat=item.seats.find(s=>s.status==='available').label,payload=body(item,{seats:[seat],paymentMethod:'vnpay'}),key=suffix(),created=await req('/bookings',{method:'POST',body:payload,key});assert.equal(created.status,201);
  env.VNPAY_URL='https://pay.vnpay.vn/vpcpay.html';
  try {
    assert.equal((await req('/bookings/'+created.data.booking.code+'/payment-link',{method:'POST',body:{phone:'0901234567'}})).data.code,'DEMO_PAYMENT_BLOCKED');
    assert.ok(!(await req('/bookings',{method:'POST',body:payload,key})).data.paymentUrl);
    const second=item.seats.find(s=>s.status==='available'&&s.label!==seat).label;
    assert.equal((await req('/bookings',{method:'POST',body:{...payload,seats:[second]}})).data.code,'DEMO_PAYMENT_BLOCKED');
  } finally {delete env.VNPAY_URL;}
  const secret=env.VNPAY_HASH_SECRET;delete env.VNPAY_HASH_SECRET;
  try {
    assert.equal((await req('/bookings/'+created.data.booking.code+'/payment-link',{method:'POST',body:{phone:'0901234567'}})).data.code,'PAYMENT_UNAVAILABLE');
    const recovered=await req('/bookings',{method:'POST',body:payload,key});assert.equal(recovered.status,201);assert.ok(!recovered.data.paymentUrl);
  } finally {env.VNPAY_HASH_SECRET=secret;}
});
