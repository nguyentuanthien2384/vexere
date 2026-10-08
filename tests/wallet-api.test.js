'use strict';

const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../index');
const {todayVietnam,addDays}=require('../server/catalog');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ticket4t-wallet-api-'));
const suffix=()=>crypto.randomBytes(10).toString('hex');
const env={NODE_ENV:'test',SEED_DEMO:'false',APP_URL:'https://ticket4t.example',DATA_DIR:directory,ADMIN_EMAIL:'wallet-api-'+suffix()+'@example.test',ADMIN_PASSWORD:'WalletAPI@12345',MOMO_PARTNER_CODE:'MOMOTEST',MOMO_ACCESS_KEY:'access-test',MOMO_SECRET_KEY:'secret-test',ZALOPAY_APP_ID:'2553',ZALOPAY_KEY1:'key1-test',ZALOPAY_KEY2:'key2-test',...(process.env.TEST_DATABASE_URL?{DATABASE_URL:process.env.TEST_DATABASE_URL}:{})};
let runtime,server,base,cookie,operatorId,networkFailure=false,providerCalls=0;
const hmac=(key,value)=>crypto.createHmac('sha256',key).update(value).digest('hex');
async function transport(url,options) {
  providerCalls++;
  if(networkFailure)throw new Error('timeout after request may have been accepted');
  const payload=JSON.parse(options.body);
  if(url.includes('momo.vn'))return {ok:true,json:async()=>({partnerCode:payload.partnerCode,orderId:payload.orderId,requestId:payload.requestId,amount:payload.amount,resultCode:0,payUrl:'https://test-payment.momo.vn/v2/gateway/pay?t='+payload.orderId})};
  return {ok:true,json:async()=>({return_code:1,order_url:'https://sbgateway.zalopay.vn/openinapp?order='+payload.app_trans_id})};
}
async function req(route,{method='GET',body,key,admin=false,headers={}}={}) {
  const response=await fetch(base+'/api'+route,{method,redirect:'manual',headers:{...(body?{'Content-Type':'application/json'}:{}),...(admin?{Cookie:cookie}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const content=await response.text();let data;try{data=JSON.parse(content);}catch{data={};}
  return {status:response.status,data,location:response.headers.get('location'),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function trip() {
  const created=await req('/admin/trips',{method:'POST',admin:true,body:{operatorId,from:'ho-chi-minh',to:'da-lat',date:addDays(todayVietnam(),4),departureTime:'06:00',durationMinutes:360,price:250000,totalSeats:9,type:'limousine',pickupPoints:['Điểm đón kiểm thử'],dropoffPoints:['Điểm trả kiểm thử'],provenance:'Kho vé kiểm thử ví điện tử'}});assert.equal(created.status,201,JSON.stringify(created.data));return created.data.trip;
}
function customer(item,provider='momo',extra={}) {return {tripId:item.id,seats:['A01'],fullName:'Khách thử ví điện tử',email:'wallet@example.test',phone:'0901234567',pickup:item.pickupPoints[0],dropoff:item.dropoffPoints[0],paymentMethod:provider,...extra};}
async function callback(booking,extra={}) {
  const provider=booking.paymentMethod,attempt=await runtime.api.db.get('SELECT * FROM payment_attempts WHERE booking_code=?',[booking.code]);assert.ok(attempt);
  if(provider==='zalopay'){
    const data=JSON.stringify({app_id:Number(env.ZALOPAY_APP_ID),app_trans_id:attempt.merchant_order_id,amount:booking.total,zp_trans_id:'261008'+Math.floor(Math.random()*1000000000).toString().padStart(9,'0'),...extra});
    return {data,mac:hmac(env.ZALOPAY_KEY2,data),type:1};
  }
  const data={partnerCode:env.MOMO_PARTNER_CODE,orderId:attempt.merchant_order_id,requestId:attempt.request_id,amount:booking.total,orderInfo:'Thanh toan ve xe '+booking.code,orderType:'momo_wallet',transId:'261008'+Math.floor(Math.random()*1000000000).toString().padStart(9,'0'),resultCode:0,message:'Successful.',payType:'qr',responseTime:Date.now(),extraData:'',...extra};
  const input='accessKey='+env.MOMO_ACCESS_KEY+'&amount='+data.amount+'&extraData='+data.extraData+'&message='+data.message+'&orderId='+data.orderId+'&orderInfo='+data.orderInfo+'&orderType='+data.orderType+'&partnerCode='+data.partnerCode+'&payType='+data.payType+'&requestId='+data.requestId+'&responseTime='+data.responseTime+'&resultCode='+data.resultCode+'&transId='+data.transId;
  return {...data,signature:hmac(env.MOMO_SECRET_KEY,input)};
}
async function lookup(booking) {return (await req('/bookings/lookup?code='+booking.code+'&phone=0901234567')).data.booking;}
const crossOrigin={Origin:'https://provider.example','Sec-Fetch-Site':'cross-site'};
before(async()=>{
  runtime=await createApp({env,dataDir:directory,seedDemo:false,disableRateLimit:true,walletFetch:transport});
  server=await new Promise(resolve=>{const listening=runtime.app.listen(0,'127.0.0.1',()=>resolve(listening));});base='http://127.0.0.1:'+server.address().port;
  const login=await req('/auth/login',{method:'POST',body:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}});assert.equal(login.status,200);cookie=login.cookie;
  const op=await req('/admin/operators',{method:'POST',admin:true,body:{name:'Nhà xe ví điện tử '+suffix(),phone:'0901234567'}});assert.equal(op.status,201);operatorId=op.data.operator.id;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(runtime)await runtime.close();const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith('ticket4t-wallet-api-'));fs.rmSync(resolved,{recursive:true,force:true});});

for(const provider of ['momo','zalopay']){
  test(provider+' signed IPN settles once through the real origin boundary; browser return cannot settle',async()=>{
    const item=await trip(),created=await req('/bookings',{method:'POST',key:suffix(),body:customer(item,provider)});assert.equal(created.status,201,JSON.stringify(created.data));assert.ok(created.data.paymentUrl);const booking=created.data.booking;
    assert.equal(booking.status,'pending_payment');assert.ok(Date.parse(booking.expiresAt)>Date.now()+14*60000);
    const valid=await callback(booking),invalid={...valid,[provider==='momo'?'signature':'mac']:'0'.repeat(64)};
    const forged=await req('/payments/'+provider+'/ipn',{method:'POST',body:invalid,headers:crossOrigin});if(provider==='momo')assert.equal(forged.status,400);else assert.equal(forged.data.return_code,-1);
    const wrong=await req('/payments/'+provider+'/ipn',{method:'POST',body:await callback(booking,{amount:booking.total+1}),headers:crossOrigin});if(provider==='momo')assert.equal(wrong.status,400);else assert.equal(wrong.data.return_code,-1);
    assert.equal((await req('/payments/'+provider+'/return?code='+booking.code+'&resultCode=0')).status,302);assert.equal((await lookup(booking)).paymentStatus,'pending');
    const paid=await Promise.all(Array.from({length:6},()=>req('/payments/'+provider+'/ipn',{method:'POST',body:valid,headers:crossOrigin})));assert.ok(paid.every(r=>provider==='momo'?r.status===204:r.data.return_code===1));
    assert.equal((await lookup(booking)).paymentStatus,'paid');assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM payments WHERE booking_code=?',[booking.code])).n),1);
    assert.equal(Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM booking_events WHERE booking_code=? AND event=?',[booking.code,'payment_verified'])).n),1);
    assert.equal((await req('/bookings/'+booking.code+'/payment-link',{method:'POST',body:{phone:booking.phone}})).data.code,'PAYMENT_NOT_PAYABLE');
    assert.equal((await req('/bookings/'+booking.code+'/cancel',{method:'POST',body:{phone:booking.phone}})).data.booking.status,'refund_pending');
    const refunded=await req('/admin/bookings/'+booking.code+'/refund-receipt',{method:'POST',admin:true,body:{reference:'WALLET-REFUND-'+suffix(),amount:booking.total}});assert.equal(refunded.status,200);
    await req('/payments/'+provider+'/ipn',{method:'POST',body:valid,headers:crossOrigin});assert.equal((await lookup(booking)).paymentStatus,'refunded');
  });

  test(provider+' late payment queues a refund and preserves the next customer seat',async()=>{
    const item=await trip(),created=await req('/bookings',{method:'POST',body:customer(item,provider)}),booking=created.data.booking,valid=await callback(booking);
    await runtime.api.db.transaction(tx=>tx.run('UPDATE bookings SET expires_at=? WHERE code=?',[new Date(Date.now()-1000).toISOString(),booking.code]));
    const next=await req('/bookings',{method:'POST',body:customer(item,'cash')});assert.equal(next.status,201);
    const late=await req('/payments/'+provider+'/ipn',{method:'POST',body:valid,headers:crossOrigin});if(provider==='momo')assert.equal(late.status,204);else assert.equal(late.data.return_code,1);
    assert.equal((await lookup(booking)).paymentStatus,'refund_pending');
    assert.equal((await runtime.api.db.get('SELECT booking_code FROM reserved_seats WHERE trip_id=? AND seat=?',[item.id,'A01'])).booking_code,next.data.booking.code);
  });

  test(provider+' ambiguous create response returns the committed booking and retries never create a second charge order',async()=>{
    const item=await trip(),key=suffix(),body=customer(item,provider),beforeCalls=providerCalls;networkFailure=true;let created,replayed;
    try {created=await req('/bookings',{method:'POST',body,key});replayed=await req('/bookings',{method:'POST',body,key});}finally{networkFailure=false;}
    assert.equal(created.status,201);assert.equal(replayed.status,201);assert.equal(created.data.paymentError.code,'PAYMENT_RECONCILIATION_REQUIRED');assert.equal(replayed.data.booking.code,created.data.booking.code);assert.equal(providerCalls,beforeCalls+1);
    const booking=created.data.booking;assert.equal((await lookup(booking)).status,'pending_payment');
    const delayed=await req('/payments/'+provider+'/ipn',{method:'POST',body:await callback(booking),headers:crossOrigin});if(provider==='momo')assert.equal(delayed.status,204);else assert.equal(delayed.data.return_code,1);
    assert.equal((await lookup(booking)).paymentStatus,'paid');
  });
}

test('wallet origin exception is limited to exact signed callback paths',async()=>{
  const item=await trip();
  assert.equal((await req('/bookings',{method:'POST',body:customer(item),headers:crossOrigin})).status,403);
  assert.equal((await req('/payments/momo/ipn/extra',{method:'POST',body:{},headers:crossOrigin})).status,403);
  assert.equal((await req('/payments/zalopay/ipn/extra',{method:'POST',body:{},headers:crossOrigin})).status,403);
});

test('MoMo failed IPN releases its reservation; a later success goes to refund without reclaiming seats',async()=>{
  const item=await trip(),created=await req('/bookings',{method:'POST',body:customer(item,'momo')}),booking=created.data.booking;
  assert.equal((await req('/payments/momo/ipn',{method:'POST',body:await callback(booking,{resultCode:1006,transId:0}),headers:crossOrigin})).status,204);assert.equal((await lookup(booking)).status,'cancelled');
  const replacement=await req('/bookings',{method:'POST',body:customer(item,'cash')});assert.equal(replacement.status,201);
  const late=await req('/payments/momo/ipn',{method:'POST',body:await callback(booking),headers:crossOrigin});assert.equal(late.status,204);assert.equal((await lookup(booking)).paymentStatus,'refund_pending');
  assert.equal((await runtime.api.db.get('SELECT booking_code FROM reserved_seats WHERE trip_id=? AND seat=?',[item.id,'A01'])).booking_code,replacement.data.booking.code);
});

test('non-final MoMo notifications retain seats until the signed one-step success arrives',async()=>{
  const item=await trip(),created=await req('/bookings',{method:'POST',body:customer(item,'momo')}),booking=created.data.booking;
  for(const resultCode of [1000,7000,7002]){
    assert.equal((await req('/payments/momo/ipn',{method:'POST',body:await callback(booking,{resultCode,transId:0}),headers:crossOrigin})).status,204);
    assert.equal((await lookup(booking)).status,'pending_payment');
    assert.equal((await runtime.api.db.get('SELECT booking_code FROM reserved_seats WHERE trip_id=? AND seat=?',[item.id,'A01'])).booking_code,booking.code);
  }
  assert.equal((await req('/payments/momo/ipn',{method:'POST',body:await callback(booking,{resultCode:9000}),headers:crossOrigin})).status,204);
  assert.equal((await lookup(booking)).paymentStatus,'paid');
});

test('one provider transaction cannot settle two different bookings',async()=>{
  const item=await trip(),first=(await req('/bookings',{method:'POST',body:customer(item,'momo')})).data.booking,second=(await req('/bookings',{method:'POST',body:customer(item,'momo',{seats:['A02']})})).data.booking;
  const reference='261008'+Math.floor(Math.random()*1000000000).toString().padStart(9,'0');
  assert.equal((await req('/payments/momo/ipn',{method:'POST',body:await callback(first,{transId:reference}),headers:crossOrigin})).status,204);
  const conflicting=await req('/payments/momo/ipn',{method:'POST',body:await callback(second,{transId:reference}),headers:crossOrigin});assert.equal(conflicting.status,409);assert.equal((await lookup(second)).paymentStatus,'pending');
});
