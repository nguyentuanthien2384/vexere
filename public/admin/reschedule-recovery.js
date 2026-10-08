(function(root,factory) {
  'use strict';
  const recovery=factory();
  if(typeof module==='object'&&module.exports)module.exports=recovery;
  else root.TicketAdminRescheduleRecovery=recovery;
})(typeof globalThis==='object'?globalThis:this,function() {
  'use strict';
  const TTL=86400000,MAX_BYTES=120000;
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const text=(value,max=160)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
  const stamp=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const seats=value=>Array.isArray(value)&&value.length>0&&value.length<=6&&value.every(label=>text(label,32))&&new Set(value).size===value.length;
  const points=value=>Array.isArray(value)&&value.length>0&&value.length<=100&&value.every(point=>text(point,500));
  const clone=value=>JSON.parse(JSON.stringify(value));
  const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T12:00:00Z`))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value;
  function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
  function tripSnapshot(trip) {
    if(!object(trip)||!text(trip.id)||!text(trip.operatorId)||!text(trip.from)||!text(trip.to)||!text(trip.source)||!validDate(trip.date)||!text(trip.departureTime,5)||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trip.departureTime)||!Number.isSafeInteger(trip.price)||trip.price<=0||!points(trip.pickupPoints)||!points(trip.dropoffPoints))throw new Error('Thông tin chuyến lưu chưa hợp lệ.');
    const snapshot={};
    for(const field of ['id','operatorId','from','to','source','date','departureTime','price','pickupPoints','dropoffPoints'])snapshot[field]=clone(trip[field]);
    for(const field of ['fromName','toName','operatorName','typeName'])if(text(trip[field],200))snapshot[field]=trip[field];
    return snapshot;
  }
  function bookingSnapshot(booking) {
    if(!object(booking)||!text(booking.code,30)||!/^[A-Za-z0-9_-]+$/.test(booking.code)||!text(booking.tripId)||!seats(booking.seats)||!stamp(booking.rescheduleVersion)||!text(booking.fullName,200)||!text(booking.status,40)||!text(booking.paymentStatus,40)||!Number.isSafeInteger(booking.total)||booking.total<0||!Number.isSafeInteger(booking.subtotal??booking.total)||(booking.subtotal??booking.total)<0||!text(booking.pickup,500)||!text(booking.dropoff,500))throw new Error('Thông tin vé lưu chưa hợp lệ.');
    if(booking.expiresAt!=null&&(typeof booking.expiresAt!=='string'||booking.expiresAt.length>40||!Number.isFinite(Date.parse(booking.expiresAt))))throw new Error('Thời hạn vé lưu chưa hợp lệ.');
    const trip=tripSnapshot(booking.trip);
    if(trip.id!==booking.tripId)throw new Error('Vé lưu không khớp chuyến gốc.');
    return {code:booking.code,tripId:booking.tripId,seats:[...booking.seats],fullName:booking.fullName,status:booking.status,paymentStatus:booking.paymentStatus,total:booking.total,subtotal:booking.subtotal??booking.total,pickup:booking.pickup,dropoff:booking.dropoff,expiresAt:booking.expiresAt??null,rescheduleVersion:booking.rescheduleVersion,trip};
  }
  function targetSnapshot(target) {
    const snapshot=tripSnapshot(target);
    if(!stamp(target.bookingVersion)||!Array.isArray(target.seats)||target.seats.length>60||!target.seats.length||!target.seats.every(seat=>object(seat)&&text(seat.label,32)&&Number.isSafeInteger(seat.price??target.price)&&(seat.price??target.price)>0&&text(seat.status,30))||new Set(target.seats.map(seat=>seat.label)).size!==target.seats.length)throw new Error('Sơ đồ ghế lưu chưa hợp lệ.');
    snapshot.bookingVersion=target.bookingVersion;snapshot.seats=target.seats.map(seat=>({label:seat.label,price:seat.price??target.price,status:seat.status}));
    return snapshot;
  }
  function create({ownerId,ownerRole,ownerOperatorId=null,booking,target,seats:selected,pickup,dropoff,key,now=Date.now()}) {
    if(!text(ownerId,160)||!['admin','operator'].includes(ownerRole)||(ownerRole==='operator'&&!text(ownerOperatorId))||(ownerOperatorId!==null&&!text(ownerOperatorId))||!text(key,128)||!/^[A-Za-z0-9._:-]{16,128}$/.test(key)||!Number.isSafeInteger(now)||now<0||!seats(selected)||!text(pickup,500)||!text(dropoff,500))throw new Error('Yêu cầu đổi chuyến chưa hợp lệ.');
    const source=bookingSnapshot(booking),destination=targetSnapshot(target);
    if(source.tripId===destination.id||selected.length!==source.seats.length||['operatorId','from','to','source'].some(field=>source.trip[field]!==destination[field])||!destination.pickupPoints.includes(pickup)||!destination.dropoffPoints.includes(dropoff)||selected.some(label=>!destination.seats.some(seat=>seat.label===label)))throw new Error('Lựa chọn đổi chuyến không khớp vé gốc và chuyến mới.');
    if(selected.reduce((total,label)=>total+destination.seats.find(seat=>seat.label===label).price,0)!==source.subtotal)throw new Error('Giá trị ghế mới không bằng giá trị vé gốc.');
    return freeze({schema:1,ownerId,ownerRole,ownerOperatorId,createdAt:now,path:`/admin/bookings/${encodeURIComponent(source.code)}/reschedule`,key,body:{tripId:destination.id,seats:[...selected],pickup,dropoff,expectedSourceVersion:source.rescheduleVersion,expectedBookingVersion:destination.bookingVersion},booking:source,target:destination});
  }
  function read(raw,owner,now=Date.now()) {
    try {
      if(typeof raw!=='string'||raw.length>MAX_BYTES||!Number.isSafeInteger(now))return null;
      const saved=JSON.parse(raw);
      if(!object(owner)||!object(saved)||saved.schema!==1||saved.ownerId!==owner.id||saved.ownerRole!==owner.role||saved.ownerOperatorId!==(owner.operatorId??null)||!Number.isSafeInteger(saved.createdAt)||saved.createdAt>now||now-saved.createdAt>=TTL||!object(saved.body))return null;
      const restored=create({ownerId:owner.id,ownerRole:owner.role,ownerOperatorId:owner.operatorId??null,booking:saved.booking,target:saved.target,seats:saved.body.seats,pickup:saved.body.pickup,dropoff:saved.body.dropoff,key:saved.key,now:saved.createdAt});
      if(saved.path!==restored.path||Object.keys(saved).sort().join()!==Object.keys(restored).sort().join()||Object.keys(saved.body).sort().join()!==Object.keys(restored.body).sort().join()||Object.keys(restored.body).some(field=>JSON.stringify(saved.body[field])!==JSON.stringify(restored.body[field])))return null;
      return restored;
    }catch{return null;}
  }
  function matches(attempt,{code,tripId,seats:selected,pickup,dropoff}) {
    return Boolean(attempt&&attempt.booking.code===code&&attempt.body.tripId===tripId&&JSON.stringify(attempt.body.seats)===JSON.stringify(selected)&&attempt.body.pickup===pickup&&attempt.body.dropoff===dropoff);
  }
  return Object.freeze({create,read,matches,TTL,MAX_BYTES});
});
