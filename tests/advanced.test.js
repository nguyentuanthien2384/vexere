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

let api,server,base,adminCookie,operatorId;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ticket4t-advanced-'));
const suffix=()=>crypto.randomBytes(6).toString('hex').toUpperCase();
const adminEmail='advanced-'+suffix().toLowerCase()+'@example.test';
async function req(route,{method='GET',body,cookie}={}) {
  const response=await fetch(base+'/api'+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function trip(extra={}) {
  const result=await req('/admin/trips',{method:'POST',cookie:adminCookie,body:{operatorId,from:'ho-chi-minh',to:'da-lat',date:addDays(todayVietnam(),4),departureTime:'06:00',durationMinutes:360,price:250000,totalSeats:9,type:'limousine',pickupPoints:['Văn phòng Đà Nẵng','Bến xe thử nghiệm'],dropoffPoints:['Bến xe Đà Lạt'],amenities:[],policies:[],provenance:'Nguồn kho vé kiểm thử nâng cao',...extra}});
  assert.equal(result.status,201,JSON.stringify(result.data));return result.data.trip;
}
function leg(item,seats=['A01'],extra={}) {return {tripId:item.id,seats,pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0],...extra};}
function customer(extra={}) {return {fullName:'Hành khách kiểm thử nâng cao',email:'advanced@example.test',phone:'0901234567',paymentMethod:'cash',...extra};}
async function promo(extra={}) {
  const result=await req('/admin/promotions',{method:'POST',cookie:adminCookie,body:{code:'ADV'+suffix(),title:'Ưu đãi kiểm thử',type:'percentage',value:10,minSpend:0,maxDiscount:0,maxUses:100,perCustomer:10,startsAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),...extra}});
  assert.equal(result.status,201,JSON.stringify(result.data));return result.data.promotion;
}
async function reserve(item,seats=['A01'],extra={}) {return req('/bookings',{method:'POST',body:{...customer(),...leg(item,seats),...extra}});}
async function roundLegs() {const outward=await trip(),returning=await trip({from:'da-lat',to:'ho-chi-minh',date:addDays(todayVietnam(),5),departureTime:'18:00'});return [outward,returning];}
before(async()=>{
  const env={NODE_ENV:'test',SEED_DEMO:'false',ADMIN_EMAIL:adminEmail,ADMIN_PASSWORD:'Advanced@12345',DATA_DIR:directory,APP_URL:'http://localhost:3000',VNPAY_TMN_CODE:'ADVTEST',VNPAY_HASH_SECRET:'advanced-testing-only-secret',...(process.env.TEST_DATABASE_URL?{DATABASE_URL:process.env.TEST_DATABASE_URL}:{})};
  api=await createApi({env,dataDir:directory,seedDemo:false});
  const app=express();app.use(express.json());app.use(session({name:'ticket4t.sid',secret:'advanced-test-secret',store:api.sessionStore,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax'}}));app.use('/api',api.router);
  server=await new Promise(resolve=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});base='http://127.0.0.1:'+server.address().port;
  const login=await req('/auth/login',{method:'POST',body:{email:adminEmail,password:'Advanced@12345'}});assert.equal(login.status,200);adminCookie=login.cookie;
  const created=await req('/admin/operators',{method:'POST',cookie:adminCookie,body:{name:'Nhà xe kiểm thử nâng cao '+suffix(),phone:'0901234567',description:'Kho vé thử nghiệm'}});assert.equal(created.status,201);operatorId=created.data.operator.id;
});
after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));if(api)await api.close();
  const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith('ticket4t-advanced-'));fs.rmSync(resolved,{recursive:true,force:true});
});

test('seat holds race atomically, expose no secrets and are consumed only with matching capability',async()=>{
  const item=await trip(),results=await Promise.all(Array.from({length:8},()=>req('/holds',{method:'POST',body:{tripId:item.id,seats:['A01']}})));
  assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===409).length,7);
  const winner=results.find(r=>r.status===201),hold=winner.data.hold;assert.match(hold.token,/^[a-f0-9]{64}$/);assert.ok(Date.parse(hold.expiresAt)>Date.now()+290000);
  const own=await req('/trips/'+item.id,{cookie:winner.cookie}),other=await req('/trips/'+item.id);
  assert.equal(own.data.seats[0].status,'held');assert.equal(own.data.seats[0].ownHold,true);assert.equal(other.data.seats[0].ownHold,false);assert.equal(other.data.availableSeats,8);assert.ok(!JSON.stringify(other.data).includes(hold.token));
  assert.equal((await reserve(item)).status,409);
  assert.equal((await reserve(item,['A01'],{holdToken:'0'.repeat(64)})).data.code,'HOLD_EXPIRED');
  assert.equal((await reserve(item,['A02'],{holdToken:hold.token})).data.code,'HOLD_MISMATCH');
  const booked=await reserve(item,['A01'],{holdToken:hold.token});assert.equal(booked.status,201);
  assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM seat_holds WHERE trip_id=?',[item.id])).n),0);
  assert.equal((await req('/trips/'+item.id)).data.seats[0].status,'booked');
});

test('hold replacement, release and expiration restore availability; owners can hold two trips maximum',async()=>{
  const item=await trip(),first=await req('/holds',{method:'POST',body:{tripId:item.id,seats:['A01']}}),cookie=first.cookie;
  const replaced=await req('/holds',{method:'POST',cookie,body:{tripId:item.id,seats:['A02']}});assert.equal(replaced.status,201);
  assert.equal((await req('/trips/'+item.id)).data.seats[0].status,'available');
  const second=await trip(),third=await trip();
  assert.equal((await req('/holds',{method:'POST',cookie,body:{tripId:second.id,seats:['A01']}})).status,201);
  assert.equal((await req('/holds',{method:'POST',cookie,body:{tripId:third.id,seats:['A01']}})).data.code,'HOLD_LIMIT');
  assert.equal((await req('/holds/'+replaced.data.hold.token,{method:'DELETE'})).data.released,true);
  const expiring=await req('/holds',{method:'POST',cookie,body:{tripId:item.id,seats:['A03']}});assert.equal(expiring.status,201);
  const holdHash=crypto.createHash('sha256').update(expiring.data.hold.token).digest('hex');
  await api.db.transaction(tx=>tx.run('UPDATE seat_holds SET expires_at=? WHERE hash=?',[new Date(Date.now()-1000).toISOString(),holdHash]));
  assert.equal((await req('/trips/'+item.id)).data.availableSeats,9);
  assert.equal((await reserve(item,['A03'],{holdToken:expiring.data.hold.token})).data.code,'HOLD_EXPIRED');
  assert.equal((await reserve(item,['A03'])).status,201);
});

test('promotions validate applicability, expiry, min spend, cap and customer quotas',async()=>{
  const item=await trip({seatPrices:{A02:300000}}),p=await promo({value:25,minSpend:500000,maxDiscount:100000,perCustomer:1,operatorIds:[operatorId],routeIds:['ho-chi-minh--da-lat']});
  const quoted=await req('/promotions/quote',{method:'POST',body:{legs:[leg(item,['A01','A02'])],couponCode:p.code.toLowerCase(),phone:'0901234567',total:1}});
  assert.equal(quoted.status,200);assert.deepEqual(quoted.data,{subtotal:550000,discount:100000,total:450000,couponCode:p.code});
  assert.equal((await req('/promotions/quote',{method:'POST',body:{legs:[leg(item)],couponCode:p.code,phone:'0901234567'}})).data.code,'COUPON_MIN_SPEND');
  const expired=await promo({startsAt:new Date(Date.now()-86400000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()});
  assert.equal((await req('/promotions/quote',{method:'POST',body:{legs:[leg(item)],couponCode:expired.code,phone:'0901234567'}})).data.code,'COUPON_EXPIRED');
  const booked=await reserve(item,['A01','A02'],{couponCode:p.code});assert.equal(booked.status,201);assert.equal(booked.data.booking.discount,100000);assert.equal(booked.data.booking.total,450000);
  assert.equal((await reserve(item,['A03','A04'],{couponCode:p.code})).data.code,'COUPON_QUOTA');
  const other=await trip({from:'da-lat',to:'ho-chi-minh'});
  assert.equal((await req('/promotions/quote',{method:'POST',body:{legs:[leg(other,['A01','A02'])],couponCode:p.code,phone:'0909999999'}})).data.code,'COUPON_NOT_APPLICABLE');
  assert.equal((await req('/admin/promotions',{method:'POST',cookie:adminCookie,body:p})).status,409);
});

test('global coupon quota is locked across concurrent trips; unpaid cancellation restores once',async()=>{
  const p=await promo({maxUses:1,perCustomer:1}),items=await Promise.all(Array.from({length:6},()=>trip()));
  const results=await Promise.all(items.map((item,i)=>reserve(item,['A01'],{couponCode:p.code,phone:'090123456'+i})));
  assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===409&&r.data.code==='COUPON_QUOTA').length,5);
  const booking=results.find(r=>r.status===201).data.booking;
  assert.equal((await req('/bookings/'+booking.code+'/cancel',{method:'POST',body:{phone:booking.phone}})).status,200);
  await req('/bookings/'+booking.code+'/cancel',{method:'POST',body:{phone:booking.phone}});
  const next=await reserve(items[0],['A02'],{couponCode:p.code,phone:'0901234599'});assert.equal(next.status,201);
  const usage=await req('/admin/promotions',{cookie:adminCookie});assert.equal(usage.data.promotions.find(x=>x.code===p.code).usedCount,1);
});

test('paid/refunded coupon remains consumed after cancellation',async()=>{
  const item=await trip(),p=await promo({maxUses:1,perCustomer:1}),booked=await reserve(item,['A01'],{couponCode:p.code}),code=booked.data.booking.code;
  await req('/admin/bookings/'+code+'/cash-receipt',{method:'POST',cookie:adminCookie,body:{reference:'ADV-CASH-'+suffix()}});
  await req('/bookings/'+code+'/cancel',{method:'POST',body:{phone:'0901234567'}});
  await req('/admin/bookings/'+code+'/refund-receipt',{method:'POST',cookie:adminCookie,body:{reference:'ADV-REFUND-'+suffix(),amount:booked.data.booking.total}});
  assert.equal((await reserve(item,['A02'],{couponCode:p.code,phone:'0909999999'})).data.code,'COUPON_QUOTA');
});

test('roundtrip is atomic, discounts reconcile and lookup requires phone',async()=>{
  const [outward,returning]=await roundLegs(),p=await promo({roundTripOnly:true,value:17,maxDiscount:70000});
  assert.equal((await reserve(outward,['A01'],{couponCode:p.code})).status,400);
  const result=await req('/orders',{method:'POST',body:{...customer(),legs:[leg(outward),leg(returning)],couponCode:p.code}});assert.equal(result.status,201);
  const order=result.data.order;assert.equal(order.subtotal,500000);assert.equal(order.discount,70000);assert.equal(order.total,430000);assert.equal(order.bookings.length,2);assert.equal(order.bookings.reduce((n,b)=>n+b.total,0),order.total);assert.equal(order.bookings.reduce((n,b)=>n+b.discount,0),order.discount);
  assert.equal((await req('/orders/lookup?code='+order.code+'&phone=0909999999')).status,404);
  assert.equal((await req('/orders/lookup?code='+order.code+'&phone=0901234567')).status,200);
  assert.equal((await req('/orders')).status,401);
  await req('/bookings/'+order.bookings[0].code+'/cancel',{method:'POST',body:{phone:'0901234567'}});
  const updated=(await req('/orders/lookup?code='+order.code+'&phone=0901234567')).data.order;assert.equal(updated.status,'partially_cancelled');assert.equal(updated.activeTotal,order.bookings[1].total);
});

test('roundtrip second-leg collision rolls back first leg, holds, order and coupon quota',async()=>{
  const [outward,returning]=await roundLegs(),p=await promo({roundTripOnly:true,maxUses:1});await reserve(returning);
  const held=await req('/holds',{method:'POST',body:{tripId:outward.id,seats:['A01']}}),before=Number((await api.db.get('SELECT COUNT(*) AS n FROM orders')).n);
  const result=await req('/orders',{method:'POST',body:{...customer(),legs:[leg(outward,['A01'],{holdToken:held.data.hold.token}),leg(returning)],couponCode:p.code}});assert.equal(result.status,409);
  assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM orders')).n),before);assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM reserved_seats WHERE trip_id=?',[outward.id])).n),0);
  assert.equal((await req('/trips/'+outward.id)).data.seats[0].status,'held');
  assert.equal((await req('/admin/promotions',{cookie:adminCookie})).data.promotions.find(x=>x.code===p.code).usedCount,0);
});

test('roundtrip validates chronology/direction/equal passengers and rejects aggregate online payment',async()=>{
  const [outward,returning]=await roundLegs();
  const badRoute=await req('/orders',{method:'POST',body:{...customer(),legs:[leg(outward),leg(outward,['A02'])]}});assert.equal(badRoute.status,400);
  assert.equal((await req('/orders',{method:'POST',body:{...customer(),legs:[leg(outward),leg(returning,['A01','A02'])]}})).status,400);
  assert.equal((await req('/orders',{method:'POST',body:{...customer({paymentMethod:'vnpay'}),legs:[leg(outward),leg(returning)]}})).data.code,'PAYMENT_UNSUPPORTED');
  const tooSoon=await trip({from:'da-lat',to:'ho-chi-minh',departureTime:'10:00'});
  assert.equal((await req('/orders',{method:'POST',body:{...customer(),legs:[leg(outward),leg(tooSoon)]}})).status,400);
});

test('roundtrip quota releases only after both unpaid legs cancel, including simultaneous cancellations',async()=>{
  const [outward,returning]=await roundLegs(),p=await promo({roundTripOnly:true,maxUses:1}),result=await req('/orders',{method:'POST',body:{...customer(),legs:[leg(outward),leg(returning)],couponCode:p.code}}),order=result.data.order;
  const cancellations=await Promise.all(order.bookings.map(b=>req('/bookings/'+b.code+'/cancel',{method:'POST',body:{phone:'0901234567'}})));assert.ok(cancellations.every(r=>r.status===200));
  const uses=await req('/admin/promotions',{cookie:adminCookie});assert.equal(uses.data.promotions.find(x=>x.code===p.code).usedCount,0);
  const another=await req('/orders',{method:'POST',body:{...customer(),legs:[leg(outward,['A02']),leg(returning,['A02'])],couponCode:p.code}});assert.equal(another.status,201);
});

test('reschedule is scoped and atomic, preserves discount, moves manifest and rejects fare difference',async()=>{
  const original=await trip(),target=await trip({date:addDays(todayVietnam(),6)}),p=await promo(),booked=await reserve(original,['A01'],{couponCode:p.code}),booking=booked.data.booking;
  assert.equal((await req('/bookings/'+booking.code+'/reschedule',{method:'POST',body:{...leg(target),phone:'0909999999'}})).status,404);
  await reserve(target,['A01']);
  assert.equal((await req('/bookings/'+booking.code+'/reschedule',{method:'POST',body:{...leg(target),phone:'0901234567'}})).status,409);
  assert.equal((await req('/trips/'+original.id)).data.seats[0].status,'booked');
  const moved=await req('/bookings/'+booking.code+'/reschedule',{method:'POST',body:{...leg(target,['A02']),phone:'0901234567'}});assert.equal(moved.status,200);assert.equal(moved.data.booking.tripId,target.id);assert.equal(moved.data.booking.discount,booking.discount);assert.equal(moved.data.booking.total,booking.total);
  assert.equal((await req('/trips/'+original.id)).data.seats[0].status,'available');
  const manifest=await req('/admin/trips/'+target.id+'/manifest',{cookie:adminCookie});assert.equal(manifest.status,200);assert.ok(manifest.data.passengers.some(b=>b.bookingCode===booking.code&&b.seats.includes('A02')));assert.equal(manifest.data.counts.passengers,2);
  assert.equal((await req('/admin/trips/'+target.id+'/manifest')).status,403);
  const expensive=await trip({price:300000});assert.equal((await req('/admin/bookings/'+booking.code+'/reschedule',{method:'POST',cookie:adminCookie,body:leg(expensive)})).data.code,'FARE_DIFFERENCE');
  const reverse=await trip({from:'da-lat',to:'ho-chi-minh'});assert.equal((await req('/admin/bookings/'+booking.code+'/reschedule',{method:'POST',cookie:adminCookie,body:leg(reverse)})).data.code,'RESCHEDULE_ROUTE');
  const events=await req('/admin/bookings/'+booking.code+'/events',{cookie:adminCookie});assert.ok(events.data.events.some(e=>e.event==='rescheduled'));
});

test('text stop filters support case-insensitive Vietnamese and keep paging totals consistent',async()=>{
  const item=await trip();
  const filtered=await req('/trips?from=ho-chi-minh&to=da-lat&date='+item.date+'&pickup='+encodeURIComponent('văn phòng đà nẵng')+'&limit=2');assert.equal(filtered.status,200);assert.ok(filtered.data.total>=1);assert.ok(filtered.data.trips.every(t=>t.pickupPoints.some(p=>p.toLocaleLowerCase('vi').includes('đà nẵng'))));
  assert.equal((await req('/trips?from=ho-chi-minh&to=da-lat&date='+item.date+'&dropoff=nonexistent-stop')).data.total,0);
  assert.ok((await req('/trips?date='+item.date+'&q='+encodeURIComponent('limousine'))).data.total>=1);
  assert.ok((await req('/trips?date='+item.date+'&q='+encodeURIComponent('nhà xe kiểm thử nâng cao'))).data.total>=1);
  assert.ok((await req('/trips?date='+item.date+'&q='+encodeURIComponent('đà lạt'))).data.total>=1);
});
test('100 percent asymmetric roundtrip discount still leaves each leg payable and reconciled',async()=>{
  const outward=await trip({price:10000}),returning=await trip({from:'da-lat',to:'ho-chi-minh',date:addDays(todayVietnam(),5),price:1000000}),p=await promo({value:100,roundTripOnly:true});
  const result=await req('/orders',{method:'POST',body:{...customer(),legs:[leg(outward),leg(returning)],couponCode:p.code}});assert.equal(result.status,201);
  const order=result.data.order;assert.equal(order.total,2);assert.equal(order.discount,1009998);assert.deepEqual(order.bookings.map(b=>b.total),[1,1]);assert.equal(order.bookings.reduce((n,b)=>n+b.discount,0),order.discount);
  const receipt=await req('/admin/bookings/'+order.bookings[0].code+'/cash-receipt',{method:'POST',cookie:adminCookie,body:{reference:'ONE-DONG-TEST-'+suffix()}});assert.equal(receipt.status,200);
});
test('guest hold stays recognized through secure login session regeneration',async()=>{
  const item=await trip(),held=await req('/holds',{method:'POST',body:{tripId:item.id,seats:['A01']}});
  const login=await req('/auth/login',{method:'POST',cookie:held.cookie,body:{email:adminEmail,password:'Advanced@12345'}});assert.equal(login.status,200);assert.notEqual(login.cookie,held.cookie);
  const details=await req('/trips/'+item.id,{cookie:login.cookie});assert.equal(details.data.seats[0].ownHold,true);
  const booked=await req('/bookings',{method:'POST',cookie:login.cookie,body:{...customer(),...leg(item),holdToken:held.data.hold.token}});assert.equal(booked.status,201);
});
test('expired pending payment releases promotion allowance before a new checkout',async()=>{
  const item=await trip(),p=await promo({maxUses:1}),pending=await reserve(item,['A01'],{couponCode:p.code,paymentMethod:'vnpay'});assert.equal(pending.status,201);
  await api.db.transaction(tx=>tx.run('UPDATE bookings SET expires_at=? WHERE code=?',[new Date(Date.now()-1000).toISOString(),pending.data.booking.code]));
  const quoted=await req('/promotions/quote',{method:'POST',body:{legs:[leg(item)],couponCode:p.code,phone:'0909999999'}});assert.equal(quoted.status,200);
  const booked=await reserve(item,['A01'],{couponCode:p.code,phone:'0909999999'});assert.equal(booked.status,201);
});
test('trip PATCH rechecks owner after waiting for an admin reassignment lock',async()=>{
  const item=await trip(),other=await req('/admin/operators',{method:'POST',cookie:adminCookie,body:{name:'Nhà xe nhận lại '+suffix(),phone:'0901234567'}}),email='operator-'+suffix().toLowerCase()+'@example.test';
  const staff=await req('/admin/users',{method:'POST',cookie:adminCookie,body:{fullName:'Nhân viên kiểm thử quyền',email,phone:'0901234567',password:'Operator@12345',role:'operator',operatorId}});assert.equal(staff.status,201);
  const logged=await req('/auth/login',{method:'POST',body:{email,password:'Operator@12345'}});assert.equal(logged.status,200);
  let unlock,locked;const gate=new Promise(resolve=>{unlock=resolve;}),ready=new Promise(resolve=>{locked=resolve;});
  const reassignment=api.db.transaction(async tx=>{
    const row=await tx.get('SELECT * FROM trips WHERE id=?'+(api.db.dialect==='postgres'?' FOR UPDATE':''),[item.id]);locked();await gate;
    const data={...JSON.parse(row.data),operatorId:other.data.operator.id,operatorName:other.data.operator.name};await tx.run('UPDATE trips SET operator_id=?,data=? WHERE id=?',[data.operatorId,JSON.stringify(data),item.id]);
  });
  await ready;const stale=req('/admin/trips/'+item.id,{method:'PATCH',cookie:logged.cookie,body:{price:260000}});await new Promise(resolve=>setTimeout(resolve,30));unlock();await reassignment;
  const result=await stale;assert.equal(result.status,403);assert.equal((await req('/trips/'+item.id)).data.operatorId,other.data.operator.id);
});
test('active holds protect fare and seat layout edits until expiry',async()=>{
  const item=await trip(),held=await req('/holds',{method:'POST',body:{tripId:item.id,seats:['A01']}});
  assert.equal((await req('/admin/trips/'+item.id,{method:'PATCH',cookie:adminCookie,body:{price:260000}})).status,409);
  assert.equal((await req('/admin/trips/'+item.id,{method:'PATCH',cookie:adminCookie,body:{totalSeats:20}})).status,409);
  const holdHash=crypto.createHash('sha256').update(held.data.hold.token).digest('hex');
  await api.db.transaction(tx=>tx.run('UPDATE seat_holds SET expires_at=? WHERE hash=?',[new Date(Date.now()-1000).toISOString(),holdHash]));
  const edit=await req('/admin/trips/'+item.id,{method:'PATCH',cookie:adminCookie,body:{price:260000}});assert.equal(edit.status,200);assert.equal(edit.data.trip.price,260000);
});
