'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createApp} = require('../../index');
const {todayVietnam,addDays} = require('../../server/catalog');

async function createFeatureFixture(t,{disableRateLimit=true}={}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'ticket4t-feature-contracts-'));
  const env = {NODE_ENV:'test',SEED_DEMO:'false',SESSION_SECRET:'feature-contracts-isolated-session-secret',ADMIN_EMAIL:'feature-admin@example.test',ADMIN_PASSWORD:'FeatureAdmin@12345'};
  let runtime,server,adminCookie,operator;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (runtime) await runtime.close();
    const target = path.resolve(dataDir);
    assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(target).startsWith('ticket4t-feature-contracts-'));
    await fs.rm(target,{recursive:true,force:true});
  });
  runtime = await createApp({env,dataDir,seedDemo:false,disableRateLimit});
  server = runtime.app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const base = 'http://127.0.0.1:'+server.address().port;
  async function request(route,{method='GET',body,cookie=adminCookie,headers={}}={}) {
    const response = await fetch(base+'/api'+route,{method,headers:{...(body!==undefined ? {'Content-Type':'application/json'} : {}),...(cookie ? {Cookie:cookie} : {}),...headers},body:body!==undefined ? JSON.stringify(body) : undefined,redirect:'manual'});
    const raw = await response.text();
    let data;
    try {data=JSON.parse(raw);} catch {data={text:raw};}
    return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  function expect(result,status) {assert.equal(result.status,status,JSON.stringify(result.data));return result;}
  const login = async (email,password) => expect(await request('/auth/login',{method:'POST',cookie:null,body:{email,password}}),200);
  adminCookie = (await login(env.ADMIN_EMAIL,env.ADMIN_PASSWORD)).cookie;
  async function customer(name='customer',extra={}) {
    const result = expect(await request('/auth/register',{method:'POST',cookie:null,body:{fullName:'Hành khách '+name,email:name+'@example.test',phone:'0901234567',password:'Customer@12345',...extra}}),201);
    return {...result,user:result.data.user};
  }
  async function company() {
    if (!operator) operator = expect(await request('/admin/operators',{method:'POST',body:{name:'Nhà xe hợp đồng kiểm thử',phone:'0901234567'}}),201).data.operator;
    return operator;
  }
  async function trip(extra={}) {
    const op = await company();
    return expect(await request('/admin/trips',{method:'POST',body:{operatorId:op.id,from:'ho-chi-minh',to:'da-lat',date:addDays(todayVietnam(),2),departureTime:'18:00',type:'limousine',price:250000,totalSeats:9,durationMinutes:360,pickupPoints:['Văn phòng kiểm thử'],dropoffPoints:['Bến xe Đà Lạt kiểm thử'],provenance:'Kho ghế riêng cho ca kiểm thử hợp đồng',...extra}}),201).data.trip;
  }
  function bookingBody(item,extra={}) {return {tripId:item.id,seats:['A01'],pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0],fullName:'Hành khách hợp đồng kiểm thử',phone:'0901234567',email:'booking@example.test',paymentMethod:'cash',...extra};}
  async function reserve(item,{cookie=null,...extra}={}) {
    return expect(await request('/bookings',{method:'POST',cookie,body:bookingBody(item,extra)}),201).data.booking;
  }
  async function complete(booking) {
    await runtime.api.db.transaction(async tx => {
      const row = await tx.get('SELECT data FROM bookings WHERE code=?',[booking.code]);
      const snapshot = JSON.parse(row.data);
      snapshot.trip.date = addDays(todayVietnam(),-2);
      snapshot.trip.departureTime = '06:00';
      snapshot.trip.durationMinutes = 60;
      await tx.run('UPDATE bookings SET data=? WHERE code=?',[JSON.stringify(snapshot),booking.code]);
    });
  }
  async function paidCompleted(cookie,extra={}) {
    const item = await trip();
    const booking = await reserve(item,{cookie,...extra});
    expect(await request('/admin/bookings/'+booking.code+'/cash-receipt',{method:'POST',body:{reference:'IT-RECEIPT-'+booking.code,amount:booking.total}}),200);
    await complete(booking);
    return booking;
  }
  async function staff(extra={}) {
    const op = await company();
    return expect(await request('/admin/users',{method:'POST',body:{fullName:'Nhân viên hợp đồng kiểm thử',email:'feature-staff@example.test',phone:'0901234567',password:'StaffTest@12345',role:'operator',operatorId:op.id,...extra}}),201).data.user;
  }
  async function lastToken(email,subject) {
    const row = await runtime.api.db.get('SELECT body FROM email_outbox WHERE recipient=? AND subject=? ORDER BY created_at DESC',[email,subject]);
    assert.ok(row,'expected local test email');
    return row.body.match(/token=([a-f0-9]{64})/)[1];
  }
  return {runtime,db:runtime.api.db,base,request,expect,login,customer,company,trip,bookingBody,reserve,complete,paidCompleted,staff,lastToken,adminCookie,today:todayVietnam(),env};
}

module.exports = {createFeatureFixture};
