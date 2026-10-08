'use strict';

const crypto = require('node:crypto');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TRIPS = 500;
const DEFAULT_TIMEOUT_MS = 8000;
const TRIP_FIELDS = new Set(['externalId','id','operatorId','from','to','date','departureTime','type','price','totalSeats','durationMinutes','pickupPoints','dropoffPoints','amenities','policies','seatPrices','active','provenance']);

class OperatorFeedError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'OperatorFeedError';
    this.code = code;
    this.status = status;
  }
}

function present(value) { return typeof value === 'string' && value.trim().length > 0; }
function feedConfiguration(env) {
  const missingConfiguration = [];
  for (const key of ['OPERATOR_FEED_URL','OPERATOR_FEED_TOKEN','OPERATOR_FEED_OPERATOR_ID']) {
    if (!present(env[key])) missingConfiguration.push('Thiết lập '+key+' để nhập lịch từ API nhà xe đã ký kết.');
  }
  let url;
  if (present(env.OPERATOR_FEED_URL)) {
    try {
      url = new URL(env.OPERATOR_FEED_URL);
      const development = !env.NODE_ENV || ['development','test'].includes(env.NODE_ENV);
      const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
      if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:'))) throw new Error('invalid');
    } catch {
      missingConfiguration.push('OPERATOR_FEED_URL cần dùng HTTPS; HTTP chỉ dành cho máy cục bộ trong phát triển/kiểm thử. Không đặt thông tin đăng nhập trong URL.');
    }
  }
  if (present(env.OPERATOR_FEED_TOKEN) && /[\r\n\0]/.test(env.OPERATOR_FEED_TOKEN)) missingConfiguration.push('OPERATOR_FEED_TOKEN không được chứa ký tự điều khiển.');
  if (present(env.OPERATOR_FEED_OPERATOR_ID) && !/^[a-zA-Z0-9_-]{1,160}$/.test(env.OPERATOR_FEED_OPERATOR_ID)) missingConfiguration.push('OPERATOR_FEED_OPERATOR_ID cần là mã hồ sơ nhà xe hợp lệ trong hệ thống.');
  const timeoutMs = env.OPERATOR_FEED_TIMEOUT_MS === undefined || env.OPERATOR_FEED_TIMEOUT_MS === '' ? DEFAULT_TIMEOUT_MS : Number(env.OPERATOR_FEED_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) missingConfiguration.push('OPERATOR_FEED_TIMEOUT_MS cần là số nguyên từ 100 đến 30000 mili giây.');
  return {url, timeoutMs, missingConfiguration};
}

function getOperatorFeedStatus(env = process.env) {
  const {missingConfiguration} = feedConfiguration(env);
  return {
    configured:missingConfiguration.length === 0,
    mode:missingConfiguration.length ? 'unavailable' : 'operator_feed',
    externallyVerified:false,
    missingConfiguration,
    notes:[
      'Chỉ nhập lịch và giá đã chuẩn hóa; cần xem trước rồi áp dụng trong quản trị.',
      'Chưa đồng bộ giữ chỗ, ghế bán trên kênh khác hoặc đặt vé tại nhà xe. Chỉ mở bán kho ghế được phân bổ riêng cho hệ thống.',
      'Trạng thái cấu hình không xác nhận kết nối hay hợp đồng với nhà cung cấp.'
    ]
  };
}

function invalidFeed() { return new OperatorFeedError('OPERATOR_FEED_INVALID','API nhà xe cần trả JSON phiên bản 1 với nguồn xác nhận và tối đa 500 chuyến hợp lệ.'); }
function text(value, max = 200) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !isNaN(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
}
function normalizedFeed(body, operatorId) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.version !== 1 || !text(body.sourceReference,2000) || body.sourceReference.trim().length < 5 || !Array.isArray(body.trips) || body.trips.length > MAX_TRIPS || Object.keys(body).some(key => !['version','sourceReference','trips'].includes(key))) throw invalidFeed();
  const sourceReference = body.sourceReference.trim();
  const seen = new Set();
  const trips = body.trips.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidFeed();
    if (Object.keys(input).some(key => /^(seats|availability|seatMap|bookings|holds)$/i.test(key) || /(?:seat.*(?:avail|book|reserv|hold|held|occup|remaining)|(?:avail|book|reserv|hold|held|occup|remaining).*seat)/i.test(key))) {
      throw new OperatorFeedError('OPERATOR_FEED_UNSUPPORTED_INVENTORY','API nhập lịch không nhận số ghế đã bán, sơ đồ trạng thái ghế hoặc dữ liệu giữ chỗ bên ngoài. Cần cấp kho ghế riêng trước khi mở bán.');
    }
    if (Object.keys(input).some(key => !TRIP_FIELDS.has(key)) || !text(input.externalId,160) || !text(input.from) || !text(input.to) || input.from.trim() === input.to.trim() || !validDate(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.departureTime || '') || !['limousine','sleeper','cabin','seater'].includes(input.type) || !integer(input.price,10000,10000000) || !integer(input.totalSeats,1,60) || !integer(input.durationMinutes,30,2880) || (input.active !== undefined && typeof input.active !== 'boolean')) throw invalidFeed();
    const externalId = input.externalId.trim();
    if (seen.has(externalId)) throw new OperatorFeedError('OPERATOR_FEED_DUPLICATE','Nguồn API có mã chuyến trùng nhau; nhà xe cần cấp externalId duy nhất cho từng chuyến.');
    seen.add(externalId);
    const trip = {externalId,id:'feed-'+crypto.createHash('sha256').update(JSON.stringify([operatorId,externalId])).digest('hex'),operatorId,
      from:input.from.trim(),to:input.to.trim(),date:input.date,departureTime:input.departureTime,type:input.type,price:input.price,totalSeats:input.totalSeats,durationMinutes:input.durationMinutes};
    for (const key of ['pickupPoints','dropoffPoints','amenities','policies']) {
      const values = input[key];
      if (values === undefined && !['pickupPoints','dropoffPoints'].includes(key)) continue;
      if (!Array.isArray(values) || values.length > 20 || values.some(value => !text(value,500)) || (['pickupPoints','dropoffPoints'].includes(key) && !values.length)) throw invalidFeed();
      trip[key] = values.map(value => value.trim());
    }
    if (input.seatPrices !== undefined) {
      if (!input.seatPrices || typeof input.seatPrices !== 'object' || Array.isArray(input.seatPrices) || Object.entries(input.seatPrices).some(([key,value]) => !/^[A-Z][0-9]{2}$/.test(key) || !integer(value,input.price,10000000))) throw invalidFeed();
      trip.seatPrices = Object.fromEntries(Object.entries(input.seatPrices).sort(([a],[b]) => a.localeCompare(b)));
    }
    trip.active = input.active === undefined ? true : input.active;
    trip.provenance = sourceReference;
    return trip;
  }).sort((a,b) => a.id.localeCompare(b.id));
  const digest = crypto.createHash('sha256').update(JSON.stringify({operatorId,sourceReference,trips})).digest('hex');
  return {trips,sourceReference,digest,operatorId};
}

async function readBoundedResponse(response, controller) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    controller.abort();
    throw new OperatorFeedError('OPERATOR_FEED_TOO_LARGE','Phản hồi API nhà xe vượt giới hạn 1 MB. Hãy chia nhỏ nguồn lịch.');
  }
  if (!response.body) throw invalidFeed();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new OperatorFeedError('OPERATOR_FEED_TOO_LARGE','Phản hồi API nhà xe vượt giới hạn 1 MB. Hãy chia nhỏ nguồn lịch.');
      }
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes));
  } finally {
    if (controller.signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function fetchOperatorFeed(env = process.env) {
  const configuration = feedConfiguration(env);
  if (configuration.missingConfiguration.length) throw new OperatorFeedError('OPERATOR_FEED_NOT_CONFIGURED','API nhà xe chưa được cấu hình hợp lệ. Kiểm tra mục Tích hợp trong quản trị.',503);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),configuration.timeoutMs);
  try {
    const response = await fetch(configuration.url,{method:'GET',headers:{Accept:'application/json',Authorization:'Bearer '+env.OPERATOR_FEED_TOKEN},redirect:'error',signal:controller.signal});
    if (!response.ok) {
      controller.abort();
      throw new OperatorFeedError('OPERATOR_FEED_UPSTREAM','API nhà xe không trả kết quả thành công. Kiểm tra quyền truy cập và thử lại.');
    }
    const contentType = response.headers.get('content-type') || '';
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(contentType)) {
      controller.abort();
      throw invalidFeed();
    }
    let body;
    const raw = await readBoundedResponse(response,controller);
    try { body = JSON.parse(raw); } catch { throw invalidFeed(); }
    return normalizedFeed(body,env.OPERATOR_FEED_OPERATOR_ID);
  } catch (error) {
    if (error instanceof OperatorFeedError) throw error;
    if (controller.signal.aborted) throw new OperatorFeedError('OPERATOR_FEED_TIMEOUT','API nhà xe phản hồi quá thời gian cho phép. Thử lại hoặc kiểm tra nguồn lịch.');
    throw new OperatorFeedError('OPERATOR_FEED_UPSTREAM','Không thể đọc API nhà xe. Kiểm tra kết nối và cấu hình nguồn lịch.');
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {fetchOperatorFeed,getOperatorFeedStatus};
