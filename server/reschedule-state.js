'use strict';

const crypto=require('node:crypto');
const {bookingTermsVersion}=require('./booking-terms');

function rescheduleVersion(booking) {
  const fields=['code','tripId','userId','fullName','phone','email','status','paymentStatus','paymentMethod','total','pickup','dropoff','createdAt','expiresAt','orderCode','couponCode','source'];
  const state=Object.fromEntries(fields.map(field=>[field,booking[field] ?? null]));
  state.subtotal=booking.subtotal ?? booking.total;
  state.discount=booking.discount ?? 0;
  state.seats=[...(booking.seats || [])];
  state.tripVersion=bookingTermsVersion(booking.trip || {});
  state.revision=booking.previousTrips?.length || 0;
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function validateSourceVersion(value,fail) {
  if (value !== undefined && (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value))) {
    if (fail) fail(400,'Phiên bản đặt chỗ cần đổi không hợp lệ.');
    const error=new Error('Phiên bản đặt chỗ cần đổi không hợp lệ.');error.status=400;throw error;
  }
  return value;
}

module.exports={rescheduleVersion,validateSourceVersion};
