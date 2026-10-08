"use strict";

const crypto=require('node:crypto');
const {makeSeats}=require('./catalog');
const {checkoutIdempotency}=require('./checkout-idempotency');
const {bookingTermsVersion,validateBookingVersion,validateExpectedTotal}=require('./booking-terms');
const {validateSourceVersion}=require('./reschedule-state');
const BOOKING_LEAD_MINUTES=30;

function createBookingFeatures(ctx) {
  const {db,env,fail,endpoint,clean,phone,validPhone,validEmail,getTrip,getBooking,bookingOwner,audit,adminAudit,staffActor,expire,refreshExpired,requireUser,requireAdmin,scope}=ctx;
  const lock=db.dialect === 'postgres' ? ' FOR UPDATE' : '';
  const now=() => new Date().toISOString();
  const parse=value => typeof value === 'string' ? JSON.parse(value) : value;
  const hash=token => crypto.createHash('sha256').update(token).digest('hex');
  const newCode=prefix => prefix+crypto.randomBytes(8).toString('hex').toUpperCase();
  function owner(req) {
    if (req.user) return 'user:'+req.user.id;
    if (!req.session) fail(500,'Phiên giữ chỗ chưa được cấu hình.','SERVER_ERROR');
    req.session.holdOwner ||= crypto.randomBytes(24).toString('hex');
    return 'guest:'+req.session.holdOwner;
  }
  function ownerRead(req) {return req.user ? 'user:'+req.user.id : req.session?.holdOwner ? 'guest:'+req.session.holdOwner : '';}
  function ownsHold(req,key) {return key===ownerRead(req) || Boolean(req.session?.holdOwner && key==='guest:'+req.session.holdOwner);}
  function validateSeats(seats) {
    if (!Array.isArray(seats) || seats.length<1 || seats.length>6 || seats.some(s => typeof s !== 'string') || new Set(seats).size !== seats.length) fail(400,'Vui lòng chọn từ 1 đến 6 ghế khác nhau.');
  }
  function validateLeg(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !clean(input.tripId)) fail(400,'Thông tin chuyến xe không hợp lệ.');
    validateSeats(input.seats);
    validateBookingVersion(input.expectedBookingVersion,fail);
  }
  async function lockTrips(tx,ids) {
    const rows=new Map();
    for (const id of [...new Set(ids)].sort()) {
      const row=await tx.get('SELECT * FROM trips WHERE id=?'+lock,[id]);
      if (!row) fail(404,'Không tìm thấy chuyến xe.','NOT_FOUND'); rows.set(id,row);
    }
    return rows;
  }
  async function expireHolds(tx,tripId) {
    await tx.run('DELETE FROM hold_seats WHERE hold_hash IN (SELECT hash FROM seat_holds WHERE trip_id=? AND expires_at<=?)',[tripId,now()]);
    await tx.run('DELETE FROM seat_holds WHERE trip_id=? AND expires_at<=?',[tripId,now()]);
  }
  async function clearHold(tx,holdHash) {
    await tx.run('DELETE FROM hold_seats WHERE hold_hash=?',[holdHash]); await tx.run('DELETE FROM seat_holds WHERE hash=?',[holdHash]);
  }
  async function legInfo(tx,input,{requirePoints=true,minLeadMinutes=BOOKING_LEAD_MINUTES,skipBookingCode=null}={}) {
    validateLeg(input);
    const trip=await getTrip(clean(input.tripId),tx,{activeOnly:true});
    if (!trip || (env.NODE_ENV === 'production' && trip.source === 'demo')) fail(404,'Chuyến xe không còn mở bán.','NOT_FOUND');
    if (input.expectedBookingVersion !== undefined && input.expectedBookingVersion !== bookingTermsVersion(trip)) fail(409,'Thông tin hoặc giá chuyến xe đã thay đổi. Vui lòng kiểm tra và xác nhận lại.','TRIP_CHANGED');
    const departureAt=Date.parse(trip.date+'T'+trip.departureTime+':00+07:00');
    if (departureAt<=Date.now()+minLeadMinutes*60000) fail(409,'Chuyến xe đã khởi hành hoặc quá gần giờ khởi hành.','DEPARTED');
    const labels=makeSeats(trip.type,trip.totalSeats).map(s => s.label);
    if (input.seats.some(s => !labels.includes(s))) fail(400,'Ghế đã chọn không tồn tại.');
    if (requirePoints && (!trip.pickupPoints.includes(input.pickup) || !trip.dropoffPoints.includes(input.dropoff))) fail(400,'Điểm đón hoặc trả không hợp lệ.');
    let ownHash=null;
    if (input.holdToken) {
      if (typeof input.holdToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.holdToken)) fail(409,'Mã giữ chỗ không hợp lệ hoặc đã hết hạn.','HOLD_EXPIRED');
      ownHash=hash(input.holdToken);
      const held=await tx.get('SELECT * FROM seat_holds WHERE hash=?',[ownHash]);
      if (!held || held.trip_id !== trip.id || held.expires_at<=now()) fail(409,'Giữ chỗ đã hết hạn. Vui lòng chọn lại ghế.','HOLD_EXPIRED');
      const heldSeats=parse(held.data).seats;
      if (heldSeats.length !== input.seats.length || input.seats.some(s => !heldSeats.includes(s))) fail(409,'Ghế chọn không khớp với giữ chỗ.','HOLD_MISMATCH');
    }
    const booked=await tx.all('SELECT seat,booking_code FROM reserved_seats WHERE trip_id=?',[trip.id]);
    const held=await tx.all('SELECT seat,hold_hash FROM hold_seats WHERE trip_id=?',[trip.id]);
    if (booked.some(s => input.seats.includes(s.seat) && s.booking_code !== skipBookingCode) || held.some(s => input.seats.includes(s.seat) && s.hold_hash !== ownHash)) fail(409,'Một ghế vừa được người khác giữ hoặc đặt. Vui lòng chọn lại.','SEAT_UNAVAILABLE');
    const subtotal=input.seats.reduce((sum,label) => sum+(trip.seatPrices?.[label] ?? trip.price),0);
    return {trip,seats:input.seats.slice(),pickup:input.pickup,dropoff:input.dropoff,holdHash:ownHash,departureAt,subtotal};
  }
  function roundTrip(legs) {
    if (legs.length !== 2) fail(400,'Đơn khứ hồi cần đúng hai chuyến.');
    const [a,b]=legs;
    if (a.trip.id === b.trip.id || a.trip.from !== b.trip.to || a.trip.to !== b.trip.from) fail(400,'Chuyến về phải có điểm đi và điểm đến ngược với chuyến đi.');
    if (b.departureAt < a.departureAt+a.trip.durationMinutes*60000) fail(400,'Chuyến về không thể khởi hành trước khi chuyến đi đến nơi.');
    if (a.seats.length !== b.seats.length) fail(400,'Hai chiều cần cùng số hành khách.');
  }
  const eligibleBookingSQL="(b.payment_status IN ('paid','refund_pending','refunded') OR (b.status NOT IN ('cancelled','expired','refund_pending') AND (b.status<>'pending_payment' OR b.expires_at>?)))";
  async function usageCount(tx,code,mobile=null) {
    const row=await tx.get("SELECT COUNT(*) AS n FROM promotion_uses u WHERE u.code=? AND u.status='active'"+(mobile ? ' AND u.phone=?' : '')+
      ' AND (EXISTS (SELECT 1 FROM bookings b WHERE b.code=u.booking_code AND '+eligibleBookingSQL+') OR EXISTS (SELECT 1 FROM bookings b WHERE b.order_code=u.order_code AND '+eligibleBookingSQL+'))',[code,...(mobile ? [mobile] : []),now(),now()]);
    return Number(row.n);
  }
  async function releasePromotion(tx,bookingCode) {
    const row=await tx.get('SELECT promo_code,order_code FROM bookings WHERE code=?',[bookingCode]); if (!row?.promo_code) return;
    if (row.order_code) await tx.get('SELECT code FROM orders WHERE code=?'+lock,[row.order_code]);
    const active=await tx.get('SELECT COUNT(*) AS n FROM bookings b WHERE '+(row.order_code ? 'b.order_code=?' : 'b.code=?')+' AND '+eligibleBookingSQL,[row.order_code || bookingCode,now()]);
    if (!Number(active.n)) await tx.run("UPDATE promotion_uses SET status='released' WHERE code=? AND "+(row.order_code ? 'order_code=?' : 'booking_code=?'),[row.promo_code,row.order_code || bookingCode]);
  }
  function promoShape(row,usedCount=0) {return {...parse(row.data),code:row.code,active:row.active === 1,usedCount};}
  async function quote(tx,legs,couponCode,mobile,{consume=false}={}) {
    const subtotal=legs.reduce((sum,leg) => sum+leg.subtotal,0),code=clean(couponCode,32).toUpperCase();
    if (!code) return {subtotal,discount:0,total:subtotal,couponCode:null};
    const row=await tx.get('SELECT * FROM promotions WHERE code=?'+(consume ? lock : ''),[code]);
    if (!row || !row.active) fail(400,'Mã ưu đãi không tồn tại hoặc đã ngừng áp dụng.','INVALID_COUPON');
    const p=parse(row.data);
    if ((env.NODE_ENV === 'production' && p.source === 'demo') || p.startsAt>now() || p.expiresAt<=now()) fail(400,'Mã ưu đãi chưa có hiệu lực hoặc đã hết hạn.','COUPON_EXPIRED');
    if (subtotal<p.minSpend) fail(400,'Đơn chưa đạt giá trị tối thiểu của ưu đãi.','COUPON_MIN_SPEND');
    if (p.roundTripOnly) roundTrip(legs);
    if (p.operatorIds?.length && legs.some(leg => !p.operatorIds.includes(leg.trip.operatorId))) fail(400,'Ưu đãi không áp dụng cho nhà xe này.','COUPON_NOT_APPLICABLE');
    if (p.routeIds?.length && legs.some(leg => !p.routeIds.includes(leg.trip.from+'--'+leg.trip.to))) fail(400,'Ưu đãi không áp dụng cho tuyến này.','COUPON_NOT_APPLICABLE');
    if (!validPhone(mobile)) fail(400,'Cần số điện thoại hợp lệ để kiểm tra giới hạn ưu đãi.','COUPON_PHONE_REQUIRED');
    if (await usageCount(tx,code)>=p.maxUses || await usageCount(tx,code,mobile)>=p.perCustomer) fail(409,'Ưu đãi đã hết lượt sử dụng hoặc bạn đã đạt giới hạn.','COUPON_QUOTA');
    let discount=p.type === 'percentage' ? Math.floor(subtotal*p.value/100) : p.value;
    if (p.maxDiscount>0) discount=Math.min(discount,p.maxDiscount);
    // Keep payable amount positive for receipt and VNPay reconciliation.
    discount=Math.max(0,Math.min(discount,subtotal-legs.length));
    return {subtotal,discount,total:subtotal-discount,couponCode:code};
  }
  async function getOrder(code,tx=db) {
    const row=await tx.get('SELECT * FROM orders WHERE code=?',[code]); if (!row) return null;
    const info=parse(row.data),bookings=[];
    for (const bookingCode of info.bookingCodes) bookings.push(await getBooking(bookingCode,tx));
    const active=bookings.filter(b => !['cancelled','expired','refund_pending'].includes(b.status));
    let status=active.length === 0 ? 'cancelled' : active.length<bookings.length ? 'partially_cancelled' : bookings.every(b => b.status === 'confirmed') ? 'confirmed' : 'reserved';
    if (bookings.some(b => b.status === 'refund_pending')) status=active.length ? 'partially_cancelled' : 'refund_pending';
    return {...info,code:row.code,userId:row.user_id,phone:row.phone,email:row.email,subtotal:row.subtotal,discount:row.discount,total:row.total,couponCode:row.coupon_code,
      createdAt:row.created_at,status,activeTotal:active.reduce((sum,b) => sum+b.total,0),bookings};
  }
  async function checkout(req,inputs,{asOrder=false,staff=false}={}) {
    const idempotency=staff ? null : checkoutIdempotency(req,fail);
    if(staff && req.body.paymentMethod===undefined)req.body={...req.body,paymentMethod:'cash'};
    const input=req.body,fullName=clean(input.fullName,100),email=clean(input.email,254).toLowerCase(),mobile=phone(input.phone);
    const result=await db.transaction(async tx => {
      if (idempotency) {
        if (db.dialect === 'postgres') await tx.get('SELECT pg_advisory_xact_lock(hashtext(?))',[idempotency.keyHash]);
        const previous=await tx.get('SELECT request_hash,result FROM checkout_requests WHERE key_hash=?',[idempotency.keyHash]);
        if (previous) {
          if (previous.request_hash !== idempotency.requestHash) fail(409,'Mã yêu cầu đã được dùng cho thông tin đặt vé khác. Vui lòng dùng mã mới.','IDEMPOTENCY_CONFLICT');
          const saved=parse(previous.result),bookings=[];
          for (const code of saved.bookingCodes) bookings.push(await getBooking(code,tx));
          const pending=bookings.filter(b=>b.status === 'pending_payment');
          await lockTrips(tx,pending.map(b=>b.tripId));
          for (const tripId of [...new Set(pending.map(b=>b.tripId))].sort()) await expire(tx,tripId);
          return {bookings:await Promise.all(saved.bookingCodes.map(code=>getBooking(code,tx))),order:saved.orderCode ? await getOrder(saved.orderCode,tx) : null,replayed:true};
        }
      }
      const expectedTotal=validateExpectedTotal(input.expectedTotal,fail);
      if (fullName.length<2 || (!(staff && !email) && !validEmail(email)) || !validPhone(mobile)) fail(400,'Thông tin hành khách không hợp lệ.');
      if (!['cash','vnpay','momo','zalopay'].includes(input.paymentMethod)) fail(400,'Phương thức thanh toán không hợp lệ.');
      if(staff && (asOrder || input.paymentMethod!=='cash'))fail(400,'Bán vé tại quầy hiện hỗ trợ một chuyến, thanh toán tiền mặt.','PAYMENT_UNSUPPORTED');
      if (asOrder && input.paymentMethod !== 'cash') fail(400,'Đơn khứ hồi hiện hỗ trợ thanh toán tại nhà xe. Vui lòng chọn tiền mặt.','PAYMENT_UNSUPPORTED');
      if (!Array.isArray(inputs) || inputs.length !== (asOrder ? 2 : 1)) fail(400,'Số chuyến không hợp lệ.');
      inputs.forEach(validateLeg);
      const orderCode=asOrder ? newCode('T4O') : null,bookingCodes=inputs.map(() => newCode('T4T'));
      if (input.paymentMethod === 'vnpay' && !ctx.payments.configured(env)) fail(503,'VNPAY chưa được cấu hình. Vui lòng chọn thanh toán tại nhà xe.','PAYMENT_UNAVAILABLE');
      if (['momo','zalopay'].includes(input.paymentMethod) && !ctx.walletPayments?.configured(input.paymentMethod)) fail(503,'Ví điện tử chưa được cấu hình. Vui lòng chọn phương thức khác.','PAYMENT_UNAVAILABLE');
      if(staff)await staffActor(tx,req);
      await lockTrips(tx,inputs.map(leg => clean(leg.tripId)));
      for (const tripId of [...new Set(inputs.map(leg => clean(leg.tripId)))].sort()) await expire(tx,tripId);
      const legs=[]; for (const leg of inputs) legs.push(await legInfo(tx,leg));
      if (input.paymentMethod === 'vnpay' && legs.some(leg=>!ctx.payments.acceptsSource(leg.trip,env))) fail(409,'Chuyến minh họa chỉ được thanh toán trên VNPAY sandbox. Không thể chuyển sang cổng thu tiền thật.','DEMO_PAYMENT_BLOCKED');
      if (['momo','zalopay'].includes(input.paymentMethod) && legs.some(leg=>!ctx.walletPayments.acceptsSource(input.paymentMethod,leg.trip))) fail(409,'Chuyến minh họa không được thanh toán qua cổng thu tiền thật.','DEMO_PAYMENT_BLOCKED');
      if(staff)for(const leg of legs)scope(req,leg.trip.operatorId);
      if (asOrder) roundTrip(legs);
      const prices=await quote(tx,legs,input.couponCode,mobile,{consume:true});
      if (expectedTotal !== undefined && expectedTotal !== prices.total) fail(409,'Giá hoặc ưu đãi đã thay đổi. Vui lòng kiểm tra tổng tiền và xác nhận lại.','PRICE_CHANGED');
      if (input.paymentMethod==='momo' && (prices.total<1000 || prices.total>50000000)) fail(400,'MoMo hỗ trợ số tiền từ 1.000 đến 50.000.000 VND. Vui lòng chọn phương thức khác.','PAYMENT_AMOUNT_UNSUPPORTED');
      const bookingItems=[],createdAt=now();
      if (asOrder) await tx.run('INSERT INTO orders(code,user_id,phone,email,subtotal,discount,total,coupon_code,created_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)',[orderCode,req.user?.id || null,mobile,email,prices.subtotal,prices.discount,prices.total,prices.couponCode,createdAt,JSON.stringify({fullName,bookingCodes,source:legs.some(l => l.trip.source === 'demo') ? 'demo' : 'managed'})]);
      let allocated=0;
      for (let i=0;i<legs.length;i++) {
        const leg=legs[i],code=bookingCodes[i],remainingCapacity=legs.slice(i+1).reduce((sum,item)=>sum+item.subtotal-1,0);
        const proportional=i === legs.length-1 ? prices.discount-allocated : Math.floor(prices.discount*leg.subtotal/prices.subtotal);
        const discount=Math.max(prices.discount-allocated-remainingCapacity,Math.min(leg.subtotal-1,proportional)); allocated+=discount;
        const expiresAt=input.paymentMethod !== 'cash' ? new Date(Date.now()+15*60000).toISOString() : null,status=input.paymentMethod !== 'cash' ? 'pending_payment' : 'reserved';
        const item={code,tripId:leg.trip.id,userId:staff ? null : req.user?.id || null,...(staff ? {createdBy:req.user.id,channel:'counter'} : {}),fullName,email,phone:mobile,seats:leg.seats,pickup:leg.pickup,dropoff:leg.dropoff,paymentMethod:input.paymentMethod,
          paymentStatus:'pending',status,subtotal:leg.subtotal,discount,total:leg.subtotal-discount,couponCode:prices.couponCode,orderCode,createdAt,expiresAt,source:leg.trip.source,provenance:leg.trip.provenance || '',trip:leg.trip};
        await tx.run('INSERT INTO bookings(code,trip_id,user_id,phone,email,status,payment_status,payment_method,total,expires_at,created_at,data,order_code,promo_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[code,leg.trip.id,item.userId,mobile,email,status,'pending',input.paymentMethod,item.total,expiresAt,createdAt,JSON.stringify(item),orderCode,prices.couponCode]);
        if (leg.holdHash) await clearHold(tx,leg.holdHash);
        for (const seat of leg.seats) await tx.run('INSERT INTO reserved_seats(trip_id,seat,booking_code) VALUES(?,?,?)',[leg.trip.id,seat,code]);
        await audit(tx,code,req.user?.id || 'guest','created',{seats:leg.seats,source:leg.trip.source,orderCode,couponCode:prices.couponCode,discount});
        if(staff)await adminAudit(tx,req,'counter_booking_created','booking',code,leg.trip.operatorId,{seats:leg.seats,total:item.total,channel:'counter'});
        bookingItems.push(item);
      }
      if (prices.couponCode) {
        await tx.run('INSERT INTO promotion_uses(id,code,booking_code,order_code,phone,status,created_at) VALUES(?,?,?,?,?,?,?)',[crypto.randomUUID(),prices.couponCode,asOrder ? null : bookingCodes[0],orderCode,mobile,'active',createdAt]);
        await tx.run('UPDATE promotions SET used_count=? WHERE code=?',[await usageCount(tx,prices.couponCode),prices.couponCode]);
      }
      if (idempotency) await tx.run('INSERT INTO checkout_requests(key_hash,request_hash,result,created_at) VALUES(?,?,?,?)',[idempotency.keyHash,idempotency.requestHash,JSON.stringify({bookingCodes,orderCode}),createdAt]);
      return {bookings:bookingItems,order:asOrder ? await getOrder(orderCode,tx) : null};
    });
    return result;
  }
  async function notify(bookingOrBookings,order=null) {
    const bookings=Array.isArray(bookingOrBookings) ? bookingOrBookings : [bookingOrBookings],booking=bookings[0];
    const itinerary=bookings.map((item,index)=>(bookings.length>1 ? '\nChiều '+(index+1)+'\n' : '')+'Mã đặt chỗ: '+item.code+'\n'+item.trip.fromName+' → '+item.trip.toName+'\n'+item.trip.date+' '+item.trip.departureTime+'\nGhế: '+item.seats.join(', ')+'\nĐiểm đón: '+item.pickup+'\nĐiểm trả: '+item.dropoff+'\nTổng: '+item.total+' VND').join('\n');
    return ctx.mail({to:booking.email,subject:'Đặt chỗ Ticket4T '+(order?.code || booking.code),text:'Xin chào '+booking.fullName+'\n'+(order ? 'Mã đơn khứ hồi: '+order.code+'\n' : '')+itinerary+(order ? '\nTổng đơn: '+order.total+' VND' : '')+'\nTrạng thái: chưa thanh toán.\n'+(bookings.some(item=>item.source === 'demo') ? 'ĐÂY LÀ DỮ LIỆU MẪU; không phải vé nhà xe thật.' : 'Vui lòng xác nhận thông tin với nhà xe.')});
  }
  function installPublic(router) {
    router.post('/holds/session',endpoint(async (req,res)=>{owner(req);res.json({ready:true});}));
    router.post('/holds',endpoint(async (req,res) => {
      const input=req.body; validateLeg(input);
      if (input.expectedHoldToken !== undefined && input.expectedHoldToken !== null && (typeof input.expectedHoldToken !== 'string' || input.expectedHoldToken.length !== 64 || !/^[a-f0-9]{64}$/.test(input.expectedHoldToken))) fail(400,'Mã giữ chỗ cần thay thế không hợp lệ.');
      const expectedHash=input.expectedHoldToken === undefined || input.expectedHoldToken === null ? null : hash(input.expectedHoldToken);
      const tripId=clean(input.tripId),ownerKey=owner(req),token=crypto.randomBytes(32).toString('hex'),holdHash=hash(token);
      const hold=await db.transaction(async tx => {
        if (db.dialect === 'postgres') await tx.get('SELECT pg_advisory_xact_lock(hashtext(?))',[ownerKey]);
        await lockTrips(tx,[tripId]); await expire(tx,tripId);
        const guestKey=req.session?.holdOwner ? 'guest:'+req.session.holdOwner : ownerKey;
        const old=await tx.all('SELECT hash,data FROM seat_holds WHERE trip_id=? AND (owner_key=? OR owner_key=?)',[tripId,ownerKey,guestKey]);
        if (input.expectedHoldToken !== undefined && old.some(row=>{
          if (row.hash === expectedHash) return false;
          const data=parse(row.data);
          return !Object.prototype.hasOwnProperty.call(data,'renewalPredecessorHash') || data.renewalPredecessorHash !== expectedHash || JSON.stringify(data.seats) !== JSON.stringify(input.seats);
        })) fail(409,'Giữ chỗ đã thay đổi. Vui lòng kiểm tra lựa chọn hiện tại.','HOLD_CHANGED');
        const other=await tx.get('SELECT COUNT(*) AS n FROM seat_holds WHERE (owner_key=? OR owner_key=?) AND trip_id<>? AND expires_at>?',[ownerKey,guestKey,tripId,now()]);
        if (Number(other.n)>=2) fail(429,'Chỉ được giữ ghế tối đa hai chuyến cùng lúc.','HOLD_LIMIT');
        // Replacing a user's previous hold on the same trip is atomic, without extending any other user's hold.
        for (const row of old) await clearHold(tx,row.hash);
        const leg=await legInfo(tx,input,{requirePoints:false});
        const expiresAt=new Date(Math.min(Date.now()+5*60000,leg.departureAt-BOOKING_LEAD_MINUTES*60000)).toISOString();
        const data={seats:input.seats,...(input.expectedHoldToken !== undefined ? {renewalPredecessorHash:expectedHash} : {})};
        await tx.run('INSERT INTO seat_holds(hash,trip_id,owner_key,expires_at,data) VALUES(?,?,?,?,?)',[holdHash,tripId,ownerKey,expiresAt,JSON.stringify(data)]);
        for (const seat of input.seats) await tx.run('INSERT INTO hold_seats(trip_id,seat,hold_hash) VALUES(?,?,?)',[tripId,seat,holdHash]);
        return {token,tripId,seats:input.seats,expiresAt};
      }); res.status(201).json({hold});
    }));
    router.delete('/holds/:token',endpoint(async (req,res) => {
      const token=req.params.token; if (!/^[a-f0-9]{64}$/.test(token)) fail(404,'Không tìm thấy giữ chỗ.','NOT_FOUND');
      const holdHash=hash(token),initial=await db.get('SELECT trip_id FROM seat_holds WHERE hash=?',[holdHash]);
      if (initial) await db.transaction(async tx => {await lockTrips(tx,[initial.trip_id]);await clearHold(tx,holdHash);});
      res.json({released:true});
    }));
    router.post('/orders',endpoint(async (req,res) => {
      const result=await checkout(req,req.body.legs,{asOrder:true}); const emailDelivery=result.replayed ? {delivered:false,skipped:true} : await notify(result.bookings,result.order);
      if (result.replayed) res.set('Idempotency-Replayed','true');
      res.status(201).json({order:result.order,emailDelivery,...(result.replayed ? {replayed:true} : {})});
    }));
    router.get('/orders/lookup',endpoint(async (req,res) => {
      await refreshExpired(); const order=await getOrder(clean(req.query.code,30).toUpperCase());
      if (!order || !validPhone(phone(req.query.phone)) || order.phone !== phone(req.query.phone)) fail(404,'Không tìm thấy đơn với mã và số điện thoại này.','NOT_FOUND'); res.json({order});
    }));
    router.get('/orders',requireUser,endpoint(async (req,res) => {
      await refreshExpired(); const rows=await db.all('SELECT code FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100',[req.user.id]),orders=[];
      for (const row of rows) orders.push(await getOrder(row.code)); res.json({orders});
    }));
    router.get('/promotions',endpoint(async (req,res) => {
      const rows=await db.all('SELECT * FROM promotions WHERE active=1 ORDER BY created_at DESC'),promotions=[];
      for (const row of rows) {const p=parse(row.data); if (p.startsAt<=now() && p.expiresAt>now() && (env.NODE_ENV !== 'production' || p.source !== 'demo')) promotions.push(promoShape(row,await usageCount(db,row.code)));}
      res.json({promotions});
    }));
    router.post('/promotions/quote',endpoint(async (req,res) => {
      if (!Array.isArray(req.body.legs) || ![1,2].includes(req.body.legs.length)) fail(400,'Cần một chuyến hoặc hai chuyến khứ hồi.');
      req.body.legs.forEach(validateLeg);
      const prices=await db.transaction(async tx => {
        const tripIds=req.body.legs.map(input=>clean(input.tripId));
        await lockTrips(tx,tripIds);
        for (const tripId of [...new Set(tripIds)].sort()) await expire(tx,tripId);
        const legs=[];
        for (const input of req.body.legs) legs.push(await legInfo(tx,input,{requirePoints:false}));
        if (legs.length === 2) roundTrip(legs);
        return quote(tx,legs,req.body.couponCode,phone(req.body.phone));
      });
      res.json(prices);
    }));
    router.post('/bookings/:code/reschedule',endpoint(async (req,res) => {const result=await reschedule(req,false);if(result.replayed)res.set('Idempotency-Replayed','true');res.json(result);}));
  }
  async function validatePromotion(input,current={}) {
    for(const key of ['active','roundTripOnly'])if(input[key]!==undefined && typeof input[key]!=='boolean')fail(400,'Trạng thái '+key+' phải là true hoặc false.');
    const code=clean(current.code || input.code,32).toUpperCase(),title=clean(input.title ?? current.title,150),description=clean(input.description ?? current.description,2000),type=input.type ?? current.type ?? 'percentage',value=Number(input.value ?? current.value);
    if (!/^[A-Z0-9_-]{3,32}$/.test(code) || title.length<2 || !['percentage','fixed'].includes(type) || !Number.isSafeInteger(value) || value<1 || (type === 'percentage' && value>100) || (type === 'fixed' && value>100000000)) fail(400,'Mã, tên, kiểu hoặc mức ưu đãi không hợp lệ.');
    const p={...current,code,title,description,type,value,source:current.source || 'managed',active:input.active === undefined ? current.active !== false : Boolean(input.active),roundTripOnly:input.roundTripOnly === undefined ? Boolean(current.roundTripOnly) : Boolean(input.roundTripOnly)};
    for (const [key,fallback,max] of [['minSpend',0,1000000000],['maxDiscount',0,1000000000],['maxUses',1000,1000000],['perCustomer',1,1000000]]) {p[key]=Number(input[key] ?? current[key] ?? fallback);if(!Number.isSafeInteger(p[key]) || p[key]<(key==='maxUses'||key==='perCustomer' ? 1 : 0) || p[key]>max) fail(400,'Giới hạn '+key+' không hợp lệ.');}
    p.startsAt=input.startsAt ?? current.startsAt ?? now(); p.expiresAt=input.expiresAt ?? current.expiresAt ?? new Date(Date.now()+30*86400000).toISOString();
    const validTime=value=>{
      if(typeof value!=='string')return false;
      const match=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
      if(!match)return false;
      const [,year,month,day,hour,minute,second='0']=match;
      const leap=Number(year)%4===0 && (Number(year)%100!==0 || Number(year)%400===0);
      const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
      return Number(month)>=1 && Number(month)<=12 && Number(day)>=1 && Number(day)<=days[Number(month)-1]
        && Number(hour)<24 && Number(minute)<60 && Number(second)<60 && Number.isFinite(Date.parse(value));
    };
    if (!validTime(p.startsAt) || !validTime(p.expiresAt) || Date.parse(p.startsAt)>=Date.parse(p.expiresAt)) fail(400,'Thời gian ưu đãi cần ISO có ngày hợp lệ và múi giờ; hết hạn sau ngày bắt đầu.');
    p.startsAt=new Date(p.startsAt).toISOString();p.expiresAt=new Date(p.expiresAt).toISOString();
    for (const key of ['operatorIds','routeIds']) {p[key]=input[key] ?? current[key] ?? [];if(!Array.isArray(p[key]) || p[key].length>100 || p[key].some(x=>typeof x!=='string' || x.length>100) || new Set(p[key]).size!==p[key].length) fail(400,'Danh sách '+key+' không hợp lệ.');}
    for (const id of p.operatorIds) if (!await db.get('SELECT id FROM operators WHERE id=?',[id])) fail(400,'Nhà xe giới hạn ưu đãi không tồn tại.');
    for (const id of p.routeIds) {const [from,to,...rest]=id.split('--');if(rest.length || from===to || !await db.get('SELECT id FROM locations WHERE id=?',[from]) || !await db.get('SELECT id FROM locations WHERE id=?',[to])) fail(400,'Tuyến giới hạn ưu đãi không hợp lệ.');}
    return p;
  }
  async function reschedule(req,staff) {
    const code=clean(req.params.code,30).toUpperCase(),initial=await getBooking(code);if(!initial) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
    if (staff) scope(req,initial.trip.operatorId);else if (!bookingOwner(req,initial)) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
    const idempotency=checkoutIdempotency(req,fail),targetId=clean(req.body.tripId);
    const retryReplay=new Error('Reschedule replay moved while acquiring locks');
    for(let attempt=0;attempt<3;attempt++)try{return await db.transaction(async tx => {
      if (idempotency && db.dialect === 'postgres') await tx.get('SELECT pg_advisory_xact_lock(hashtext(?))',[idempotency.keyHash]);
      if(staff)await staffActor(tx,req);
      const previous=idempotency ? await tx.get('SELECT request_hash,result FROM checkout_requests WHERE key_hash=?',[idempotency.keyHash]) : null;
      const current=await getBooking(code,tx);if(!current)fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
      if (staff) scope(req,current.trip.operatorId);else if (!bookingOwner(req,current)) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
      if (!previous) {validateSourceVersion(req.body.expectedSourceVersion,fail);validateLeg(req.body);}
      const orderRows=!previous && current.orderCode ? await tx.all('SELECT trip_id FROM bookings WHERE order_code=?',[current.orderCode]) : [];
      const lockedTrips=await lockTrips(tx,previous ? [current.tripId] : [current.tripId,targetId,...orderRows.map(row=>row.trip_id)]);
      if (!previous) {await expire(tx,current.tripId);if(targetId !== current.tripId)await expire(tx,targetId);}
      const row=await tx.get('SELECT * FROM bookings WHERE code=?'+lock,[code]),booking=await getBooking(code,tx);
      if (previous && row.trip_id !== current.tripId) throw retryReplay;
      if (staff) scope(req,booking.trip.operatorId);else if (!bookingOwner(req,booking)) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
      if (previous) {
        if(staff)scope(req,lockedTrips.get(booking.tripId).operator_id);
        if (previous.request_hash !== idempotency.requestHash) fail(409,'Mã yêu cầu đã được dùng cho thao tác khác. Vui lòng dùng mã mới.','IDEMPOTENCY_CONFLICT');
        return {booking,replayed:true};
      }
      if (req.body.expectedSourceVersion !== undefined && req.body.expectedSourceVersion !== booking.rescheduleVersion) fail(409,'Đặt chỗ đã thay đổi. Vui lòng kiểm tra và xác nhận lại chuyến cần đổi.','BOOKING_CHANGED');
      if (row.trip_id !== current.tripId) fail(409,'Vé vừa được thay đổi. Vui lòng tải lại.','CONFLICT');
      if(staff){scope(req,lockedTrips.get(current.tripId).operator_id);scope(req,lockedTrips.get(targetId).operator_id);}
      if (!['reserved','confirmed'].includes(row.status) || !['pending','paid'].includes(row.payment_status)) fail(409,'Vé ở trạng thái này không được đổi chuyến.','INVALID_TRANSITION');
      if (Date.parse(booking.trip.date+'T'+booking.trip.departureTime+':00+07:00')<=Date.now()+2*3600000) fail(409,'Chỉ đổi chuyến trước giờ khởi hành ít nhất hai giờ.','RESCHEDULE_CLOSED');
      const leg=await legInfo(tx,req.body,{minLeadMinutes:120,skipBookingCode:code});
      if (leg.trip.operatorId !== booking.trip.operatorId || leg.trip.from !== booking.trip.from || leg.trip.to !== booking.trip.to || leg.trip.source !== booking.source) fail(400,'Chỉ được đổi cùng nhà xe, cùng tuyến và cùng nguồn kho vé.','RESCHEDULE_ROUTE');
      if (leg.seats.length !== booking.seats.length || leg.subtotal !== (booking.subtotal ?? booking.total)) fail(409,'Chỉ hỗ trợ đổi cùng số hành khách và cùng giá gốc. Liên hệ nhà xe nếu có chênh lệch.','FARE_DIFFERENCE');
      const updated={...booking,tripId:leg.trip.id,trip:leg.trip,seats:leg.seats,pickup:leg.pickup,dropoff:leg.dropoff,previousTrips:[...(booking.previousTrips || []),{tripId:booking.tripId,date:booking.trip.date,departureTime:booking.trip.departureTime,seats:booking.seats,changedAt:now()}]};
      delete updated.rescheduleVersion;
      if (booking.orderCode) {const order=await getOrder(booking.orderCode,tx);const orderLegs=order.bookings.map(b => {const item=b.code===code ? updated : b;return {trip:item.trip,seats:item.seats,departureAt:Date.parse(item.trip.date+'T'+item.trip.departureTime+':00+07:00')};}); if (order.bookings.every(b=>!['cancelled','expired','refund_pending'].includes(b.status))) roundTrip(orderLegs);}
      await tx.run('DELETE FROM reserved_seats WHERE booking_code=?',[code]); if (leg.holdHash) await clearHold(tx,leg.holdHash);
      for (const seat of leg.seats) await tx.run('INSERT INTO reserved_seats(trip_id,seat,booking_code) VALUES(?,?,?)',[leg.trip.id,seat,code]);
      await tx.run('UPDATE bookings SET trip_id=?,data=? WHERE code=?',[leg.trip.id,JSON.stringify(updated),code]);
      await audit(tx,code,req.user?.id || 'guest','rescheduled',{fromTrip:booking.tripId,toTrip:leg.trip.id,fromSeats:booking.seats,toSeats:leg.seats});
      if(staff)await adminAudit(tx,req,'booking_rescheduled','booking',code,leg.trip.operatorId,{fromTrip:booking.tripId,toTrip:leg.trip.id,fromSeats:booking.seats,toSeats:leg.seats});
      if(idempotency)await tx.run('INSERT INTO checkout_requests(key_hash,request_hash,result,created_at) VALUES(?,?,?,?)',[idempotency.keyHash,idempotency.requestHash,JSON.stringify({bookingCodes:[code]}),now()]);
      return {booking:await getBooking(code,tx)};
    });}catch(error){if(error !== retryReplay)throw error;}
    fail(503,'Đặt chỗ đang được cập nhật. Vui lòng thử lại cùng yêu cầu.','RESCHEDULE_RETRY');
  }
  function installAdmin(router) {
    router.get('/admin/promotions',requireAdmin,endpoint(async(req,res)=>{const rows=await db.all('SELECT * FROM promotions ORDER BY created_at DESC'),promotions=[];for(const row of rows)promotions.push(promoShape(row,await usageCount(db,row.code)));res.json({promotions});}));
    router.post('/admin/promotions',requireAdmin,endpoint(async(req,res)=>{const p=await validatePromotion(req.body);await db.transaction(async tx=>{await staffActor(tx,req);if(req.user.role!=='admin')fail(403,'Chỉ quản trị viên có quyền thực hiện.','FORBIDDEN');if(await tx.get('SELECT code FROM promotions WHERE code=?',[p.code]))fail(409,'Mã ưu đãi đã tồn tại.','COUPON_EXISTS');await tx.run('INSERT INTO promotions(code,data,active,used_count,created_at) VALUES(?,?,?,0,?)',[p.code,JSON.stringify(p),p.active?1:0,now()]);await adminAudit(tx,req,'promotion_created','promotion',p.code,null,{active:p.active,type:p.type,value:p.value});});res.status(201).json({promotion:{...p,usedCount:0}});}));
    router.patch('/admin/promotions/:code',requireAdmin,endpoint(async(req,res)=>{const code=clean(req.params.code,32).toUpperCase();const p=await db.transaction(async tx=>{await staffActor(tx,req);if(req.user.role!=='admin')fail(403,'Chỉ quản trị viên có quyền thực hiện.','FORBIDDEN');const row=await tx.get('SELECT * FROM promotions WHERE code=?'+lock,[code]);if(!row)fail(404,'Không tìm thấy ưu đãi.','NOT_FOUND');const p=await validatePromotion(req.body,{...parse(row.data),active:row.active===1});await tx.run('UPDATE promotions SET data=?,active=? WHERE code=?',[JSON.stringify(p),p.active?1:0,code]);await adminAudit(tx,req,'promotion_updated','promotion',code,null,{active:p.active,type:p.type,value:p.value});return p;});res.json({promotion:{...p,usedCount:await usageCount(db,code)}});}));
    router.delete('/admin/promotions/:code',requireAdmin,endpoint(async(req,res)=>{const code=clean(req.params.code,32).toUpperCase();await db.transaction(async tx=>{await staffActor(tx,req);if(req.user.role!=='admin')fail(403,'Chỉ quản trị viên có quyền thực hiện.','FORBIDDEN');if(!await tx.get('SELECT code FROM promotions WHERE code=?'+lock,[code]))fail(404,'Không tìm thấy ưu đãi.','NOT_FOUND');await tx.run('UPDATE promotions SET active=0 WHERE code=?',[code]);await adminAudit(tx,req,'promotion_deactivated','promotion',code);});res.json({message:'Đã ngừng áp dụng mã ưu đãi.'});}));
    router.post('/admin/bookings/:code/reschedule',endpoint(async(req,res)=>{const result=await reschedule(req,true);if(result.replayed)res.set('Idempotency-Replayed','true');res.json(result);}));
    router.get('/admin/trips/:id/manifest',endpoint(async(req,res)=>{await refreshExpired();const trip=await getTrip(req.params.id);if(!trip)fail(404,'Không tìm thấy chuyến xe.','NOT_FOUND');scope(req,trip.operatorId);const rows=await db.all("SELECT code FROM bookings WHERE trip_id=? AND status IN ('reserved','confirmed','pending_payment') ORDER BY created_at",[trip.id]),passengers=[];for(const row of rows){const b=await getBooking(row.code);passengers.push({bookingCode:b.code,orderCode:b.orderCode || null,fullName:b.fullName,phone:b.phone,email:b.email,seats:b.seats,pickup:b.pickup,dropoff:b.dropoff,status:b.status,paymentStatus:b.paymentStatus,total:b.total,createdAt:b.createdAt,source:b.source});}res.json({trip,passengers,counts:{bookings:passengers.length,passengers:passengers.reduce((n,b)=>n+b.seats.length,0),seats:passengers.reduce((n,b)=>n+b.seats.length,0),paid:passengers.filter(b=>b.paymentStatus==='paid').length,unpaid:passengers.filter(b=>b.paymentStatus!=='paid').length}});}));
  }
  return {installPublic,installAdmin,checkout,notify,expireHolds,releasePromotion,ownerRead,ownsHold};
}

module.exports={createBookingFeatures,BOOKING_LEAD_MINUTES};
