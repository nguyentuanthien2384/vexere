(function(root,factory) {
  'use strict';
  const recovery=factory();
  if(typeof module==='object'&&module.exports)module.exports=recovery;
  else root.TicketCounterRecovery=recovery;
})(typeof globalThis==='object'?globalThis:this,function() {
  'use strict';
  const TTL=86400000,MAX_LENGTH=120000;
  const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
  const text=(value,max=160)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
  const stamp=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const pointName=value=>typeof value==='string'?value:value?.name||value?.address||'';
  const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T12:00:00Z`))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value;
  function freeze(value){if(object(value)||Array.isArray(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
  function actorSnapshot(actor) {
    if(!object(actor)||!text(actor.id)||!['admin','operator'].includes(actor.role)||(actor.operatorId!=null&&!text(actor.operatorId))||(actor.role==='operator'&&!text(actor.operatorId)))throw new Error('Tài khoản bán vé chưa hợp lệ.');
    return {id:actor.id,role:actor.role,operatorId:actor.operatorId??null};
  }
  function tripSnapshot(trip) {
    const validPoints=value=>Array.isArray(value)&&value.length>0&&value.length<=100&&value.every(point=>text(pointName(point),500));
    if(!object(trip)||!text(trip.id)||!text(trip.operatorId)||!text(trip.from)||!text(trip.to)||!text(trip.source)||!validDate(trip.date)||typeof trip.departureTime!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trip.departureTime)||!Number.isSafeInteger(trip.price)||trip.price<=0||!stamp(trip.bookingVersion)||!validPoints(trip.pickupPoints)||!validPoints(trip.dropoffPoints)||!Array.isArray(trip.seats)||!trip.seats.length||trip.seats.length>60||!trip.seats.every(seat=>object(seat)&&text(seat.label,32)&&Number.isSafeInteger(seat.price??trip.price)&&(seat.price??trip.price)>0&&['available','held','booked'].includes(seat.status))||new Set(trip.seats.map(seat=>seat.label)).size!==trip.seats.length)throw new Error('Thông tin chuyến hoặc sơ đồ ghế lưu chưa hợp lệ.');
    const snapshot={};
    for(const field of ['id','operatorId','from','to','source','date','departureTime','price','bookingVersion'])snapshot[field]=trip[field];
    for(const field of ['fromName','toName','operatorName','type','typeName'])if(text(trip[field],200))snapshot[field]=trip[field];
    snapshot.pickupPoints=trip.pickupPoints.map(pointName);snapshot.dropoffPoints=trip.dropoffPoints.map(pointName);
    snapshot.seats=trip.seats.map(seat=>({label:seat.label,price:seat.price??trip.price,status:seat.status,...(Number.isInteger(seat.deck)&&seat.deck>=1&&seat.deck<=10?{deck:seat.deck}:{})}));
    return snapshot;
  }
  function passengerSnapshot(passenger) {
    if(!object(passenger)||!text(passenger.fullName,100)||passenger.fullName.trim().length<2||passenger.fullName!==passenger.fullName.trim()||!text(passenger.phone,20)||!/^[0-9+ ]{9,20}$/.test(passenger.phone)||typeof passenger.email!=='string'||passenger.email.length>254||passenger.email!==passenger.email.trim()||(passenger.email!==''&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(passenger.email))||!text(passenger.pickup,500)||!text(passenger.dropoff,500))throw new Error('Thông tin hành khách lưu chưa hợp lệ.');
    const mobile=passenger.phone.replace(/[\s+]/g,'').replace(/^84/,'0');
    if(!/^0\d{9,10}$/.test(mobile))throw new Error('Số điện thoại lưu chưa hợp lệ.');
    return Object.fromEntries(['fullName','phone','email','pickup','dropoff'].map(field=>[field,passenger[field]]));
  }
  function create({actor,trip,seats,passenger,key,now=Date.now()}) {
    const owner=actorSnapshot(actor),snapshot=tripSnapshot(trip),contact=passengerSnapshot(passenger);
    if(!text(key,128)||!/^[A-Za-z0-9._:-]{16,128}$/.test(key)||!Number.isSafeInteger(now)||now<0||!Array.isArray(seats)||seats.length<1||seats.length>6||seats.some(label=>!text(label,32))||new Set(seats).size!==seats.length||owner.role==='operator'&&owner.operatorId!==snapshot.operatorId||!snapshot.pickupPoints.includes(contact.pickup)||!snapshot.dropoffPoints.includes(contact.dropoff)||seats.some(label=>!snapshot.seats.some(seat=>seat.label===label&&seat.status==='available')))throw new Error('Lựa chọn bán vé lưu chưa hợp lệ.');
    const expectedTotal=seats.reduce((total,label)=>total+snapshot.seats.find(seat=>seat.label===label).price,0);
    if(!Number.isSafeInteger(expectedTotal)||expectedTotal<1)throw new Error('Tổng tiền lưu chưa hợp lệ.');
    return freeze({schema:1,actor:owner,createdAt:now,path:'/admin/bookings',key,trip:snapshot,body:{...contact,tripId:snapshot.id,seats:[...seats],paymentMethod:'cash',expectedBookingVersion:snapshot.bookingVersion,expectedTotal}});
  }
  function read(raw,actor,now=Date.now()) {
    try {
      if(typeof raw!=='string'||raw.length>MAX_LENGTH||!Number.isSafeInteger(now))return null;
      const saved=JSON.parse(raw),owner=actorSnapshot(actor);
      if(!object(saved)||saved.schema!==1||!object(saved.actor)||['id','role','operatorId'].some(field=>saved.actor[field]!==owner[field])||!Number.isSafeInteger(saved.createdAt)||saved.createdAt>now||now-saved.createdAt>=TTL||!object(saved.body))return null;
      const restored=create({actor:owner,trip:saved.trip,seats:saved.body.seats,passenger:saved.body,key:saved.key,now:saved.createdAt});
      if(saved.path!==restored.path||Object.keys(saved).sort().join()!==Object.keys(restored).sort().join()||Object.keys(saved.actor).sort().join()!==Object.keys(restored.actor).sort().join()||Object.keys(saved.body).sort().join()!==Object.keys(restored.body).sort().join()||Object.keys(restored.body).some(field=>JSON.stringify(saved.body[field])!==JSON.stringify(restored.body[field])))return null;
      return restored;
    }catch{return null;}
  }
  function matches(attempt,{tripId,seats,passenger}) {
    try {return Boolean(attempt&&tripId===attempt.body.tripId&&JSON.stringify(seats)===JSON.stringify(attempt.body.seats)&&['fullName','phone','email','pickup','dropoff'].every(field=>passenger[field]===attempt.body[field]));}catch{return false;}
  }
  return Object.freeze({create,read,matches,TTL,MAX_LENGTH});
});
