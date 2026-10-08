'use strict';

const crypto=require('node:crypto');
const ENDPOINTS={
  momo:{sandbox:'https://test-payment.momo.vn/v2/gateway/api/create',live:'https://payment.momo.vn/v2/gateway/api/create'},
  zalopay:{sandbox:'https://sb-openapi.zalopay.vn/v2/create',live:'https://openapi.zalopay.vn/v2/create'},
};
const CREDENTIALS={momo:['MOMO_PARTNER_CODE','MOMO_ACCESS_KEY','MOMO_SECRET_KEY'],zalopay:['ZALOPAY_APP_ID','ZALOPAY_KEY1','ZALOPAY_KEY2']};
const hmac=(secret,data)=>crypto.createHmac('sha256',secret).update(data,'utf8').digest('hex');
const scalar=value=>typeof value==='string' || (typeof value==='number' && Number.isSafeInteger(value));
const decimal=value=>scalar(value) && /^\d+$/.test(String(value));
function equalHash(actual,expected) {return typeof actual==='string' && /^[a-f0-9]{64}$/i.test(actual) && crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}
function providerConfig(provider,env) {
  if (!ENDPOINTS[provider]) return {provider,configured:false,environment:'invalid',endpoint:null,missing:[],validEndpoint:false};
  const endpoint=env[provider.toUpperCase()+'_URL'] || ENDPOINTS[provider].sandbox;
  const environment=Object.keys(ENDPOINTS[provider]).find(kind=>ENDPOINTS[provider][kind]===endpoint) || 'invalid';
  const missing=CREDENTIALS[provider].filter(key=>!String(env[key] || '').trim());
  let validAppUrl=false;
  try {const url=new URL(env.APP_URL);validAppUrl=['https:','http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && (env.NODE_ENV!=='production' || url.protocol==='https:');}catch{}
  if (!validAppUrl) missing.push('APP_URL');
  if (provider==='zalopay' && !/^[1-9]\d{0,9}$/.test(String(env.ZALOPAY_APP_ID || ''))) {if(!missing.includes('ZALOPAY_APP_ID'))missing.push('ZALOPAY_APP_ID');}
  const validEndpoint=environment!=='invalid';
  return {provider,configured:!missing.length && validEndpoint && (env.NODE_ENV!=='production' || environment==='live'),environment,endpoint,missing,validEndpoint};
}
function momoCreateSignature(body,env) {
  return hmac(env.MOMO_SECRET_KEY,['accessKey='+env.MOMO_ACCESS_KEY,...['amount','extraData','ipnUrl','orderId','orderInfo','partnerCode','redirectUrl','requestId','requestType'].map(key=>key+'='+body[key])].join('&'));
}
function momoNotificationSignature(body,env) {
  return hmac(env.MOMO_SECRET_KEY,['accessKey='+env.MOMO_ACCESS_KEY,...['amount','extraData','message','orderId','orderInfo','orderType','partnerCode','payType','requestId','responseTime','resultCode','transId'].map(key=>key+'='+body[key])].join('&'));
}
function zalopayCreateSignature(body,env) {return hmac(env.ZALOPAY_KEY1,['app_id','app_trans_id','app_user','amount','app_time','embed_data','item'].map(key=>body[key]).join('|'));}
function vietnamDay() {return new Date(Date.now()+7*3600000).toISOString().slice(2,10).replaceAll('-','');}
function payable(booking) {return booking && ['momo','zalopay'].includes(booking.paymentMethod) && booking.status==='pending_payment' && booking.paymentStatus==='pending' && Date.parse(booking.expiresAt)>Date.now();}
function trustedPayUrl(provider,value,environment) {
  try {
    const url=new URL(value),hosts=provider==='momo' ? (environment==='sandbox' ? ['test-payment.momo.vn'] : ['payment.momo.vn']) : (environment==='sandbox' ? ['sbgateway.zalopay.vn','qcgateway.zalopay.vn'] : ['gateway.zalopay.vn']);
    return url.protocol==='https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname);
  } catch {return false;}
}
async function boundedJson(response) {
  const maximum=65536,length=Number(response.headers?.get('content-length'));
  if (length>maximum) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  if (response.body?.getReader) {
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try {
      for (;;) {const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maximum){await reader.cancel();throw new Error('PROVIDER_RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(value));}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {reader.releaseLock();}
  }
  // Test transports may expose only json(); production fetch streams above.
  const data=await response.json();
  if (Buffer.byteLength(JSON.stringify(data),'utf8')>maximum) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  return data;
}

function createWalletPayments({db,env,fetchImpl=global.fetch,fail=(status,message,code)=>{const error=new Error(message);Object.assign(error,{status,code});throw error;},timeoutMs=30000}) {
  const lock=db.dialect==='postgres' ? ' FOR UPDATE' : '';
  const configured=provider=>providerConfig(provider,env).configured;
  const acceptsSource=(provider,booking)=>!(booking.source==='demo' || booking.isDemo) || providerConfig(provider,env).environment==='sandbox';
  async function createPaymentLink(booking,req) {
    const provider=booking.paymentMethod,config=providerConfig(provider,env);
    if (!config.configured) fail(503,'Cổng thanh toán chưa được cấu hình hợp lệ.','PAYMENT_UNAVAILABLE');
    if (!acceptsSource(provider,booking)) fail(409,'Đặt chỗ minh họa không được chuyển sang cổng thu tiền thật.','DEMO_PAYMENT_BLOCKED');
    if (!payable(booking)) fail(409,'Đặt chỗ không còn chờ thanh toán trực tuyến.','PAYMENT_NOT_PAYABLE');
    const configHash=crypto.createHash('sha256').update(JSON.stringify([config.endpoint,env.APP_URL,...CREDENTIALS[provider].map(key=>env[key])])).digest('hex');
    const claim=await db.transaction(async tx=>{
      const current=await tx.get('SELECT status,payment_status,expires_at,payment_method,total FROM bookings WHERE code=?'+lock,[booking.code]);
      if (!current || current.status!=='pending_payment' || current.payment_status!=='pending' || current.payment_method!==provider || current.total!==booking.total || Date.parse(current.expires_at)<=Date.now()) fail(409,'Đặt chỗ không còn chờ thanh toán trực tuyến.','PAYMENT_NOT_PAYABLE');
      const existing=await tx.get('SELECT * FROM payment_attempts WHERE booking_code=? AND provider=?',[booking.code,provider]);
      if (existing) return {attempt:existing,created:false};
      const createdAt=new Date().toISOString(),id=crypto.randomBytes(12).toString('hex');
      const attempt={booking_code:booking.code,provider,merchant_order_id:provider==='zalopay' ? vietnamDay()+'_'+id : 'T4M'+id,request_id:crypto.randomUUID(),amount:booking.total,status:'requesting',created_at:createdAt,updated_at:createdAt,data:JSON.stringify({environment:config.environment,configHash})};
      await tx.run('INSERT INTO payment_attempts(booking_code,provider,merchant_order_id,request_id,amount,status,payment_url,created_at,updated_at,data) VALUES(?,?,?,?,?,?,NULL,?,?,?)',[booking.code,provider,attempt.merchant_order_id,attempt.request_id,attempt.amount,attempt.status,createdAt,createdAt,attempt.data]);
      return {attempt,created:true};
    });
    const attempt=claim.attempt;
    if (!claim.created) {
      const previousConfig=JSON.parse(attempt.data);
      if (previousConfig.environment!==config.environment || previousConfig.configHash!==configHash) fail(409,'Cấu hình thanh toán đã đổi. Cần đối soát yêu cầu cũ trước khi thanh toán.','PAYMENT_RECONCILIATION_REQUIRED');
      if (attempt.status==='ready' && trustedPayUrl(provider,attempt.payment_url,config.environment)) return attempt.payment_url;
      fail(503,'Yêu cầu thanh toán đang chờ đối soát với cổng. Vui lòng tra cứu lại đặt chỗ; hệ thống sẽ không tạo đơn thu tiền thứ hai.','PAYMENT_RECONCILIATION_REQUIRED');
    }
    const appUrl=env.APP_URL.replace(/\/$/,''),redirect=appUrl+'/api/payments/'+provider+'/return?code='+encodeURIComponent(booking.code);
    let payload;
    if (provider==='momo') {
      if (booking.total<1000 || booking.total>50000000) {await saveAttempt('failed',{reason:'unsupported_amount'});fail(400,'MoMo hỗ trợ số tiền từ 1.000 đến 50.000.000 VND.','PAYMENT_AMOUNT_UNSUPPORTED');}
      payload={partnerCode:env.MOMO_PARTNER_CODE,requestId:attempt.request_id,orderId:attempt.merchant_order_id,amount:booking.total,orderInfo:'Thanh toan ve xe '+booking.code,redirectUrl:redirect,ipnUrl:appUrl+'/api/payments/momo/ipn',requestType:'captureWallet',extraData:'',autoCapture:true,lang:'vi'};
      payload.signature=momoCreateSignature(payload,env);
    } else {
      const seconds=Math.floor((Date.parse(booking.expiresAt)-Date.now())/1000);
      if (seconds<300) {await saveAttempt('failed',{reason:'insufficient_payment_time'});fail(409,'ZaloPay cần ít nhất năm phút còn lại để tạo thanh toán.','PAYMENT_NOT_PAYABLE');}
      payload={app_id:Number(env.ZALOPAY_APP_ID),app_trans_id:attempt.merchant_order_id,app_user:'ticket4t',app_time:Date.now(),expire_duration_seconds:seconds,amount:booking.total,description:'Thanh toan ve xe '+booking.code,callback_url:appUrl+'/api/payments/zalopay/ipn',item:'[]',embed_data:JSON.stringify({redirecturl:redirect,preferred_payment_method:['zalopay_wallet']}),bank_code:''};
      payload.mac=zalopayCreateSignature(payload,env);
    }
    async function saveAttempt(status,data,paymentUrl=null) {
      await db.transaction(tx=>tx.run('UPDATE payment_attempts SET status=?,payment_url=?,updated_at=?,data=? WHERE booking_code=? AND provider=?',[status,paymentUrl,new Date().toISOString(),JSON.stringify({environment:config.environment,configHash,...data}),booking.code,provider]));
    }
    let response,providerData;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1000,Math.min(60000,timeoutMs)));
    try {
      response=await fetchImpl(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload),signal:controller.signal,redirect:'error'});
      providerData=await boundedJson(response);
      if (!response.ok || !providerData || typeof providerData!=='object' || Array.isArray(providerData)) throw new Error('INVALID_PROVIDER_RESPONSE');
    } catch {
      await saveAttempt('unknown',{reason:'network_or_response_error'});
      fail(503,'Chưa nhận được kết quả từ cổng thanh toán. Vui lòng tra cứu lại đặt chỗ để đối soát, không tạo thanh toán mới.','PAYMENT_RECONCILIATION_REQUIRED');
    } finally {clearTimeout(timer);}
    const success=provider==='momo' ? providerData.resultCode===0 : providerData.return_code===1;
    const paymentUrl=provider==='momo' ? providerData.payUrl : providerData.order_url;
    if (!success) {
      await saveAttempt('unknown',{reason:'provider_did_not_confirm_creation',providerCode:provider==='momo' ? providerData.resultCode : providerData.return_code});
      fail(503,'Cổng chưa xác nhận khởi tạo thanh toán. Cần đối soát yêu cầu đã gửi.','PAYMENT_RECONCILIATION_REQUIRED');
    }
    if (provider==='momo' && (providerData.orderId!==attempt.merchant_order_id || providerData.requestId!==attempt.request_id || Number(providerData.amount)!==booking.total || providerData.partnerCode!==env.MOMO_PARTNER_CODE)) {
      await saveAttempt('unknown',{reason:'provider_response_mismatch'});fail(502,'Thông tin cổng thanh toán trả về không khớp yêu cầu.','PAYMENT_PROVIDER_ERROR');
    }
    if (!trustedPayUrl(provider,paymentUrl,config.environment)) {
      await saveAttempt('unknown',{reason:'untrusted_payment_url'});fail(502,'Cổng thanh toán trả về địa chỉ không hợp lệ.','PAYMENT_PROVIDER_ERROR');
    }
    await saveAttempt('ready',{},paymentUrl);
    const current=await db.get('SELECT status,payment_status,expires_at FROM bookings WHERE code=?',[booking.code]);
    if (current.status!=='pending_payment' || current.payment_status!=='pending' || Date.parse(current.expires_at)<=Date.now()) fail(409,'Đặt chỗ đã thay đổi trong lúc tạo thanh toán. Vui lòng tra cứu lại.','PAYMENT_NOT_PAYABLE');
    return paymentUrl;
  }
  async function verifyNotification(provider,body) {
    if (!configured(provider) || !body || typeof body!=='object' || Array.isArray(body)) return null;
    let data,merchantOrderId,reference,amount,success,pending=false;
    if (provider==='momo') {
      const strings=['partnerCode','orderId','requestId','orderInfo','orderType','message','payType','extraData'];
      if (strings.some(key=>typeof body[key]!=='string') || ['amount','transId','responseTime','resultCode'].some(key=>!decimal(body[key])) || !/^\d{1,6}$/.test(String(body.resultCode)) || body.partnerCode!==env.MOMO_PARTNER_CODE || !equalHash(body.signature,momoNotificationSignature(body,env))) return null;
      data=body;merchantOrderId=body.orderId;reference=String(body.transId);amount=Number(body.amount);
      // This adapter always requests one-step auto-capture. MoMo documents 9000
      // as success for that flow; processing statuses must not release seats.
      const resultCode=Number(body.resultCode);
      success=[0,9000].includes(resultCode);
      const finalFailures=[98,99,1001,1002,1003,1004,1005,1006,1007,1017,1026,2019,4001,4002,4100];
      pending=!success && !finalFailures.includes(resultCode);
    } else if (provider==='zalopay') {
      if (typeof body.data!=='string' || body.data.length>65536 || (body.type!==undefined && Number(body.type)!==1) || !equalHash(body.mac,hmac(env.ZALOPAY_KEY2,body.data))) return null;
      try {data=JSON.parse(body.data);}catch{return null;}
      if (!data || typeof data!=='object' || Array.isArray(data) || !decimal(data.amount) || !decimal(data.zp_trans_id) || String(data.app_id)!==String(env.ZALOPAY_APP_ID)) return null;
      merchantOrderId=data.app_trans_id;reference=String(data.zp_trans_id);amount=Number(data.amount);success=true;
    } else return null;
    if (typeof merchantOrderId!=='string' || merchantOrderId.length>64 || !Number.isSafeInteger(amount) || amount<=0 || (success && !/^[1-9]\d{0,30}$/.test(reference))) return null;
    const attempt=await db.get('SELECT booking_code,request_id,amount FROM payment_attempts WHERE merchant_order_id=? AND provider=?',[merchantOrderId,provider]);
    if (!attempt || amount!==attempt.amount || (provider==='momo' && data.requestId!==attempt.request_id)) return null;
    return {bookingCode:attempt.booking_code,provider,reference:provider+':'+reference,amount,success,pending,raw:body};
  }
  return {configured,acceptsSource,createPaymentLink,verifyNotification,providerConfig:provider=>providerConfig(provider,env)};
}

module.exports={createWalletPayments,providerConfig,momoCreateSignature,momoNotificationSignature,zalopayCreateSignature};
