"use strict";

const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const {createApi} = require('../server/app');
const {todayVietnam,addDays} = require('../server/catalog');
const {signature,canonical,vietnamTimestamp} = require('../server/payments');

let api,server,base,adminCookie,operatorId;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ticket4t-backend-'));
const env={NODE_ENV:'test',SEED_DEMO:'true',DATA_DIR:directory,APP_URL:'http://localhost:3000',
  VNPAY_TMN_CODE:'TEST1234',VNPAY_HASH_SECRET:'test-only-vnpay-secret-32-characters',
  ...(process.env.TEST_DATABASE_URL ? {DATABASE_URL:process.env.TEST_DATABASE_URL} : {})};
async function request(route,{method='GET',body,cookie}={}) {
  const response=await fetch(base+'/api'+route,{method,headers:{...(body ? {'Content-Type':'application/json'} : {}),...(cookie ? {Cookie:cookie} : {})},body:body ? JSON.stringify(body) : undefined,redirect:'manual'});
  const text=await response.text(); let data; try {data=JSON.parse(text);} catch {data={text};}
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],location:response.headers.get('location')};
}
async function createTrip(extra={}) {
  const result=await request('/admin/trips',{method:'POST',cookie:adminCookie,body:{operatorId,from:'ho-chi-minh',to:'da-lat',date:addDays(todayVietnam(),2),departureTime:'18:00',durationMinutes:360,price:250000,totalSeats:9,type:'limousine',
    pickupPoints:['Bến xe thử nghiệm'],dropoffPoints:['Điểm trả thử nghiệm'],amenities:['Điều hòa'],policies:['Hủy trước 2 giờ'],provenance:'Kho vé kiểm thử do nhà xe thử nghiệm cung cấp',...extra}});
  assert.equal(result.status,201,JSON.stringify(result.data)); return result.data.trip;
}
function bookingBody(trip,seats=['A01'],extra={}) {return {tripId:trip.id,seats,fullName:'Hành khách kiểm thử',email:'test@example.test',phone:'0901234567',pickup:trip.pickupPoints[0],dropoff:trip.dropoffPoints[0],paymentMethod:'cash',...extra};}
function callbackParams(booking,extra={}) {
  const params={vnp_TmnCode:env.VNPAY_TMN_CODE,vnp_TxnRef:booking.code,vnp_Amount:String(booking.total*100),vnp_ResponseCode:'00',vnp_TransactionStatus:'00',vnp_TransactionNo:String(Date.now())+Math.floor(Math.random()*10000),vnp_PayDate:vietnamTimestamp(new Date()),...extra};
  return {...params,vnp_SecureHash:signature(params,env.VNPAY_HASH_SECRET)};
}
function callbackQuery(params) {return new URLSearchParams(params).toString();}
before(async () => {
  api=await createApi({env,dataDir:directory,seedDemo:true,seedDays:2});
  const app=express(); app.use(express.json()); app.use(session({name:'ticket4t.sid',secret:'test-only-secret-not-for-production',store:api.sessionStore,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax'}})); app.use('/api',api.router);
  server=await new Promise(resolve => {const listening=app.listen(0,'127.0.0.1',() => resolve(listening));});
  base='http://127.0.0.1:'+server.address().port;
  const login=await request('/auth/login',{method:'POST',body:{email:'admin@ticket4t.vn',password:'Admin@12345'}}); assert.equal(login.status,200); adminCookie=login.cookie;
  const op=await request('/admin/operators',{method:'POST',cookie:adminCookie,body:{name:'Nhà xe kiểm thử '+Date.now(),phone:'0901234567',email:'operator@example.test',description:'Dữ liệu kiểm thử; không phải nhà xe thật'}}); assert.equal(op.status,201); operatorId=op.data.operator.id;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (api) await api.close();
  const resolved=path.resolve(directory);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep),'Temporary cleanup stays in OS temp');
  assert.ok(path.basename(resolved).startsWith('ticket4t-backend-'),'Temporary cleanup matches this test workspace');
  fs.rmSync(resolved,{recursive:true,force:true});
});

test('catalog has explicit sample provenance, 22+ operators, 60 directions and search filters',async () => {
  const {status,data}=await request('/bootstrap'); assert.equal(status,200); assert.equal(data.dataMode,'demo'); assert.ok(data.operators.length>=22); assert.equal(data.stats.routes,60); assert.ok(data.stats.trips>=240); assert.match(data.provenance,/mẫu/);
  const date=addDays(todayVietnam(),1),search=await request('/trips?from=ho-chi-minh&to=da-lat&date='+date+'&sort=price&limit=2');
  assert.equal(search.status,200); assert.equal(search.data.total,4); assert.equal(search.data.trips.length,2); assert.equal(search.data.pages,2);
  assert.ok(search.data.trips[0].price<=search.data.trips[1].price);
  const filtered=await request('/trips?from=ho-chi-minh&to=da-lat&date='+date+'&type=cabin'); assert.equal(filtered.data.total,1); assert.equal(filtered.data.trips[0].type,'cabin');
  const bad=await request('/trips?date=2026-02-30'); assert.equal(bad.status,400);
});

test('unauthenticated admin access and customer admin mutations are denied',async () => {
  assert.equal((await request('/admin/stats')).status,403);
  assert.equal((await request('/bookings')).status,401);
  const user=await request('/auth/login',{method:'POST',body:{email:'khach@ticket4t.vn',password:'Khach@12345'}}); assert.equal(user.status,200);
  const attempt=await request('/admin/operators',{method:'POST',cookie:user.cookie,body:{name:'Unauthorized'}}); assert.equal(attempt.status,403);
});

test('simultaneous reservations never sell a seat twice',async () => {
  const trip=await createTrip();
  const results=await Promise.all(Array.from({length:8},() => request('/bookings',{method:'POST',body:bookingBody(trip)})));
  assert.equal(results.filter(r => r.status === 201).length,1); assert.equal(results.filter(r => r.status === 409).length,7);
  const winner=results.find(r => r.status === 201).data.booking;
  assert.equal(winner.paymentStatus,'pending'); assert.equal(winner.status,'reserved');
  assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM reserved_seats WHERE trip_id=?',[trip.id])).n),1);
  const seats=(await request('/trips/'+trip.id)).data; assert.equal(seats.availableSeats,8); assert.equal(seats.seats.find(s => s.label === 'A01').status,'booked');
});

test('lookup requires matching phone; guest cancellation releases only own seats',async () => {
  const trip=await createTrip(),created=await request('/bookings',{method:'POST',body:bookingBody(trip,['A02','A03'])}),code=created.data.booking.code;
  assert.equal((await request('/bookings/lookup?code='+code+'&phone=0909999999')).status,404);
  assert.equal((await request('/bookings/lookup?code='+code)).status,404);
  assert.equal((await request('/bookings/lookup?code='+code+'&phone=0901234567')).status,200);
  assert.equal((await request('/bookings/'+code+'/cancel',{method:'POST',body:{phone:'0909999999'}})).status,404);
  const cancelled=await request('/bookings/'+code+'/cancel',{method:'POST',body:{phone:'0901234567'}}); assert.equal(cancelled.data.booking.status,'cancelled');
  assert.equal((await request('/trips/'+trip.id)).data.availableSeats,9);
  const another=await request('/bookings',{method:'POST',body:bookingBody(trip,['A02'])}); assert.equal(another.status,201);
});

test('price is authoritative server-side and honors a validated seat price',async () => {
  const trip=await createTrip({seatPrices:{A01:300000}});
  const seats=(await request('/trips/'+trip.id)).data.seats; assert.equal(seats.find(s => s.label === 'A01').price,300000);
  const created=await request('/bookings',{method:'POST',body:bookingBody(trip,['A01','A02'],{total:1,price:1})}); assert.equal(created.data.booking.total,550000);
  assert.equal((await request('/bookings',{method:'POST',body:bookingBody(trip,['A03','A03'])})).status,400);
  assert.equal((await request('/bookings',{method:'POST',body:bookingBody(trip,['ZZ99'])})).status,400);
});

test('expired online holds release seats and allow the next reservation',async () => {
  const trip=await createTrip(),held=await request('/bookings',{method:'POST',body:bookingBody(trip,['A01'],{paymentMethod:'vnpay'})}); assert.equal(held.status,201); assert.ok(held.data.paymentUrl);
  assert.equal((await request('/trips/'+trip.id)).data.seats[0].status,'held');
  await api.db.transaction(tx => tx.run('UPDATE bookings SET expires_at=? WHERE code=?',[new Date(Date.now()-1000).toISOString(),held.data.booking.code]));
  const next=await request('/bookings',{method:'POST',body:bookingBody(trip,['A01'])}); assert.equal(next.status,201);
  assert.equal((await request('/bookings/lookup?code='+held.data.booking.code+'&phone=0901234567')).data.booking.status,'expired');
});

test('VNPay validates signature and amount, return cannot mark paid, IPN is idempotent',async () => {
  const trip=await createTrip(),held=await request('/bookings',{method:'POST',body:bookingBody(trip,['A01'],{paymentMethod:'vnpay'})}),booking=held.data.booking;
  const bad=callbackParams(booking,{vnp_Amount:String(booking.total*100+100)});
  assert.equal((await request('/payments/vnpay/ipn?'+callbackQuery(bad))).data.RspCode,'04');
  const forged={...callbackParams(booking),vnp_SecureHash:'0'.repeat(128)}; assert.equal((await request('/payments/vnpay/ipn?'+callbackQuery(forged))).data.RspCode,'97');
  const valid=callbackParams(booking);
  const returned=await request('/payments/vnpay/return?'+callbackQuery(valid)); assert.equal(returned.status,302);
  let lookup=await request('/bookings/lookup?code='+booking.code+'&phone=0901234567'); assert.equal(lookup.data.booking.paymentStatus,'pending');
  assert.equal((await request('/payments/vnpay/ipn?'+callbackQuery(valid))).data.RspCode,'00');
  assert.equal((await request('/payments/vnpay/ipn?'+callbackQuery(valid))).data.RspCode,'02');
  lookup=await request('/bookings/lookup?code='+booking.code+'&phone=0901234567'); assert.equal(lookup.data.booking.paymentStatus,'paid'); assert.equal(lookup.data.booking.status,'confirmed');
  const cancellation=await request('/bookings/'+booking.code+'/cancel',{method:'POST',body:{phone:'0901234567'}}); assert.equal(cancellation.data.booking.status,'refund_pending'); assert.equal(cancellation.data.booking.paymentStatus,'refund_pending');
});

test('late paid IPN after seat reallocation queues refund without displacing the next customer',async () => {
  const trip=await createTrip(),held=await request('/bookings',{method:'POST',body:bookingBody(trip,['A01'],{paymentMethod:'vnpay'})}),booking=held.data.booking;
  await api.db.transaction(tx => tx.run('UPDATE bookings SET expires_at=? WHERE code=?',[new Date(Date.now()-1000).toISOString(),booking.code]));
  const next=await request('/bookings',{method:'POST',body:bookingBody(trip,['A01'])}); assert.equal(next.status,201);
  assert.equal((await request('/payments/vnpay/ipn?'+callbackQuery(callbackParams(booking)))).data.RspCode,'00');
  const late=await request('/bookings/lookup?code='+booking.code+'&phone=0901234567'); assert.equal(late.data.booking.status,'refund_pending');
  const owner=await api.db.get('SELECT booking_code FROM reserved_seats WHERE trip_id=? AND seat=?',[trip.id,'A01']); assert.equal(owner.booking_code,next.data.booking.code);
});

test('cash receipts have unique real references and booking history survives close of sales',async () => {
  const trip=await createTrip(),created=await request('/bookings',{method:'POST',body:bookingBody(trip)}),code=created.data.booking.code;
  assert.equal((await request('/admin/bookings/'+code,{method:'PATCH',cookie:adminCookie,body:{status:'paid'}})).status,400);
  const receipt=await request('/admin/bookings/'+code+'/cash-receipt',{method:'POST',cookie:adminCookie,body:{reference:'TEST-RECEIPT-'+Date.now()}}); assert.equal(receipt.status,200); assert.equal(receipt.data.booking.paymentStatus,'paid');
  assert.equal((await request('/admin/trips/'+trip.id,{method:'PATCH',cookie:adminCookie,body:{price:280000}})).status,409);
  assert.equal((await request('/admin/trips/'+trip.id,{method:'DELETE',cookie:adminCookie})).status,200);
  assert.equal((await request('/trips/'+trip.id)).status,404);
  assert.equal((await request('/bookings/lookup?code='+code+'&phone=0901234567')).status,200);
  const events=await request('/admin/bookings/'+code+'/events',{cookie:adminCookie}); assert.ok(events.data.events.some(e => e.event === 'cash_received'));
});

test('cancellation closes two hours before departure',async () => {
  const local=new Date(Date.now()+90*60000+7*3600000).toISOString();
  const trip=await createTrip({date:local.slice(0,10),departureTime:local.slice(11,16)}),created=await request('/bookings',{method:'POST',body:bookingBody(trip)});
  assert.equal(created.status,201);
  assert.equal((await request('/bookings/'+created.data.booking.code+'/cancel',{method:'POST',body:{phone:'0901234567'}})).status,409);
});

test('operator users are scoped; disabling or changing user revokes sessions',async () => {
  const email='staff-'+cryptoSuffix()+'@example.test';
  const created=await request('/admin/users',{method:'POST',cookie:adminCookie,body:{fullName:'Nhân viên kiểm thử',email,phone:'0901234567',password:'Staff@12345',role:'operator',operatorId}}); assert.equal(created.status,201);
  const login=await request('/auth/login',{method:'POST',body:{email,password:'Staff@12345'}}); assert.equal(login.status,200);
  const scoped=await request('/admin/operators',{cookie:login.cookie}); assert.equal(scoped.data.operators.length,1); assert.equal(scoped.data.operators[0].id,operatorId);
  const other=(await request('/bootstrap')).data.operators.find(op => op.id !== operatorId);
  assert.equal((await request('/admin/operators/'+other.id,{method:'PATCH',cookie:login.cookie,body:{name:'Forbidden'}})).status,403);
  assert.equal((await request('/admin/users',{cookie:login.cookie})).status,403);
  const disabled=await request('/admin/users/'+created.data.user.id,{method:'PATCH',cookie:adminCookie,body:{active:false}}); assert.equal(disabled.status,200);
  assert.equal((await request('/auth/me',{cookie:login.cookie})).data.user,null);
  assert.equal((await request('/auth/login',{method:'POST',body:{email,password:'Staff@12345'}})).status,401);
});

test('import validates all rows before writing and preserves operator provenance',async () => {
  const row={operatorId,from:'ha-noi',to:'sa-pa',date:addDays(todayVietnam(),3),departureTime:'20:00',durationMinutes:360,price:300000,type:'cabin',totalSeats:22};
  const before=Number((await api.db.get('SELECT COUNT(*) AS n FROM trips')).n);
  const failed=await request('/admin/import',{method:'POST',cookie:adminCookie,body:{source:'operator',sourceReference:'Hợp đồng kiểm thử nguồn lịch A01',trips:[row,{...row,price:-1}]}}); assert.equal(failed.status,400); assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM trips')).n),before);
  const imported=await request('/admin/import',{method:'POST',cookie:adminCookie,body:{source:'operator',sourceReference:'Hợp đồng kiểm thử nguồn lịch A01',trips:[row]}}); assert.equal(imported.status,201); assert.equal(imported.data.imported,1);
  const trip=(await request('/trips/'+imported.data.trips[0].id)).data; assert.equal(trip.source,'managed'); assert.equal(trip.provenance,'Hợp đồng kiểm thử nguồn lịch A01');
});

test('verification/recovery tokens are hashed, expiring, single-use and revoke old sessions',async () => {
  const email='customer-'+cryptoSuffix()+'@example.test';
  const registered=await request('/auth/register',{method:'POST',body:{fullName:'Khách kiểm thử',email,phone:'0901234567',password:'Initial@12345'}}); assert.equal(registered.status,201); assert.equal(registered.data.user.verified,false);
  const verifyMail=await api.db.get('SELECT body FROM email_outbox WHERE recipient=? ORDER BY created_at DESC',[email]); const token=verifyMail.body.match(/token=([a-f0-9]{64})/)[1];
  assert.ok(!JSON.stringify(registered.data).includes(token)); assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM auth_tokens WHERE hash=?',[token])).n),0);
  assert.equal((await request('/auth/verify',{method:'POST',body:{token}})).status,200); assert.equal((await request('/auth/verify',{method:'POST',body:{token}})).status,400);
  const login=await request('/auth/login',{method:'POST',body:{email,password:'Initial@12345'}}); assert.equal(login.data.user.verified,true);
  await request('/auth/forgot-password',{method:'POST',body:{email}});
  const resetMail=await api.db.get("SELECT body FROM email_outbox WHERE recipient=? AND subject=? ORDER BY created_at DESC",[email,'Đặt lại mật khẩu Ticket4T']); const resetToken=resetMail.body.match(/token=([a-f0-9]{64})/)[1];
  assert.equal((await request('/auth/reset-password',{method:'POST',body:{token:resetToken,password:'Changed@12345'}})).status,200);
  assert.equal((await request('/auth/me',{cookie:login.cookie})).data.user,null);
  assert.equal((await request('/auth/login',{method:'POST',body:{email,password:'Initial@12345'}})).status,401);
  assert.equal((await request('/auth/login',{method:'POST',body:{email,password:'Changed@12345'}})).status,200);
  assert.equal((await request('/auth/reset-password',{method:'POST',body:{token:resetToken,password:'Another@12345'}})).status,400);
});

test('payment canonicalization is deterministic and follows VNPay encoding',() => {
  assert.equal(canonical({vnp_OrderInfo:'Thanh toán vé',vnp_Amount:'25000000',vnp_SecureHash:'ignored'}),'vnp_Amount=25000000&vnp_OrderInfo=Thanh+to%C3%A1n+v%C3%A9');
  assert.equal(vietnamTimestamp(new Date('2026-10-07T00:01:02Z')),'20261007070102');
});
test('booking keeps immutable fare and itinerary after cancelled inventory is edited',async () => {
  const trip=await createTrip(),created=await request('/bookings',{method:'POST',body:bookingBody(trip)}),code=created.data.booking.code;
  await request('/bookings/'+code+'/cancel',{method:'POST',body:{phone:'0901234567'}});
  const edited=await request('/admin/trips/'+trip.id,{method:'PATCH',cookie:adminCookie,body:{price:350000,departureTime:'20:00'}}); assert.equal(edited.status,200);
  const history=await request('/bookings/lookup?code='+code+'&phone=0901234567');
  assert.equal(history.data.booking.total,250000); assert.equal(history.data.booking.trip.price,250000); assert.equal(history.data.booking.trip.departureTime,'18:00');
});
test('actual full refund receipt closes refund queue and duplicate receipt cannot be reused',async () => {
  const trip=await createTrip(),created=await request('/bookings',{method:'POST',body:bookingBody(trip)}),code=created.data.booking.code;
  await request('/admin/bookings/'+code+'/cash-receipt',{method:'POST',cookie:adminCookie,body:{reference:'TEST-CASH-'+cryptoSuffix()}});
  await request('/bookings/'+code+'/cancel',{method:'POST',body:{phone:'0901234567'}});
  const reference='TEST-REFUND-'+cryptoSuffix();
  assert.equal((await request('/admin/bookings/'+code+'/refund-receipt',{method:'POST',cookie:adminCookie,body:{reference,amount:1}})).status,409);
  const refunded=await request('/admin/bookings/'+code+'/refund-receipt',{method:'POST',cookie:adminCookie,body:{reference,amount:250000}});
  assert.equal(refunded.status,200); assert.equal(refunded.data.booking.paymentStatus,'refunded'); assert.equal(refunded.data.booking.status,'cancelled');
  assert.equal((await request('/admin/bookings/'+code+'/refund-receipt',{method:'POST',cookie:adminCookie,body:{reference,amount:250000}})).status,409);
});
test('CSV import handles quoted fields, enforces operator provenance and bounds',async () => {
  const date=addDays(todayVietnam(),3),csv='operatorId,from,to,date,departureTime,durationMinutes,price,type,pickupPoints,dropoffPoints\r\n'+operatorId+',ho-chi-minh,da-lat,'+date+',20:00,360,250000,limousine,"Văn phòng, tầng 1|Bến xe",Bến xe Đà Lạt';
  const imported=await request('/admin/import',{method:'POST',cookie:adminCookie,body:{source:'operator',sourceReference:'Kho vé CSV kiểm thử được xác nhận',csv}}); assert.equal(imported.status,201);
  const trip=(await request('/trips/'+imported.data.trips[0].id)).data; assert.deepEqual(trip.pickupPoints,['Văn phòng, tầng 1','Bến xe']);
  assert.equal((await request('/admin/import',{method:'POST',cookie:adminCookie,body:{source:'operator',sourceReference:'Nguồn CSV',csv:'bad_header\nvalue'}})).status,400);
  const sourceDemo=(await request('/bootstrap')).data.operators.find(op => op.source === 'demo');
  assert.equal((await request('/admin/trips',{method:'POST',cookie:adminCookie,body:{...trip,id:undefined,operatorId:sourceDemo.id}})).status,400);
});
test('reviews require an owned, paid, completed real trip and count only verified bookings',async () => {
  const login=await request('/auth/login',{method:'POST',body:{email:'khach@ticket4t.vn',password:'Khach@12345'}}),trip=await createTrip();
  const created=await request('/bookings',{method:'POST',cookie:login.cookie,body:bookingBody(trip)}),code=created.data.booking.code;
  const review={bookingCode:code,rating:5,title:'Kiểm thử đánh giá',comment:'Nhận xét kiểm thử từ chuyến đi đã hoàn tất.'};
  assert.equal((await request('/reviews',{method:'POST',body:review})).status,401);
  assert.equal((await request('/reviews',{method:'POST',cookie:adminCookie,body:review})).status,404);
  assert.equal((await request('/reviews',{method:'POST',cookie:login.cookie,body:review})).status,409);
  await request('/admin/bookings/'+code+'/cash-receipt',{method:'POST',cookie:adminCookie,body:{reference:'REVIEW-RECEIPT-'+cryptoSuffix()}});
  assert.equal((await request('/reviews',{method:'POST',cookie:login.cookie,body:review})).status,409);
  // Move the immutable test contract into the past to simulate a completed journey.
  await api.db.transaction(async tx => {
    const row=await tx.get('SELECT data FROM bookings WHERE code=?',[code]),snapshot=JSON.parse(row.data);
    snapshot.trip.date=addDays(todayVietnam(),-1); snapshot.trip.departureTime='06:00'; snapshot.trip.durationMinutes=60;
    await tx.run('UPDATE bookings SET data=? WHERE code=?',[JSON.stringify(snapshot),code]);
  });
  assert.equal((await request('/reviews',{method:'POST',cookie:login.cookie,body:review})).status,201);
  assert.equal((await request('/reviews',{method:'POST',cookie:login.cookie,body:review})).status,409);
  const details=await request('/operators/'+operatorId); assert.ok(details.data.operator.reviewCount>=1); assert.ok(details.data.reviews.some(r => r.title === 'Kiểm thử đánh giá' && r.verifiedBooking));
  const sample=(await request('/bootstrap')).data.operators.find(op => op.source === 'demo'),sampleReviews=await request('/operators/'+sample.id);
  assert.ok(sampleReviews.data.reviews.every(r => r.source === 'demo' && r.verifiedBooking === false));
});
test('production cannot seed demo or accept surviving demo credentials',async () => {
  await assert.rejects(() => createApi({env:{...env,NODE_ENV:'production'},seedDemo:true}),/cannot enable sample inventory/);
  await assert.rejects(() => createApi({env:{...env,NODE_ENV:'production',SEED_DEMO:'false'},seedDemo:false}),/refuses active demo credentials/);
});
function cryptoSuffix() {return require('node:crypto').randomBytes(5).toString('hex');}
