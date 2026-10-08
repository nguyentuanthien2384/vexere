'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {createFeatureFixture}=require('./helpers/feature-fixture');
const {addDays}=require('../server/catalog');

async function notificationFailure(t,{asOrder=false,storage='database'}={}) {
  const f=await createFeatureFixture(t,{databaseUrl:process.env.TEST_DATABASE_URL}),outward=await f.trip();
  const returning=asOrder ? await f.trip({from:'da-lat',to:'ho-chi-minh',date:addDays(outward.date,1)}) : null;
  const promotion=f.expect(await f.request('/admin/promotions',{method:'POST',body:{code:'MAILRECOVERY',title:'Ưu đãi kiểm thử thông báo',type:'percentage',value:10,maxUses:1,perCustomer:1}}),201).data.promotion;
  const leg=item=>({tripId:item.id,seats:['A01'],pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0]});
  const payload={...f.bookingBody(outward),couponCode:promotion.code,...(asOrder ? {legs:[leg(outward),leg(returning)]} : {})};
  if(asOrder)for(const field of ['tripId','seats','pickup','dropoff'])delete payload[field];
  const key=crypto.randomUUID(),route=asOrder ? '/orders' : '/bookings',logs=[];
  const failure=new Error('Private notification failure '+payload.email+' '+payload.phone+' private-recovery-token');
  let attempts=0;
  if(storage==='database') {
    const transaction=f.db.transaction.bind(f.db);
    t.mock.method(f.db,'transaction',work=>transaction(tx=>work({...tx,async run(sql,params) {
      if(sql.startsWith('INSERT INTO email_outbox')){attempts++;throw failure;}
      return tx.run(sql,params);
    }})));
  } else {
    const append=fs.appendFileSync;
    t.mock.method(fs,'appendFileSync',function(filename,...args) {
      if(path.basename(filename)==='email-outbox.jsonl'){attempts++;throw failure;}
      return append.call(this,filename,...args);
    });
  }
  t.mock.method(console,'error',(...args)=>logs.push(args));
  const request=()=>f.request(route,{method:'POST',cookie:null,body:payload,headers:{'Idempotency-Key':key}});
  const first=f.expect(await request(),201).data;
  assert.deepEqual(first.emailDelivery,{delivered:false});
  const bookings=asOrder ? first.order.bookings : [first.booking],codes=bookings.map(item=>item.code);
  assert.equal(codes.length,asOrder ? 2 : 1);
  for(const item of bookings){assert.equal(item.status,'reserved');assert.equal(item.paymentStatus,'pending');assert.equal(item.total,225000);}
  assert.equal(attempts,1);
  assert.deepEqual(logs,[['Booking notification failed:','EMAIL_NOTIFICATION_FAILED']]);
  for(const secret of [payload.email,payload.phone,payload.fullName,'private-recovery-token',failure.message,...codes])assert.ok(!JSON.stringify(logs).includes(secret),'Notification logs omit private data');
  const replay=f.expect(await request(),201);
  assert.equal(replay.data.replayed,true);assert.equal(replay.headers.get('idempotency-replayed'),'true');
  assert.deepEqual(replay.data.emailDelivery,{delivered:false,skipped:true});
  assert.deepEqual((asOrder ? replay.data.order.bookings : [replay.data.booking]).map(item=>item.code),codes);
  assert.equal(attempts,1,'A replay does not retry ambiguous notification delivery');assert.equal(logs.length,1);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM bookings')).n),codes.length);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM reserved_seats')).n),codes.length);
  assert.equal(Number((await f.db.get("SELECT COUNT(*) AS n FROM booking_events WHERE event='created'")).n),codes.length);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM checkout_requests')).n),1);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM promotion_uses')).n),1);
  assert.equal(Number((await f.db.get('SELECT used_count FROM promotions WHERE code=?',[promotion.code])).used_count),1);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM orders')).n),asOrder ? 1 : 0);
  const outbox=await f.db.all('SELECT status FROM email_outbox');
  assert.deepEqual(outbox.map(item=>item.status),storage==='database' ? [] : ['development']);
}

test('[IT-NOTIFY-001] outbox database failure cannot hide a committed single booking or duplicate its stock and coupon on retry',async t=>notificationFailure(t));
test('[IT-NOTIFY-002] outbox database failure returns the committed roundtrip and replay never sends a second notification',async t=>notificationFailure(t,{asOrder:true}));
test('[IT-NOTIFY-003] development outbox file failure preserves single-booking success and records no private error details',async t=>notificationFailure(t,{storage:'file'}));
test('[IT-NOTIFY-004] development outbox file failure preserves both roundtrip legs and their one-time promotion use',async t=>notificationFailure(t,{asOrder:true,storage:'file'}));
