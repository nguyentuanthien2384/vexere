"use strict";

const crypto = require('node:crypto');

function canonical(params) {
  return Object.keys(params).sort().filter(k => k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType')
    .map(k => encodeURIComponent(k)+'='+encodeURIComponent(String(params[k])).replace(/%20/g,'+')).join('&');
}
function signature(params, secret) { return crypto.createHmac('sha512',secret).update(canonical(params),'utf8').digest('hex'); }
function configured(env) { return Boolean(env.VNPAY_TMN_CODE && env.VNPAY_HASH_SECRET && env.APP_URL); }
function vietnamTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type,x.value]));
  return p.year+p.month+p.day+p.hour+p.minute+p.second;
}
function paymentUrl(booking, req, env) {
  if (!configured(env)) return null;
  const ip = req.ip === '::1' ? '127.0.0.1' : (req.ip || '127.0.0.1').replace(/^::ffff:/,'');
  const params = {vnp_Version:'2.1.0',vnp_Command:'pay',vnp_TmnCode:env.VNPAY_TMN_CODE,vnp_Amount:String(booking.total*100),vnp_CurrCode:'VND',
    vnp_TxnRef:booking.code,vnp_OrderInfo:'Thanh toan ve xe '+booking.code,vnp_OrderType:'other',vnp_Locale:'vn',
    vnp_ReturnUrl:env.APP_URL.replace(/\/$/,'')+'/api/payments/vnpay/return',vnp_IpAddr:ip,
    vnp_CreateDate:vietnamTimestamp(new Date()),vnp_ExpireDate:vietnamTimestamp(new Date(booking.expiresAt))};
  const url = env.VNPAY_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
  return url+'?'+canonical(params)+'&vnp_SecureHash='+signature(params,env.VNPAY_HASH_SECRET);
}
function verifiedParams(query, env) {
  if (!configured(env)) return null;
  const params = {};
  for (const [key,value] of Object.entries(query)) {
    if (!key.startsWith('vnp_') || typeof value !== 'string') return null;
    params[key] = value;
  }
  const received = params.vnp_SecureHash;
  if (!received || !/^[a-f0-9]{128}$/i.test(received)) return null;
  const expected = signature(params,env.VNPAY_HASH_SECRET);
  if (!crypto.timingSafeEqual(Buffer.from(received,'hex'),Buffer.from(expected,'hex'))) return null;
  if (params.vnp_TmnCode !== env.VNPAY_TMN_CODE) return null;
  return params;
}

module.exports = {canonical,signature,configured,paymentUrl,verifiedParams,vietnamTimestamp};
