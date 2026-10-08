'use strict';

const crypto=require('node:crypto');

const fields=['id','operatorId','from','to','date','departureTime','durationMinutes','type','totalSeats','price','pickupPoints','dropoffPoints','source'];

function bookingTermsVersion(trip) {
  const terms=Object.fromEntries(fields.map(field=>[field,trip[field]]));
  terms.seatPrices=Object.fromEntries(Object.entries(trip.seatPrices ?? {}).sort(([a],[b])=>a<b ? -1 : a>b ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(terms)).digest('hex');
}
function validationError(fail,message) {
  if (fail) fail(400,message);
  const error=new Error(message);error.status=400;throw error;
}
function validateBookingVersion(value,fail) {
  if (value !== undefined && (typeof value !== 'string' || value.length!==64 || !/^[a-f0-9]{64}$/.test(value))) validationError(fail,'Phiên bản thông tin chuyến xe không hợp lệ.');
  return value;
}
function validateExpectedTotal(value,fail) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value<0)) validationError(fail,'Tổng tiền xác nhận phải là số nguyên không âm.');
  return value;
}

module.exports={bookingTermsVersion,validateBookingVersion,validateExpectedTotal};
