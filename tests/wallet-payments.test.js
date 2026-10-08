'use strict';

const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openDatabase}=require('../server/database');
const {createWalletPayments,providerConfig}=require('../server/wallet-payments');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ticket4t-wallet-'));
const env={NODE_ENV:'test',APP_URL:'https://ticket4t.example',MOMO_PARTNER_CODE:'MOMOTEST',MOMO_ACCESS_KEY:'momo-access-test',MOMO_SECRET_KEY:'momo-secret-test',ZALOPAY_APP_ID:'2553',ZALOPAY_KEY1:'zalopay-key-one-test',ZALOPAY_KEY2:'zalopay-key-two-test'};
const mac=(key,input)=>crypto.createHmac('sha256',key).update(input).digest('hex');
const suffix=()=>crypto.randomBytes(10).toString('hex');
let db;
before(async()=>{
  db=await openDatabase({env:{NODE_ENV:'test'},dataDir:directory});
  await db.transaction(async tx=>{
    await tx.run('INSERT INTO locations(id,name,region,image) VALUES(?,?,?,?)',['one','One','south','']);await tx.run('INSERT INTO locations(id,name,region,image) VALUES(?,?,?,?)',['two','Two','south','']);
    await tx.run('INSERT INTO operators(id,name,data) VALUES(?,?,?)',['operator','Operator','{}']);
    await tx.run('INSERT INTO trips(id,operator_id,from_id,to_id,date,departure_time,departure_at,price,total_seats,type,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)',['trip','operator','one','two','2027-01-01','06:00','2026-12-31T23:00:00.000Z',250000,9,'limousine','{}']);
  });
});
after(async()=>{if(db)await db.close();const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith('ticket4t-wallet-'));fs.rmSync(resolved,{recursive:true,force:true});});
async function booking(provider,extra={}) {
  const item={code:'T4T'+suffix(),tripId:'trip',paymentMethod:provider,status:'pending_payment',paymentStatus:'pending',total:250000,source:'managed',expiresAt:new Date(Date.now()+15*60000).toISOString(),...extra};
  await db.transaction(tx=>tx.run('INSERT INTO bookings(code,trip_id,phone,email,status,payment_status,payment_method,total,expires_at,created_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[item.code,'trip','0901234567','test@example.test',item.status,item.paymentStatus,provider,item.total,item.expiresAt,new Date().toISOString(),JSON.stringify(item)]));
  return item;
}
function momoResponse(payload,extra={}) {return {ok:true,json:async()=>({partnerCode:payload.partnerCode,orderId:payload.orderId,requestId:payload.requestId,amount:payload.amount,resultCode:0,payUrl:'https://test-payment.momo.vn/v2/gateway/pay?t='+payload.orderId,...extra})};}
function notification(attempt,extra={}) {
  const data={partnerCode:env.MOMO_PARTNER_CODE,orderId:attempt.merchant_order_id,requestId:attempt.request_id,amount:attempt.amount,orderInfo:'Thanh toan ve xe '+attempt.booking_code,orderType:'momo_wallet',transId:'1234567890123',resultCode:0,message:'Successful.',payType:'qr',responseTime:Date.now(),extraData:'',...extra};
  const input='accessKey='+env.MOMO_ACCESS_KEY+'&amount='+data.amount+'&extraData='+data.extraData+'&message='+data.message+'&orderId='+data.orderId+'&orderInfo='+data.orderInfo+'&orderType='+data.orderType+'&partnerCode='+data.partnerCode+'&payType='+data.payType+'&requestId='+data.requestId+'&responseTime='+data.responseTime+'&resultCode='+data.resultCode+'&transId='+data.transId;
  return {...data,signature:mac(env.MOMO_SECRET_KEY,input)};
}

test('wallet configuration uses official endpoints and refuses incomplete, malformed and production sandbox settings',()=>{
  for(const provider of ['momo','zalopay']){
    assert.equal(providerConfig(provider,env).configured,true);assert.equal(providerConfig(provider,env).environment,'sandbox');
    assert.equal(providerConfig(provider,{...env,NODE_ENV:'production'}).configured,false);
    for(const url of ['http://localhost:3000/create','https://sb-openapi.zalopay.vn.evil.test/v2/create','https://test-payment.momo.vn/v2/gateway/api/create?extra=1'])assert.equal(providerConfig(provider,{...env,[provider.toUpperCase()+'_URL']:url}).configured,false);
  }
  assert.equal(providerConfig('momo',{...env,MOMO_SECRET_KEY:''}).configured,false);
  assert.equal(providerConfig('zalopay',{...env,ZALOPAY_APP_ID:'not-an-integer'}).configured,false);
  assert.equal(providerConfig('momo',{...env,NODE_ENV:'production',MOMO_URL:'https://payment.momo.vn/v2/gateway/api/create'}).configured,true);
});

test('MoMo creation signs the merchant request and durably reuses the same payment link after restart',async()=>{
  const item=await booking('momo');let calls=0,received;
  const fetchImpl=async(url,options)=>{
    calls++;assert.equal(url,'https://test-payment.momo.vn/v2/gateway/api/create');assert.equal(options.redirect,'error');received=JSON.parse(options.body);
    const text='accessKey='+env.MOMO_ACCESS_KEY+'&amount='+received.amount+'&extraData=&ipnUrl='+received.ipnUrl+'&orderId='+received.orderId+'&orderInfo='+received.orderInfo+'&partnerCode='+received.partnerCode+'&redirectUrl='+received.redirectUrl+'&requestId='+received.requestId+'&requestType=captureWallet';
    assert.equal(received.signature,mac(env.MOMO_SECRET_KEY,text));assert.equal(received.amount,item.total);assert.equal(received.autoCapture,true);assert.equal(received.ipnUrl,env.APP_URL+'/api/payments/momo/ipn');
    return momoResponse(received);
  };
  const wallets=createWalletPayments({db,env,fetchImpl}),url=await wallets.createPaymentLink(item,{});
  assert.ok(url.startsWith('https://test-payment.momo.vn/'));assert.equal(calls,1);
  const restarted=createWalletPayments({db,env,fetchImpl});assert.equal(await restarted.createPaymentLink(item,{}),url);assert.equal(calls,1);
  assert.equal((await db.get('SELECT payment_status FROM bookings WHERE code=?',[item.code])).payment_status,'pending','Create response cannot mark the booking paid');
  const attempt=await db.get('SELECT * FROM payment_attempts WHERE booking_code=?',[item.code]);assert.equal(attempt.merchant_order_id,received.orderId);assert.ok(!attempt.data.includes(env.MOMO_SECRET_KEY));
});

test('ZaloPay creation uses Vietnam transaction date, key1 MAC, booking deadline and trusted order URL',async()=>{
  const item=await booking('zalopay');let calls=0;
  const wallets=createWalletPayments({db,env,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://sb-openapi.zalopay.vn/v2/create');const payload=JSON.parse(options.body);
    const expectedDay=new Date(Date.now()+7*3600000).toISOString().slice(2,10).replaceAll('-','');assert.ok(payload.app_trans_id.startsWith(expectedDay+'_'));assert.ok(payload.app_trans_id.length<=40);
    assert.equal(payload.mac,mac(env.ZALOPAY_KEY1,[payload.app_id,payload.app_trans_id,payload.app_user,payload.amount,payload.app_time,payload.embed_data,payload.item].join('|')));
    assert.ok(payload.expire_duration_seconds>=300&&payload.expire_duration_seconds<=900);assert.deepEqual(JSON.parse(payload.embed_data).preferred_payment_method,['zalopay_wallet']);
    return {ok:true,json:async()=>({return_code:1,order_url:'https://sbgateway.zalopay.vn/openinapp?order='+payload.app_trans_id})};
  }});
  assert.ok(await wallets.createPaymentLink(item,{}));assert.equal(calls,1);await wallets.createPaymentLink(item,{});assert.equal(calls,1);
});

test('ambiguous provider failures remain durable and cannot submit a second remote order',async()=>{
  const item=await booking('momo');let calls=0;
  const wallets=createWalletPayments({db,env,fetchImpl:async()=>{calls++;throw new Error('ECONNRESET after provider may have accepted the order');}});
  await assert.rejects(()=>wallets.createPaymentLink(item,{}),e=>e.code==='PAYMENT_RECONCILIATION_REQUIRED');
  const attempt=await db.get('SELECT * FROM payment_attempts WHERE booking_code=?',[item.code]);assert.equal(attempt.status,'unknown');
  await assert.rejects(()=>wallets.createPaymentLink(item,{}),e=>e.code==='PAYMENT_RECONCILIATION_REQUIRED');assert.equal(calls,1);
  assert.ok(await wallets.verifyNotification('momo',notification(attempt)),'A delayed signed IPN can still reconcile an ambiguous create response');
});

test('concurrent wallet link requests serialize one remote order without holding the database transaction open',async()=>{
  const item=await booking('momo');let finish,entered,calls=0;const start=new Promise(resolve=>entered=resolve),release=new Promise(resolve=>finish=resolve);
  const wallets=createWalletPayments({db,env,fetchImpl:async(url,options)=>{calls++;entered();await release;return momoResponse(JSON.parse(options.body));}});
  const first=wallets.createPaymentLink(item,{});await start;
  await assert.rejects(()=>wallets.createPaymentLink(item,{}),e=>e.code==='PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM payment_attempts WHERE booking_code=?',[item.code])).n),1);
  finish();await first;assert.equal(calls,1);
});

test('wallet creation rejects demo-to-live requests and untrusted redirects without exposing provider responses',async()=>{
  const item=await booking('momo',{source:'demo'});let calls=0;
  const live=createWalletPayments({db,env:{...env,MOMO_URL:'https://payment.momo.vn/v2/gateway/api/create'},fetchImpl:async()=>{calls++;}});
  await assert.rejects(()=>live.createPaymentLink(item,{}),e=>e.code==='DEMO_PAYMENT_BLOCKED');assert.equal(calls,0);
  const managed=await booking('momo'),wallets=createWalletPayments({db,env,fetchImpl:async(url,options)=>momoResponse(JSON.parse(options.body),{payUrl:'https://evil.example/collect-card-details'})});
  await assert.rejects(()=>wallets.createPaymentLink(managed,{}),e=>e.code==='PAYMENT_PROVIDER_ERROR');assert.equal((await db.get('SELECT status FROM payment_attempts WHERE booking_code=?',[managed.code])).status,'unknown');
});

test('cached payment links refuse rotated merchant credentials and bound remote response size',async()=>{
  const item=await booking('momo');let calls=0;
  const transport=async(url,options)=>{calls++;return momoResponse(JSON.parse(options.body));};
  await createWalletPayments({db,env,fetchImpl:transport}).createPaymentLink(item,{});
  await assert.rejects(()=>createWalletPayments({db,env:{...env,MOMO_PARTNER_CODE:'ROTATED'},fetchImpl:transport}).createPaymentLink(item,{}),e=>e.code==='PAYMENT_RECONCILIATION_REQUIRED');assert.equal(calls,1);
  const second=await booking('momo'),oversized=createWalletPayments({db,env,fetchImpl:async()=>new Response('x'.repeat(70000),{headers:{'Content-Type':'application/json'}})});
  await assert.rejects(()=>oversized.createPaymentLink(second,{}),e=>e.code==='PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal((await db.get('SELECT status FROM payment_attempts WHERE booking_code=?',[second.code])).status,'unknown');
});

test('MoMo IPN verifies every signed field, amount and persisted request identity before settlement',async()=>{
  const item=await booking('momo'),wallets=createWalletPayments({db,env,fetchImpl:async(url,options)=>momoResponse(JSON.parse(options.body))});await wallets.createPaymentLink(item,{});
  const attempt=await db.get('SELECT * FROM payment_attempts WHERE booking_code=?',[item.code]),valid=notification(attempt),verified=await wallets.verifyNotification('momo',valid);
  assert.equal(verified.bookingCode,item.code);assert.equal(verified.reference,'momo:'+valid.transId);assert.equal(verified.amount,item.total);assert.equal(verified.success,true);
  assert.equal(await wallets.verifyNotification('momo',{...valid,amount:item.total+1}),null);
  assert.equal(await wallets.verifyNotification('momo',notification(attempt,{amount:item.total+1})),null);
  assert.equal(await wallets.verifyNotification('momo',notification(attempt,{requestId:'unknown-request'})),null);
  assert.equal(await wallets.verifyNotification('momo',notification(attempt,{orderId:'unknown-order'})),null);
  assert.equal(await wallets.verifyNotification('momo',notification(attempt,{partnerCode:'OTHER'})),null);
  assert.equal(await wallets.verifyNotification('momo',notification(attempt,{transId:'0'})),null);
  const failed=await wallets.verifyNotification('momo',notification(attempt,{resultCode:1006,transId:0}));assert.equal(failed.success,false);
  assert.equal(failed.pending,false);
  for(const resultCode of [1000,7000,7002])assert.equal((await wallets.verifyNotification('momo',notification(attempt,{resultCode,transId:0}))).pending,true);
  assert.equal((await wallets.verifyNotification('momo',notification(attempt,{resultCode:9000}))).success,true);
  assert.equal(await wallets.verifyNotification('momo',notification(attempt,{amount:'2.5e5'})),null);
  assert.equal(await wallets.verifyNotification('momo',notification(attempt,{resultCode:' '})),null);
});

test('ZaloPay IPN verifies raw data with key2 and requires order callbacks, merchant identity and exact amount',async()=>{
  const item=await booking('zalopay'),wallets=createWalletPayments({db,env,fetchImpl:async()=>({ok:true,json:async()=>({return_code:1,order_url:'https://sbgateway.zalopay.vn/openinapp?order=test'})})});await wallets.createPaymentLink(item,{});
  const attempt=await db.get('SELECT * FROM payment_attempts WHERE booking_code=?',[item.code]);
  const callback=extra=>{const data=JSON.stringify({app_id:Number(env.ZALOPAY_APP_ID),app_trans_id:attempt.merchant_order_id,amount:item.total,zp_trans_id:'261008000006575',...extra});return {data,mac:mac(env.ZALOPAY_KEY2,data),type:1};};
  const valid=callback(),verified=await wallets.verifyNotification('zalopay',valid);assert.equal(verified.bookingCode,item.code);assert.equal(verified.success,true);assert.equal(verified.reference,'zalopay:261008000006575');
  assert.equal(await wallets.verifyNotification('zalopay',{...valid,type:2}),null);
  assert.equal(await wallets.verifyNotification('zalopay',{...valid,mac:mac(env.ZALOPAY_KEY1,valid.data)}),null);
  assert.equal(await wallets.verifyNotification('zalopay',callback({amount:item.total+1})),null);
  assert.equal(await wallets.verifyNotification('zalopay',callback({app_id:9999})),null);
  assert.equal(await wallets.verifyNotification('zalopay',callback({zp_trans_id:9007199254740992})),null);
  const invalid='{bad json';assert.equal(await wallets.verifyNotification('zalopay',{data:invalid,mac:mac(env.ZALOPAY_KEY2,invalid)}),null);
});
