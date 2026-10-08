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

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ticket4t-admin-'));
const suffix=()=>crypto.randomBytes(6).toString('hex');
let api,server,base,adminCookie,operatorId,otherOperatorId,operatorCookie,operatorUserId;
const adminEmail='admin-'+suffix()+'@example.test';
async function req(route,{method='GET',body,cookie=adminCookie}={}) {
  const response=await fetch(base+'/api'+route,{method,headers:{...(body!==undefined ? {'Content-Type':'application/json'} : {}),...(cookie ? {Cookie:cookie} : {})},body:body!==undefined ? JSON.stringify(body) : undefined});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function trip(extra={}) {
  const result=await req('/admin/trips',{method:'POST',body:{operatorId,from:'ho-chi-minh',to:'da-lat',date:addDays(todayVietnam(),4),departureTime:'18:00',durationMinutes:360,price:250000,totalSeats:9,type:'limousine',pickupPoints:['Bến xe thử nghiệm'],dropoffPoints:['Điểm trả thử nghiệm'],provenance:'Kho vé kiểm thử quản trị',...extra}});
  assert.equal(result.status,201,JSON.stringify(result.data));return result.data.trip;
}
const customer=(item,extra={})=>({tripId:item.id,seats:['A01'],pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0],fullName:'Hành khách tại quầy',phone:'0901234567',email:'customer@example.test',paymentMethod:'cash',...extra});
async function reserve(item,extra={}) {const result=await req('/bookings',{method:'POST',cookie:null,body:customer(item,extra)});assert.equal(result.status,201,JSON.stringify(result.data));return result.data.booking;}
async function receipt(code,extra={}) {return req('/admin/bookings/'+code+'/cash-receipt',{method:'POST',body:{reference:'CASH-'+suffix(),amount:250000,...extra}});}
before(async()=>{
  api=await createApi({env:{NODE_ENV:'test',SEED_DEMO:'false',ADMIN_EMAIL:adminEmail,ADMIN_PASSWORD:'AdminTest@12345',DATA_DIR:directory,...(process.env.TEST_DATABASE_URL ? {DATABASE_URL:process.env.TEST_DATABASE_URL} : {})},dataDir:directory,seedDemo:false});
  const app=express();app.use(express.json());app.use(session({name:'ticket4t.sid',secret:'admin-testing-secret',store:api.sessionStore,resave:false,saveUninitialized:false}));app.use('/api',api.router);
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});base='http://127.0.0.1:'+server.address().port;
  const login=await req('/auth/login',{method:'POST',cookie:null,body:{email:adminEmail,password:'AdminTest@12345'}});assert.equal(login.status,200);adminCookie=login.cookie;
  for(const name of ['Nhà xe quản trị A','Nhà xe quản trị B']){const result=await req('/admin/operators',{method:'POST',body:{name:name+' '+suffix(),phone:'0901234567'}});assert.equal(result.status,201);if(!operatorId)operatorId=result.data.operator.id;else otherOperatorId=result.data.operator.id;}
  const email='operator-'+suffix()+'@example.test';const staff=await req('/admin/users',{method:'POST',body:{fullName:'Nhân viên quản trị',email,phone:'0901234567',role:'operator',operatorId,password:'OperatorTest@12345'}});assert.equal(staff.status,201);operatorUserId=staff.data.user.id;
  const operator=await req('/auth/login',{method:'POST',cookie:null,body:{email,password:'OperatorTest@12345'}});assert.equal(operator.status,200);operatorCookie=operator.cookie;
});
after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));if(api)await api.close();
  const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith('ticket4t-admin-'));fs.rmSync(resolved,{recursive:true,force:true});
});

test('revenue comes from receipts and remains collected while a refund is pending',async()=>{
  const item=await trip(),booking=await reserve(item),before=(await req('/admin/stats')).data.stats;
  assert.equal((await receipt(booking.code,{amount:1})).status,400);
  assert.equal((await req('/bookings/lookup?code='+booking.code+'&phone=0901234567',{cookie:null})).data.booking.paymentStatus,'pending');
  assert.equal((await receipt(booking.code)).status,200);
  const paid=(await req('/admin/stats')).data.stats;assert.equal(paid.grossRevenue,before.grossRevenue+booking.total);assert.equal(paid.revenue,before.revenue+booking.total);
  assert.equal((await req('/admin/bookings/'+booking.code,{method:'PATCH',body:{status:'cancelled'}})).status,200);
  const pending=(await req('/admin/stats')).data.stats;assert.equal(pending.revenue,paid.revenue);assert.equal(pending.refundPendingAmount,before.refundPendingAmount+booking.total);
  assert.equal((await req('/admin/bookings/'+booking.code+'/refund-receipt',{method:'POST',body:{reference:'REFUND-'+suffix(),amount:booking.total}})).status,200);
  const refunded=(await req('/admin/stats')).data.stats;assert.equal(refunded.grossRevenue,paid.grossRevenue);assert.equal(refunded.refundedAmount,before.refundedAmount+booking.total);assert.equal(refunded.revenue,before.revenue);assert.equal(refunded.refundPendingAmount,before.refundPendingAmount);
});

test('reports use inclusive Vietnamese dates for bookings, receipts and trips independently',async()=>{
  const first=await trip({date:addDays(todayVietnam(),6)}),second=await trip({date:addDays(todayVietnam(),7),price:300000}),a=await reserve(first),b=await reserve(second);
  assert.equal((await receipt(a.code)).status,200);assert.equal((await receipt(b.code,{amount:b.total})).status,200);
  // These UTC instants straddle midnight on two local dates.
  await api.db.transaction(async tx=>{await tx.run('UPDATE bookings SET created_at=? WHERE code=?',['2020-04-01T17:00:00.000Z',a.code]);await tx.run('UPDATE bookings SET created_at=? WHERE code=?',['2020-04-01T16:59:59.999Z',b.code]);await tx.run('UPDATE payments SET created_at=? WHERE booking_code=?',['2020-04-01T17:00:00.000Z',a.code]);await tx.run('UPDATE payments SET created_at=? WHERE booking_code=?',['2020-04-02T17:00:00.000Z',b.code]);});
  const april2=await req('/admin/stats?dateFrom=2020-04-02&dateTo=2020-04-02');assert.equal(april2.status,200);assert.equal(april2.data.stats.bookings,1);assert.equal(april2.data.stats.trips,0);assert.equal(april2.data.stats.grossRevenue,250000);assert.equal(april2.data.stats.revenue,250000);assert.deepEqual(april2.data.analytics.daily,[{date:'2020-04-02',bookings:1,grossRevenue:250000,refundedAmount:0,revenue:250000}]);
  const april3=(await req('/admin/stats?dateFrom=2020-04-03&dateTo=2020-04-03')).data;assert.equal(april3.stats.bookings,0);assert.equal(april3.stats.grossRevenue,300000);assert.equal(april3.analytics.byPaymentMethod.find(row=>row.paymentMethod==='cash').revenue,300000);
  const filtered=await req('/admin/bookings?dateFrom=2020-04-02&dateTo=2020-04-02&operator='+operatorId+'&paymentStatus=paid');assert.deepEqual(filtered.data.bookings.map(row=>row.code),[a.code]);
  const departures=(await req('/admin/stats?dateFrom='+first.date+'&dateTo='+first.date)).data;assert.equal(departures.stats.trips,1);
  for(const query of ['dateFrom=2020-02-30','dateFrom=2020-04-03&dateTo=2020-04-02','dateFrom=2020-01-01&dateTo=2021-01-01','dateTo=9999-12-31','dateTo=0000-01-01'])assert.equal((await req('/admin/stats?'+query)).status,400);
});

test('audit is persistent, paginated, filtered, scoped and excludes customer passwords',async()=>{
  const item=await trip(),other=await trip({operatorId:otherOperatorId});
  const own=await req('/admin/trips/'+item.id,{method:'PATCH',cookie:operatorCookie,body:{amenities:['Điều hòa']}});assert.equal(own.status,200);
  const rejected=await req('/admin/trips/'+other.id,{method:'PATCH',cookie:operatorCookie,body:{price:270000}});assert.equal(rejected.status,403);
  const filtered=await req('/admin/audit?entityType=trip&entityId='+item.id+'&action=trip_updated&actor='+operatorUserId+'&dateFrom='+todayVietnam()+'&dateTo='+todayVietnam());assert.equal(filtered.status,200);assert.equal(filtered.data.total,1);assert.equal(filtered.data.events[0].actorName,'Nhân viên quản trị');assert.equal(filtered.data.events[0].operatorId,operatorId);assert.deepEqual(filtered.data.events[0].data.changedFields,['amenities']);
  const scoped=await req('/admin/audit?limit=1',{cookie:operatorCookie});assert.equal(scoped.data.events.length,1);assert.ok(scoped.data.total>=1);assert.ok(scoped.data.events.every(row=>row.operatorId===operatorId));assert.ok(scoped.data.pages>=1);
  assert.equal((await req('/admin/audit?operator='+otherOperatorId,{cookie:operatorCookie})).data.total,0);
  const users=(await req('/admin/audit?entityType=user')).data.events;assert.ok(users.some(row=>row.entityId===operatorUserId));assert.ok(!JSON.stringify(users).includes('OperatorTest@12345'));assert.ok(!JSON.stringify(users).includes('password_hash'));
  assert.equal((await req('/admin/audit',{cookie:null})).status,403);
  assert.equal((await req('/admin/audit?dateFrom=2020-02-30')).status,400);
});

test('successful booking actions audit once; validation errors roll back logs and inventory',async()=>{
  const item=await trip(),booking=await reserve(item);
  const confirm=()=>req('/admin/bookings/'+booking.code,{method:'PATCH',body:{status:'confirmed'}});assert.equal((await confirm()).status,200);assert.equal((await confirm()).status,200);
  const logs=()=>req('/admin/audit?entityId='+booking.code);assert.equal((await logs()).data.events.filter(row=>row.action==='booking_confirmed').length,1);
  assert.equal((await receipt(booking.code,{amount:1})).status,400);assert.equal((await logs()).data.events.filter(row=>row.action==='cash_received').length,0);
  const before=Number((await api.db.get('SELECT COUNT(*) AS n FROM trips')).n),audits=Number((await api.db.get('SELECT COUNT(*) AS n FROM admin_audit_events')).n);
  const imported=await req('/admin/import',{method:'POST',body:{source:'operator',sourceReference:'Kho vé kiểm thử quản trị',trips:[item,null]}});assert.equal(imported.status,400);assert.match(imported.data.error,/Dòng 2/);assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM trips')).n),before);assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM admin_audit_events')).n),audits);
});

test('counter checkout is scoped, atomic, uses real fare and keeps staff out of customer history',async()=>{
  const own=await trip({seatPrices:{A02:280000}}),other=await trip({operatorId:otherOperatorId});
  assert.equal((await req('/admin/bookings',{method:'POST',cookie:null,body:customer(own)})).status,403);
  assert.equal((await req('/admin/bookings',{method:'POST',cookie:operatorCookie,body:customer(other)})).status,403);
  assert.equal((await req('/admin/bookings',{method:'POST',body:customer(own,{paymentMethod:'vnpay'})})).status,400);
  const result=await req('/admin/bookings',{method:'POST',cookie:operatorCookie,body:customer(own,{seats:['A02'],email:'',total:1})});assert.equal(result.status,201);assert.equal(result.data.booking.total,280000);assert.equal(result.data.booking.userId,null);assert.equal(result.data.booking.createdBy,operatorUserId);assert.equal(result.data.booking.channel,'counter');assert.equal(result.data.booking.status,'reserved');assert.equal(result.data.booking.paymentStatus,'pending');
  const stored=await api.db.get('SELECT user_id FROM bookings WHERE code=?',[result.data.booking.code]);assert.equal(stored.user_id,null);
  assert.equal((await req('/admin/bookings',{method:'POST',cookie:operatorCookie,body:customer(own,{seats:['A02']})})).status,409);
  const logs=await req('/admin/audit?entityId='+result.data.booking.code);assert.equal(logs.data.total,1);assert.equal(logs.data.events[0].action,'counter_booking_created');
  const updated=(await req('/admin/trips?operator='+operatorId+'&date='+own.date+'&limit=100')).data.trips.find(row=>row.id===own.id);assert.equal(updated.bookedSeats,1);assert.equal(updated.occupiedSeats,1);assert.equal(updated.heldSeats,0);
  const races=await Promise.all(Array.from({length:4},()=>req('/admin/bookings',{method:'POST',body:customer(own,{seats:['A03']})})));assert.equal(races.filter(row=>row.status===201).length,1);assert.equal(races.filter(row=>row.status===409).length,3);
});

test('admin identity cannot be demoted or disabled and boolean fields are strict',async()=>{
  const current=(await req('/auth/me')).data.user;
  for(const body of [{active:false},{role:'customer'}])assert.equal((await req('/admin/users/'+current.id,{method:'PATCH',body})).status,403);
  assert.equal((await req('/auth/me')).data.user.role,'admin');
  const item=await trip();assert.equal((await req('/admin/trips/'+item.id,{method:'PATCH',body:{active:'false'}})).status,400);
  assert.equal((await req('/admin/operators/'+operatorId,{method:'PATCH',body:{active:'false'}})).status,400);
  assert.equal((await req('/admin/users/'+operatorUserId,{method:'PATCH',body:{active:'false'}})).status,400);
  assert.equal((await req('/admin/trips/'+item.id,{method:'PATCH',body:{date:item.date+'garbage'}})).status,400);
  assert.equal((await req('/admin/trips/'+item.id,{method:'PATCH',body:{departureTime:'18:00garbage'}})).status,400);
});

test('historical operator, fare and route ownership survive reassignment of cancelled inventory',async()=>{
  const item=await trip(),booking=await reserve(item);assert.equal((await receipt(booking.code)).status,200);
  assert.equal((await req('/admin/bookings/'+booking.code,{method:'PATCH',body:{status:'cancelled'}})).status,200);
  const original=(await req('/admin/stats',{cookie:operatorCookie})).data.stats;
  const reassigned=await req('/admin/trips/'+item.id,{method:'PATCH',body:{operatorId:otherOperatorId,from:'ha-noi',to:'sa-pa',price:350000}});assert.equal(reassigned.status,200);
  const originalScope=await req('/admin/bookings?code='+booking.code,{cookie:operatorCookie});assert.equal(originalScope.data.total,1);assert.equal(originalScope.data.bookings[0].trip.operatorId,operatorId);assert.equal(originalScope.data.bookings[0].trip.from,'ho-chi-minh');
  assert.equal((await req('/admin/bookings?code='+booking.code+'&operator='+otherOperatorId)).data.total,0);
  const after=(await req('/admin/stats',{cookie:operatorCookie})).data;assert.equal(after.stats.grossRevenue,original.grossRevenue);assert.equal(after.stats.refundPendingAmount,original.refundPendingAmount);assert.ok(!after.analytics.byRoute.some(row=>row.from==='ha-noi'&&row.to==='sa-pa'));
  const email='other-operator-'+suffix()+'@example.test';assert.equal((await req('/admin/users',{method:'POST',body:{fullName:'Nhân viên nhà xe B',email,phone:'0901234567',role:'operator',operatorId:otherOperatorId,password:'OperatorTest@12345'}})).status,201);
  const logged=await req('/auth/login',{method:'POST',cookie:null,body:{email,password:'OperatorTest@12345'}});assert.equal(logged.status,200);
  assert.equal((await req('/admin/bookings?code='+booking.code,{cookie:logged.cookie})).data.total,0);assert.equal((await req('/admin/bookings/'+booking.code+'/events',{cookie:logged.cookie})).status,403);
  assert.equal((await req('/admin/bookings/'+booking.code+'/refund-receipt',{method:'POST',cookie:logged.cookie,body:{reference:'REFUND-'+suffix(),amount:booking.total}})).status,403);
  assert.equal((await req('/admin/bookings/'+booking.code+'/refund-receipt',{method:'POST',cookie:operatorCookie,body:{reference:'REFUND-'+suffix(),amount:booking.total}})).status,200);
});

test('operators cannot reopen a company disabled by the administrator',async()=>{
  assert.equal((await req('/admin/operators/'+operatorId,{method:'DELETE'})).status,200);
  assert.equal((await req('/admin/operators/'+operatorId,{method:'PATCH',cookie:operatorCookie,body:{active:true}})).status,403);
  assert.equal((await req('/admin/operators',{cookie:operatorCookie})).data.operators[0].active,false);
  assert.equal((await req('/admin/operators/'+operatorId,{method:'PATCH',body:{active:true}})).status,200);
});

test('counter transaction rechecks changed staff scope while queued',async()=>{
  const item=await trip();let unlock,locked;
  const gate=new Promise(resolve=>{unlock=resolve;}),ready=new Promise(resolve=>{locked=resolve;});
  const change=api.db.transaction(async tx=>{await tx.get('SELECT id FROM users WHERE id=?'+(api.db.dialect==='postgres'?' FOR UPDATE':''),[operatorUserId]);locked();await gate;await tx.run('UPDATE users SET operator_id=? WHERE id=?',[otherOperatorId,operatorUserId]);});
  await ready;const attempt=req('/admin/bookings',{method:'POST',cookie:operatorCookie,body:customer(item)});await new Promise(resolve=>setTimeout(resolve,30));unlock();await change;
  const result=await attempt;assert.equal(result.status,403);assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM bookings WHERE trip_id=?',[item.id])).n),0);
  await api.db.transaction(tx=>tx.run('UPDATE users SET operator_id=? WHERE id=?',[operatorId,operatorUserId]));
});

test('counter checkout rejects a staff session disabled while its transaction is queued',async()=>{
  const item=await trip(),email='revoked-'+suffix()+'@example.test';
  const created=await req('/admin/users',{method:'POST',body:{fullName:'Nhân viên bị thu hồi quyền',email,phone:'0901234567',role:'operator',operatorId,password:'OperatorTest@12345'}});assert.equal(created.status,201);
  const logged=await req('/auth/login',{method:'POST',cookie:null,body:{email,password:'OperatorTest@12345'}});assert.equal(logged.status,200);
  let unlock,locked;const gate=new Promise(resolve=>{unlock=resolve;}),ready=new Promise(resolve=>{locked=resolve;});
  const revoke=api.db.transaction(async tx=>{await tx.get('SELECT id FROM users WHERE id=?'+(api.db.dialect==='postgres'?' FOR UPDATE':''),[created.data.user.id]);locked();await gate;await tx.run('UPDATE users SET active=0,auth_version=auth_version+1 WHERE id=?',[created.data.user.id]);});
  await ready;const attempt=req('/admin/bookings',{method:'POST',cookie:logged.cookie,body:customer(item)});await new Promise(resolve=>setTimeout(resolve,30));unlock();await revoke;
  assert.equal((await attempt).status,403);assert.equal(Number((await api.db.get('SELECT COUNT(*) AS n FROM bookings WHERE trip_id=?',[item.id])).n),0);
  assert.equal((await req('/admin/audit?actor='+created.data.user.id)).data.total,0);
});
