'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createFeatureFixture} = require('./helpers/feature-fixture');
const {addDays} = require('../server/catalog');

const post = (body,cookie) => ({method:'POST',body,cookie});
const reviewBody = booking => ({bookingCode:booking.code,rating:5,title:'Hành trình kiểm thử',comment:'Nhận xét từ hành khách đã hoàn tất hành trình.'});
const promotionBody = (extra={}) => ({code:'CONTRACT10',title:'Ưu đãi hợp đồng kiểm thử',type:'percentage',value:10,minSpend:0,maxDiscount:0,maxUses:100,perCustomer:2,startsAt:'2000-01-01T00:00:00.000Z',expiresAt:'2099-01-01T00:00:00.000Z',...extra});

test('[IT-SRCH-001] time filters partition exact boundaries and composed filters preserve sorted page totals',async t => {
  const f = await createFeatureFixture(t),times=['00:00','05:59','06:00','11:59','12:00','17:59','18:00','23:59'],trips=[];
  for (let i=0;i<times.length;i++) trips.push(await f.trip({departureTime:times[i],price:100000+i*10000}));
  await f.trip({date:addDays(f.today,3)});
  const op = await f.company();
  for (const [time,expected] of [['night',times.slice(0,2)],['morning',times.slice(2,4)],['afternoon',times.slice(4,6)],['evening',times.slice(6)]]) {
    const result = f.expect(await f.request('/trips?'+new URLSearchParams({date:trips[0].date,from:'ho-chi-minh',to:'da-lat',time})),200);
    assert.deepEqual(result.data.trips.map(item=>item.departureTime),expected,time);
    assert.equal(result.data.total,2,time);
  }
  const params = {date:trips[0].date,from:'ho-chi-minh',to:'da-lat',operator:op.id,type:'limousine',minPrice:'120000',maxPrice:'150000',sort:'price',limit:'2'};
  const first = f.expect(await f.request('/trips?'+new URLSearchParams({...params,page:'1'})),200).data;
  const second = f.expect(await f.request('/trips?'+new URLSearchParams({...params,page:'2'})),200).data;
  assert.equal(first.total,4);assert.equal(second.total,4);assert.equal(first.pages,2);assert.equal(second.pages,2);
  assert.deepEqual([...first.trips,...second.trips].map(item=>item.id),trips.slice(2,6).map(item=>item.id));
  const beyond = f.expect(await f.request('/trips?'+new URLSearchParams({...params,page:'3'})),200).data;
  assert.equal(beyond.total,4);assert.equal(beyond.page,2);
  assert.deepEqual(beyond.trips.map(item=>item.id),second.trips.map(item=>item.id));
});

test('[IT-SRCH-002] malformed dates and non-finite or negative fares return validation errors without hiding valid inventory',async t => {
  const f = await createFeatureFixture(t),item = await f.trip();
  for (const query of ['date=2026-02-30','date=not-a-date','minPrice=-1','maxPrice=Infinity','minPrice=NaN']) {
    const result = f.expect(await f.request('/trips?'+query),400);
    assert.equal(result.data.code,'VALIDATION_ERROR');
  }
  const result = f.expect(await f.request('/trips?date='+item.date),200);
  assert.deepEqual(result.data.trips.map(row=>row.id),[item.id]);
});

test('[IT-SRCH-003] rating sorts descending and equal departures and fares paginate stably by trip ID',async t => {
  const f = await createFeatureFixture(t),first = await f.company();
  const second = f.expect(await f.request('/admin/operators',post({name:'Nhà xe đồng hạng kiểm thử',phone:'0901234567'},f.adminCookie)),201).data.operator;
  const third = f.expect(await f.request('/admin/operators',post({name:'Nhà xe hạng thấp kiểm thử',phone:'0901234567'},f.adminCookie)),201).data.operator;
  const ratings = new Map([[first.id,4.8],[second.id,4.8],[third.id,3.2]]);
  // Known historical ratings and IDs isolate sorting from review creation and
  // UUID randomness. Tied records are deliberately inserted out of ID order.
  await f.db.transaction(async tx => {
    for (const [operatorId,rating] of ratings) {
      const row = await tx.get('SELECT data FROM operators WHERE id=?',[operatorId]);
      await tx.run('UPDATE operators SET data=? WHERE id=?',[JSON.stringify({...JSON.parse(row.data),rating,reviewCount:10}),operatorId]);
    }
  });
  const inputs = [
    {key:'tie-z',operatorId:first.id,departureTime:'18:00',price:250000},
    {key:'tie-b',operatorId:second.id,departureTime:'18:00',price:250000},
    {key:'tie-a',operatorId:first.id,departureTime:'18:00',price:250000},
    {key:'high-early',operatorId:second.id,departureTime:'06:00',price:250000},
    {key:'low-cheap',operatorId:third.id,departureTime:'05:00',price:200000},
    {key:'low-late',operatorId:third.id,departureTime:'20:00',price:250000}
  ],trips = [];
  for (const {key,...input} of inputs) {
    const item = await f.trip(input),id = 'trip-search-'+key;
    await f.db.transaction(async tx => {
      const row = await tx.get('SELECT data FROM trips WHERE id=?',[item.id]);
      await tx.run('UPDATE trips SET id=?,data=? WHERE id=?',[id,JSON.stringify({...JSON.parse(row.data),id}),item.id]);
    });
    trips.push({...item,id});
  }
  const compareId = (a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const compareDeparture = (a,b) => a.departureTime.localeCompare(b.departureTime);
  const compare = {
    rating:(a,b) => ratings.get(b.operatorId)-ratings.get(a.operatorId) || compareDeparture(a,b) || compareId(a,b),
    price:(a,b) => a.price-b.price || compareDeparture(a,b) || compareId(a,b),
    departure:(a,b) => compareDeparture(a,b) || a.price-b.price || compareId(a,b)
  };
  for (const sort of ['rating','price','departure']) {
    const expected = [...trips].sort(compare[sort]).map(item=>item.id),seen=[];
    const search = page => f.request('/trips?'+new URLSearchParams({date:trips[0].date,from:'ho-chi-minh',to:'da-lat',sort,limit:'2',page:String(page)}));
    for (let page=1;page<=3;page++) {
      const result = f.expect(await search(page),200).data;
      assert.equal(result.total,6);assert.equal(result.pages,3);assert.equal(result.page,page);
      seen.push(...result.trips.map(item=>item.id));
      assert.deepEqual(result.trips.map(item=>item.id),expected.slice((page-1)*2,page*2),sort+' page '+page);
    }
    assert.deepEqual(seen,expected,sort);assert.equal(new Set(seen).size,6);
    assert.deepEqual(f.expect(await search(2),200).data.trips.map(item=>item.id),expected.slice(2,4),sort+' repeated page');
  }
});

test('[IT-AUTH-001] registration normalizes identity, ignores privilege fields and rejects case-insensitive duplicate email',async t => {
  const f = await createFeatureFixture(t);
  const created = await f.customer('identity',{email:'  Identity@Example.Test ',phone:'+84 901 234 567',fullName:'  Hành khách chuẩn hóa  ',role:'admin',operatorId:'injected-operator',verified:true,active:false});
  assert.equal(created.user.email,'identity@example.test');assert.equal(created.user.phone,'0901234567');assert.equal(created.user.fullName,'Hành khách chuẩn hóa');
  assert.equal(created.user.role,'customer');assert.equal(created.user.operatorId,null);assert.equal(created.user.verified,false);assert.equal(created.user.active,true);
  const exposed = JSON.stringify(created.data);
  assert.ok(!/password_hash|Customer@12345|auth_version/.test(exposed));
  const before = await f.db.get('SELECT COUNT(*) AS n FROM email_outbox');
  const duplicate = f.expect(await f.request('/auth/register',post({fullName:'Người trùng email',email:'IDENTITY@EXAMPLE.TEST',phone:'0901234567',password:'Customer@12345'},null)),409);
  assert.equal(duplicate.data.code,'EMAIL_EXISTS');
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM users WHERE email=?',['identity@example.test'])).n),1);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM email_outbox')).n),Number(before.n));
  assert.equal((await f.request('/admin/users',{cookie:created.cookie})).status,403);
});

test('[IT-AUTH-002] invalid signups leave no accounts or mail and login errors do not reveal account existence',async t => {
  const f = await createFeatureFixture(t),valid={fullName:'Hành khách hợp lệ',email:'invalid-case@example.test',phone:'0901234567',password:'Customer@12345'};
  const before = Number((await f.db.get('SELECT COUNT(*) AS n FROM users')).n);
  for (const body of [{...valid,fullName:'x'},{...valid,email:'bad-email'},{...valid,phone:'123'},{...valid,password:'short'},{...valid,password:'alllowercase123'},{...valid,password:'ALLUPPERCASE123'},[],null]) f.expect(await f.request('/auth/register',post(body,null)),400);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM users')).n),before);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM auth_tokens')).n),0);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM email_outbox')).n),0);
  const known = f.expect(await f.request('/auth/login',post({email:f.env.ADMIN_EMAIL,password:'WrongPassword@123'},null)),401);
  const unknown = f.expect(await f.request('/auth/login',post({email:'absent@example.test',password:'WrongPassword@123'},null)),401);
  assert.deepEqual(known.data,unknown.data);assert.equal(known.cookie,undefined);assert.equal(unknown.cookie,undefined);
  for (const password of [null,{},'x'.repeat(129)]) f.expect(await f.request('/auth/login',post({email:f.env.ADMIN_EMAIL,password},null)),401);
});

test('[IT-AUTH-003] login rotates sessions and logout invalidates the original cookie and authenticated history',async t => {
  const f = await createFeatureFixture(t),registered = await f.customer('session-owner');
  const logged = f.expect(await f.request('/auth/login',post({email:registered.user.email,password:'Customer@12345'},registered.cookie)),200);
  assert.notEqual(logged.cookie,registered.cookie);
  assert.equal((await f.request('/auth/me',{cookie:registered.cookie})).data.user,null);
  assert.equal((await f.request('/auth/me',{cookie:logged.cookie})).data.user.id,registered.user.id);
  const logout = f.expect(await f.request('/auth/logout',post({},logged.cookie)),200);
  assert.match(logout.headers.get('set-cookie'),/Expires=Thu, 01 Jan 1970/);
  assert.equal((await f.request('/auth/me',{cookie:logged.cookie})).data.user,null);
  assert.equal((await f.request('/bookings',{cookie:logged.cookie})).status,401);
  f.expect(await f.request('/auth/logout',post({},null)),200);
});

test('[IT-AUTH-004] verification resend invalidates old tokens and expired or wrong-purpose tokens cannot change identity',async t => {
  const f = await createFeatureFixture(t),registered = await f.customer('token-owner'),email = registered.user.email;
  const old = await f.lastToken(email,'Xác minh email Ticket4T');
  f.expect(await f.request('/auth/resend-verification',post({},registered.cookie)),200);
  const current = await f.lastToken(email,'Xác minh email Ticket4T');
  assert.notEqual(current,old);
  assert.equal(f.expect(await f.request('/auth/verify',post({token:old},null)),400).data.code,'INVALID_TOKEN');
  const known = f.expect(await f.request('/auth/forgot-password',post({email},null)),200);
  const mailCount = Number((await f.db.get('SELECT COUNT(*) AS n FROM email_outbox')).n);
  const unknown = f.expect(await f.request('/auth/forgot-password',post({email:'absent@example.test'},null)),200);
  assert.deepEqual(known.data,unknown.data);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM email_outbox')).n),mailCount);
  const reset = await f.lastToken(email,'Đặt lại mật khẩu Ticket4T');
  f.expect(await f.request('/auth/verify',post({token:reset},null)),400);
  f.expect(await f.request('/auth/reset-password',post({token:current,password:'Changed@12345'},null)),400);
  await f.db.transaction(tx=>tx.run('UPDATE auth_tokens SET expires_at=? WHERE hash=?',['2000-01-01T00:00:00.000Z',crypto.createHash('sha256').update(current).digest('hex')]));
  assert.equal(f.expect(await f.request('/auth/verify',post({token:current},null)),400).data.code,'INVALID_TOKEN');
  await f.db.transaction(tx=>tx.run('UPDATE auth_tokens SET expires_at=? WHERE hash=?',['2000-01-01T00:00:00.000Z',crypto.createHash('sha256').update(reset).digest('hex')]));
  assert.equal(f.expect(await f.request('/auth/reset-password',post({token:reset,password:'Changed@12345'},null)),400).data.code,'INVALID_TOKEN');
  assert.equal((await f.request('/auth/me',{cookie:registered.cookie})).data.user.verified,false);
  await f.login(email,'Customer@12345');
});

test('[IT-AUTH-005] repeated login attempts are throttled and forwarding headers cannot bypass the default quota',async t => {
  const f = await createFeatureFixture(t,{disableRateLimit:false});
  let limited,denied = 0;
  for (let i=0;i<41;i++) {
    const response = await f.request('/auth/login',post({email:'absent@example.test',password:null},null));
    if (response.status === 429) {limited=response;break;}
    f.expect(response,401);denied++;
  }
  assert.ok(denied>0);assert.ok(limited,'auth quota must block sustained attempts');
  assert.ok(Number(limited.headers.get('retry-after'))>0);
  assert.ok(limited.headers.get('ratelimit'));
  f.expect(await f.request('/auth/login',{...post({email:f.env.ADMIN_EMAIL,password:f.env.ADMIN_PASSWORD},null),headers:{'X-Forwarded-For':'203.0.113.123'}}),429);
  f.expect(await f.request('/health',{cookie:null}),200);
  f.expect(await f.request('/admin/users'),200);
});

test('[IT-HIST-001] matching email or phone never transfers guest or another account bookings into customer history',async t => {
  const f = await createFeatureFixture(t),one = await f.customer('history-one'),two = await f.customer('history-two'),item = await f.trip();
  const owned = await f.reserve(item,{cookie:one.cookie,seats:['A01'],email:one.user.email});
  await f.reserve(item,{cookie:two.cookie,seats:['A02'],email:one.user.email});
  await f.reserve(item,{seats:['A03'],email:one.user.email});
  const history = f.expect(await f.request('/bookings',{cookie:one.cookie}),200).data.bookings;
  assert.deepEqual(history.map(row=>row.code),[owned.code]);
  const second = f.expect(await f.request('/bookings',{cookie:two.cookie}),200).data.bookings;
  assert.equal(second.length,1);assert.notEqual(second[0].code,owned.code);
  assert.equal((await f.request('/bookings',{cookie:null})).status,401);
});

test('[IT-HIST-002] roundtrip order history uses account ownership and does not inherit guest orders with identical contact',async t => {
  const f = await createFeatureFixture(t),one = await f.customer('order-one'),two = await f.customer('order-two'),outward = await f.trip(),returning = await f.trip({from:'da-lat',to:'ho-chi-minh',date:addDays(f.today,3)});
  const body = seat => ({...f.bookingBody(outward,{email:one.user.email}),legs:[{tripId:outward.id,seats:[seat],pickup:outward.pickupPoints[0],dropoff:outward.dropoffPoints[0]},{tripId:returning.id,seats:[seat],pickup:returning.pickupPoints[0],dropoff:returning.dropoffPoints[0]}]});
  const owned = f.expect(await f.request('/orders',post(body('A01'),one.cookie)),201).data.order;
  const other = f.expect(await f.request('/orders',post(body('A02'),two.cookie)),201).data.order;
  await f.request('/orders',post(body('A03'),null)).then(result=>f.expect(result,201));
  const first = f.expect(await f.request('/orders',{cookie:one.cookie}),200).data.orders;
  const second = f.expect(await f.request('/orders',{cookie:two.cookie}),200).data.orders;
  assert.deepEqual(first.map(order=>order.code),[owned.code]);assert.deepEqual(second.map(order=>order.code),[other.code]);
  assert.deepEqual(new Set(first[0].bookings.map(booking=>booking.code)),new Set(owned.bookings.map(booking=>booking.code)));
  assert.equal((await f.request('/orders',{cookie:null})).status,401);
});

test('[IT-REV-001] invalid review input leaves reputation unchanged and simultaneous duplicates produce one verified public review',async t => {
  const f = await createFeatureFixture(t),owner = await f.customer('review-owner'),booking = await f.paidCompleted(owner.cookie),body = reviewBody(booking),op = await f.company();
  for (const extra of [{rating:0},{rating:6},{rating:1.5},{rating:NaN},{comment:'short'}]) f.expect(await f.request('/reviews',post({...body,...extra},owner.cookie)),400);
  const unchanged = f.expect(await f.request('/operators/'+op.id,{cookie:null}),200).data;
  assert.equal(unchanged.operator.reviewCount,0);assert.deepEqual(unchanged.reviews,[]);
  const concurrent = await Promise.all([f.request('/reviews',post(body,owner.cookie)),f.request('/reviews',post(body,owner.cookie))]);
  assert.deepEqual(concurrent.map(result=>result.status).sort(),[201,409]);
  assert.equal(concurrent.find(result=>result.status===409).data.code,'ALREADY_REVIEWED');
  const visible = f.expect(await f.request('/operators/'+op.id,{cookie:null}),200).data;
  assert.equal(visible.operator.reviewCount,1);assert.equal(visible.operator.rating,5);assert.equal(visible.reviews.length,1);assert.equal(visible.reviews[0].verifiedBooking,true);
  const exposed = JSON.stringify(visible.reviews);
  for (const secret of [owner.user.email,owner.user.phone,owner.user.id,booking.code]) assert.ok(!exposed.includes(secret));
});

test('[IT-REV-002] cancellation winning a queued race makes the pending review ineligible',async t => {
  const f = await createFeatureFixture(t),owner = await f.customer('cancel-review-owner'),booking = await f.paidCompleted(owner.cookie);
  let release,started,queuedCancel,queuedReview;
  const gate = new Promise(resolve=>{release=resolve;}),ready = new Promise(resolve=>{started=resolve;}),cancelQueued = new Promise(resolve=>{queuedCancel=resolve;}),reviewQueued = new Promise(resolve=>{queuedReview=resolve;});
  const original = f.db.transaction;
  const blocker = original(async () => {started();await gate;});
  await ready;
  let queued = 0;
  f.db.transaction = work => {queued++;if(queued===1)queuedCancel();if(queued===2)queuedReview();return original(work);};
  let cancelled,pendingReview;
  try {
    cancelled = f.request('/admin/bookings/'+booking.code,{method:'PATCH',cookie:f.adminCookie,body:{status:'cancelled'}});
    await cancelQueued;
    pendingReview = f.request('/reviews',post(reviewBody(booking),owner.cookie));
    await reviewQueued;
  } finally {f.db.transaction=original;release();await blocker;}
  f.expect(await cancelled,200);
  const result = f.expect(await pendingReview,409);
  assert.equal(result.data.code,'REVIEW_NOT_ELIGIBLE');
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM reviews')).n),0);
});

test('[IT-REV-003] reviews wait for arrival and reject sample provenance even when a booking is confirmed and paid',async t => {
  const f = await createFeatureFixture(t),owner = await f.customer('arrival-review-owner'),booking = await f.paidCompleted(owner.cookie);
  const departure = new Date(Date.now()-3600000+7*3600000).toISOString();
  await f.db.transaction(async tx => {
    const snapshot = JSON.parse((await tx.get('SELECT data FROM bookings WHERE code=?',[booking.code])).data);
    snapshot.trip.date = departure.slice(0,10);snapshot.trip.departureTime = departure.slice(11,16);snapshot.trip.durationMinutes = 120;
    await tx.run('UPDATE bookings SET data=? WHERE code=?',[JSON.stringify(snapshot),booking.code]);
  });
  const underway = f.expect(await f.request('/reviews',post(reviewBody(booking),owner.cookie)),409);
  assert.equal(underway.data.code,'REVIEW_NOT_ELIGIBLE');
  await f.complete(booking);
  await f.db.transaction(async tx => {
    const snapshot = JSON.parse((await tx.get('SELECT data FROM bookings WHERE code=?',[booking.code])).data);
    snapshot.source = 'demo';snapshot.trip.source = 'demo';
    await tx.run('UPDATE bookings SET data=? WHERE code=?',[JSON.stringify(snapshot),booking.code]);
  });
  const sample = f.expect(await f.request('/reviews',post(reviewBody(booking),owner.cookie)),409);
  assert.equal(sample.data.code,'REVIEW_NOT_ELIGIBLE');
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM reviews')).n),0);
});

test('[IT-PROMO-001] admin promotion edit and soft-delete change public eligibility without consuming allowance',async t => {
  const f = await createFeatureFixture(t),item = await f.trip();
  const created = f.expect(await f.request('/admin/promotions',post(promotionBody({code:'contract10'}),f.adminCookie)),201).data.promotion;
  assert.equal(created.code,'CONTRACT10');
  const quote = body=>f.request('/promotions/quote',post({legs:[{tripId:item.id,seats:['A01']}],phone:'0901234567',couponCode:'contract10',...body},null));
  assert.equal(f.expect(await quote(),200).data.discount,25000);
  f.expect(await f.request('/admin/promotions/contract10',{method:'PATCH',body:{code:'IGNORED_NEW_CODE',value:20}}),200);
  assert.equal(f.expect(await quote(),200).data.discount,50000);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM promotion_uses')).n),0);
  f.expect(await f.request('/admin/promotions/CONTRACT10',{method:'DELETE'}),200);
  assert.deepEqual(f.expect(await f.request('/promotions',{cookie:null}),200).data.promotions,[]);
  assert.equal(f.expect(await quote(),400).data.code,'INVALID_COUPON');
  const retained = f.expect(await f.request('/admin/promotions'),200).data.promotions;
  assert.equal(retained.length,1);assert.equal(retained[0].active,false);assert.equal(retained[0].code,'CONTRACT10');
  f.expect(await f.request('/admin/promotions/CONTRACT10',{method:'PATCH',body:{active:true}}),200);
  assert.equal(f.expect(await f.request('/promotions',{cookie:null}),200).data.promotions.length,1);
  f.expect(await f.request('/admin/promotions/CONTRACT10',{method:'PATCH',body:{startsAt:'2098-01-01T00:00:00Z'}}),200);
  assert.deepEqual(f.expect(await f.request('/promotions',{cookie:null}),200).data.promotions,[]);
  assert.equal(f.expect(await quote(),400).data.code,'COUPON_EXPIRED');
  f.expect(await f.request('/admin/promotions/CONTRACT10',{method:'PATCH',body:{startsAt:'2000-01-01T00:00:00Z',expiresAt:'2001-01-01T00:00:00Z'}}),200);
  assert.deepEqual(f.expect(await f.request('/promotions',{cookie:null}),200).data.promotions,[]);
  assert.equal(f.expect(await quote(),400).data.code,'COUPON_EXPIRED');
});

test('[IT-PROMO-002] invalid references and windows roll back promotion creation and operator access is denied before mutation',async t => {
  const f = await createFeatureFixture(t),staff = await f.staff(),login = await f.login(staff.email,'StaffTest@12345');
  for (const extra of [{active:'false'},{roundTripOnly:1},{operatorIds:['unknown-operator']},{routeIds:['ho-chi-minh--ho-chi-minh']},{routeIds:['ho-chi-minh--da-lat','ho-chi-minh--da-lat']},{startsAt:'2027-01-01T10:00:00',expiresAt:'2027-02-01T10:00:00'},{startsAt:'2027-02-01T10:00:00Z',expiresAt:'2027-01-01T10:00:00Z'}]) f.expect(await f.request('/admin/promotions',post(promotionBody(extra),f.adminCookie)),400);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM promotions')).n),0);
  assert.equal(Number((await f.db.get("SELECT COUNT(*) AS n FROM admin_audit_events WHERE entity_type='promotion'")).n),0);
  for (const [route,method] of [['/admin/promotions','GET'],['/admin/promotions','POST'],['/admin/promotions/CONTRACT10','PATCH'],['/admin/promotions/CONTRACT10','DELETE']]) f.expect(await f.request(route,{method,cookie:login.cookie,...(method==='GET' ? {} : {body:promotionBody()})}),403);
});

test('[IT-PROMO-003] impossible calendar dates cannot silently shift a promotion window on create or edit',async t => {
  const f = await createFeatureFixture(t);
  const invalid = ['2027-02-30T00:00:00Z','2027-02-29T00:00:00Z','2028-04-31T00:00:00Z','2028-02-29T24:00:00Z','2028-02-29T12:00:00'];
  for (const startsAt of invalid) f.expect(await f.request('/admin/promotions',post(promotionBody({startsAt}),f.adminCookie)),400);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM promotions')).n),0);
  const created = f.expect(await f.request('/admin/promotions',post(promotionBody({startsAt:'2000-02-29T09:15+07:00'}),f.adminCookie)),201).data.promotion;
  assert.equal(created.startsAt,'2000-02-29T02:15:00.000Z');
  const before = (await f.db.get('SELECT data FROM promotions WHERE code=?',['CONTRACT10'])).data;
  for (const expiresAt of invalid) {
    f.expect(await f.request('/admin/promotions/CONTRACT10',{method:'PATCH',body:{expiresAt}}),400);
    assert.equal((await f.db.get('SELECT data FROM promotions WHERE code=?',['CONTRACT10'])).data,before);
  }
  const changed = f.expect(await f.request('/admin/promotions/CONTRACT10',{method:'PATCH',body:{startsAt:'2028-02-29T09:15:30.125+07:00',expiresAt:'2032-02-29T18:45+07:00'}}),200).data.promotion;
  assert.equal(changed.startsAt,'2028-02-29T02:15:30.125Z');
  assert.equal(changed.expiresAt,'2032-02-29T11:45:00.000Z');
});

test('[IT-ADMIN-001] staff accounts cannot acquire administrator role and unauthorized users cannot edit staff',async t => {
  const f = await createFeatureFixture(t),staff = await f.staff(),logged = await f.login(staff.email,'StaffTest@12345'),customer = await f.customer('no-admin-rights');
  const body = {fullName:'Tài khoản bị từ chối',email:'rejected-staff@example.test',phone:'0901234567',password:'StaffTest@12345',role:'admin'};
  f.expect(await f.request('/admin/users',post(body,f.adminCookie)),400);
  f.expect(await f.request('/admin/users/'+staff.id,{method:'PATCH',body:{role:'admin'}}),400);
  f.expect(await f.request('/admin/users',post({...body,role:'operator',operatorId:'missing-operator'},f.adminCookie)),400);
  for (const cookie of [null,logged.cookie,customer.cookie]) {
    f.expect(await f.request('/admin/users',{cookie}),403);
    f.expect(await f.request('/admin/users',post({...body,role:'customer'},cookie)),403);
    f.expect(await f.request('/admin/users/'+staff.id,{method:'PATCH',cookie,body:{active:false}}),403);
  }
  const unchanged = (await f.db.get('SELECT role,active FROM users WHERE id=?',[staff.id]));
  assert.equal(unchanged.role,'operator');assert.equal(unchanged.active,1);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM users WHERE email=?',[body.email])).n),0);
});

test('[IT-ADMIN-002] duplicate staff email creates and edits return conflict without changing identity or audit',async t => {
  const f = await createFeatureFixture(t),one = await f.staff(),two = await f.staff({fullName:'Nhân viên thứ hai',email:'feature-second@example.test'});
  const before = Number((await f.db.get('SELECT COUNT(*) AS n FROM admin_audit_events')).n);
  f.expect(await f.request('/admin/users',post({fullName:'Trùng nhân viên',email:one.email.toUpperCase(),phone:'0901234567',password:'StaffTest@12345',role:'customer'},f.adminCookie)),409);
  f.expect(await f.request('/admin/users/'+two.id,{method:'PATCH',body:{email:one.email.toUpperCase()}}),409);
  assert.equal((await f.db.get('SELECT email FROM users WHERE id=?',[two.id])).email,'feature-second@example.test');
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM users WHERE email=?',[one.email])).n),1);
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM admin_audit_events')).n),before);
});
