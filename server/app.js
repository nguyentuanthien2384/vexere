"use strict";

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const {openDatabase,DatabaseSessionStore} = require('./database');
const {busTypes,routes,todayVietnam,addDays,makeSeats,tripToRow,INSERT_TRIP,initializeCatalog} = require('./catalog');
const payments = require('./payments');
const {createMailer} = require('./mailer');
const {parseCsv} = require('./import');
const {createBookingFeatures,BOOKING_LEAD_MINUTES}=require('./booking-features');
const {initializeDemoFixtures}=require('./demo-fixtures');
const {adminStats,dateRange,addDateClauses,bookingTripField}=require('./admin-analytics');
const {getIntegrationStatus}=require('./integration-status');
const {fetchOperatorFeed}=require('./operator-feed');
const {createWalletPayments}=require('./wallet-payments');

class ApiError extends Error { constructor(status,message,code='VALIDATION_ERROR') { super(message); this.status = status; this.code = code; } }
function fail(status,message,code) { throw new ApiError(status,message,code); }
const endpoint = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);
const nowISO = () => new Date().toISOString();
const json = value => JSON.stringify(value);
function parse(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function clean(value,max=200) { return typeof value === 'string' ? value.trim().slice(0,max) : ''; }
function phone(value) { return clean(value,30).replace(/[\s().-]/g,'').replace(/^\+84/,'0'); }
function validPhone(value) { return /^0\d{9,10}$/.test(value); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254; }
function passwordValid(value) { return typeof value === 'string' && value.length >= 10 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !isNaN(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value; }
function safeUser(row) { return {id:row.id,fullName:row.full_name,email:row.email,phone:row.phone,role:row.role,operatorId:row.operator_id || null,verified:Boolean(row.verified),active:row.active === 1}; }
function pageArgs(query) { return {page:Math.max(1,Math.min(10000,parseInt(query.page,10) || 1)),limit:Math.max(1,Math.min(100,parseInt(query.limit,10) || 20))}; }
function money(value) { return new Intl.NumberFormat('vi-VN').format(value)+' ₫'; }

async function createApi(options={}) {
  const env = options.env || process.env;
  const seedDemo = options.seedDemo ?? (env.NODE_ENV !== 'production' && env.SEED_DEMO !== 'false');
  if (env.NODE_ENV === 'production' && seedDemo) throw new Error('Production cannot enable sample inventory. Set SEED_DEMO=false.');
  const db = options.db || await openDatabase({env,dataDir:options.dataDir});
  await initializeCatalog(db,{env,seedDemo,days:options.seedDays || 30});
  await initializeDemoFixtures(db,{env,seedDemo});
  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    const email = env.ADMIN_EMAIL.trim().toLowerCase();
    if (!validEmail(email) || !passwordValid(env.ADMIN_PASSWORD)) throw new Error('ADMIN_EMAIL or ADMIN_PASSWORD is invalid; use a password of at least 10 characters with uppercase, lowercase and digit.');
    if (!await db.get('SELECT id FROM users WHERE email=?',[email])) {
      const hash = await bcrypt.hash(env.ADMIN_PASSWORD,12);
      await db.transaction(tx => tx.run('INSERT INTO users(id,full_name,email,phone,password_hash,role,verified,created_at) VALUES(?,?,?,?,?,?,1,?)',[crypto.randomUUID(),'Quản trị hệ thống',email,'',hash,'admin',nowISO()]));
    }
  }
  if (env.NODE_ENV === 'production') {
    for (const [email,password] of [['admin@ticket4t.vn','Admin@12345'],['khach@ticket4t.vn','Khach@12345'],['operator@ticket4t.vn','Nhaxe@12345']]) {
      const demoUser=await db.get('SELECT password_hash FROM users WHERE email=? AND active=1',[email]);
      if (demoUser && await bcrypt.compare(password,demoUser.password_hash)) { await db.close(); throw new Error('Production refuses active demo credentials. Use a fresh database or change/disable demo accounts before deployment.'); }
    }
    const administrator=await db.get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1");
    if (!Number(administrator.n)) { await db.close(); throw new Error('First production start requires ADMIN_EMAIL and ADMIN_PASSWORD to provision an administrator.'); }
  }
  const router = express.Router();
  const dummyPasswordHash=await bcrypt.hash(crypto.randomBytes(32).toString('hex'),12);
  const mail = createMailer(db,env,options.dataDir);
  const walletPayments=createWalletPayments({db,env,fail,fetchImpl:options.walletFetch,timeoutMs:options.walletTimeoutMs});
  const paymentMethods = [{id:'cash',name:'Thanh toán tại nhà xe',enabled:true},{id:'vnpay',name:'VNPAY',enabled:payments.configured(env)},...['momo','zalopay'].map(id=>({id,name:id==='momo' ? 'MoMo' : 'ZaloPay',enabled:walletPayments.configured(id)}))];
  const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
  const bookingCutoff = () => new Date(Date.now()+BOOKING_LEAD_MINUTES*60000).toISOString();

  router.use((req,res,next) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      req.body ??= {};
      if (typeof req.body !== 'object' || Array.isArray(req.body)) return next(new ApiError(400,'Dữ liệu yêu cầu phải là một đối tượng hợp lệ.'));
    }
    next();
  });

  router.use((req,res,next) => {
    (async () => {
      if (req.session?.userId) {
        const row = await db.get('SELECT * FROM users WHERE id=?',[req.session.userId]);
        if (row && row.active === 1 && Number(req.session.authVersion) === Number(row.auth_version)) req.user = safeUser(row);
        else { delete req.session.userId; delete req.session.authVersion; }
      }
    })().then(() => next(),next);
  });

  const requireUser = (req,res,next) => req.user ? next() : next(new ApiError(401,'Vui lòng đăng nhập.','UNAUTHENTICATED'));
  const requireStaff = (req,res,next) => ['admin','operator'].includes(req.user?.role) ? next() : next(new ApiError(403,'Bạn không có quyền quản lý.','FORBIDDEN'));
  const requireAdmin = (req,res,next) => req.user?.role === 'admin' ? next() : next(new ApiError(403,'Chỉ quản trị viên có quyền thực hiện.','FORBIDDEN'));
  function scope(req,operatorId) { if (req.user.role === 'operator' && req.user.operatorId !== operatorId) fail(403,'Chuyến xe thuộc nhà xe khác.','FORBIDDEN'); }
  async function staffActor(tx,req) {
    const row=await tx.get('SELECT * FROM users WHERE id=?'+lock,[req.user?.id || '']);
    if (!row || row.active!==1 || !['admin','operator'].includes(row.role) || Number(row.auth_version)!==Number(req.session?.authVersion)) fail(403,'Phiên quản lý đã thay đổi. Vui lòng đăng nhập lại.','FORBIDDEN');
    req.user=safeUser(row);return req.user;
  }
  async function adminAudit(tx,req,action,entityType,entityId,operatorId=null,data={}) {
    await tx.run('INSERT INTO admin_audit_events(id,actor_id,actor_name,actor_role,action,entity_type,entity_id,operator_id,created_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)',[crypto.randomUUID(),req.user.id,req.user.fullName,req.user.role,action,entityType,String(entityId),operatorId,nowISO(),json(data)]);
  }
  let features;

  async function expire(tx,tripId) {
    if (!tripId) {
      const rows=await tx.all("SELECT trip_id FROM bookings WHERE status='pending_payment' AND expires_at<=? UNION SELECT trip_id FROM seat_holds WHERE expires_at<=? ORDER BY trip_id",[nowISO(),nowISO()]);
      for (const row of rows) await tx.get('SELECT id FROM trips WHERE id=?'+lock,[row.trip_id]);
      for (const row of rows) await expire(tx,row.trip_id);
      return;
    }
    const suffix = tripId ? ' AND trip_id=?' : '';
    const params = [nowISO(),...(tripId ? [tripId] : [])];
    const expired=await tx.all("SELECT code FROM bookings WHERE status='pending_payment' AND expires_at<=?"+suffix,params);
    await tx.run("DELETE FROM reserved_seats WHERE booking_code IN (SELECT code FROM bookings WHERE status='pending_payment' AND expires_at<=?"+suffix+')',params);
    await tx.run("UPDATE bookings SET status='expired' WHERE status='pending_payment' AND expires_at<=?"+suffix,params);
    if (features) {await features.expireHolds(tx,tripId);for(const row of expired)await features.releasePromotion(tx,row.code);}
  }
  async function refreshExpired() { await db.transaction(tx => expire(tx)); }
  async function audit(tx,code,actor,event,data={}) { await tx.run('INSERT INTO booking_events(id,booking_code,actor,event,created_at,data) VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),code,actor,event,nowISO(),json(data)]); }
  function decorate(row) {
    const trip = parse(row.data);
    const op = row.operator_data ? parse(row.operator_data) : null;
    const bookingCutoffAt=new Date(Date.parse(row.departure_at)-BOOKING_LEAD_MINUTES*60000).toISOString();
    return {...trip,id:row.id,operatorId:row.operator_id,operatorName:op?.name || trip.operatorName,
      rating:op?.rating ?? trip.rating ?? 0,reviewCount:op?.reviewCount ?? 0,
      bookingCutoffAt,bookingOpen:row.active === 1 && row.operator_active === 1 && Date.parse(bookingCutoffAt)>Date.now(),
      active:row.active === 1,source:row.source,bookedSeats:Number(row.reserved_count || 0),heldSeats:Number(row.held_count || 0),occupiedSeats:Number(row.reserved_count || 0)+Number(row.held_count || 0),availableSeats:Math.max(0,row.total_seats-Number(row.reserved_count || 0)-Number(row.held_count || 0))};
  }
  const tripSelect = 'SELECT t.*,o.data AS operator_data,o.active AS operator_active,(SELECT COUNT(*) FROM reserved_seats s WHERE s.trip_id=t.id) AS reserved_count,(SELECT COUNT(*) FROM hold_seats hs WHERE hs.trip_id=t.id) AS held_count FROM trips t JOIN operators o ON o.id=t.operator_id';
  async function getTrip(id,tx=db,{activeOnly=false}={}) {
    const row = await tx.get(tripSelect+' WHERE t.id=?'+(activeOnly ? ' AND t.active=1 AND o.active=1' : ''),[id]);
    return row ? decorate(row) : null;
  }
  async function getBooking(code,tx=db) {
    const row = await tx.get('SELECT * FROM bookings WHERE code=?',[code]);
    if (!row) return null;
    const snapshot=parse(row.data);
    const trip=snapshot.trip || await getTrip(row.trip_id,tx);
    return {...snapshot,code:row.code,tripId:row.trip_id,userId:row.user_id,status:row.status,paymentStatus:row.payment_status,
      paymentMethod:row.payment_method,total:row.total,createdAt:row.created_at,expiresAt:row.expires_at,orderCode:row.order_code || snapshot.orderCode || null,
      couponCode:row.promo_code || snapshot.couponCode || null,source:snapshot.source || trip?.source || 'managed',trip};
  }
  function bookingOwner(req,booking) {
    return (req.user && booking.userId === req.user.id) || (validPhone(phone(req.query.phone || req.body?.phone)) && phone(req.query.phone || req.body?.phone) === booking.phone);
  }
  async function mode() { if (env.NODE_ENV === 'production') return 'managed'; const row = await db.get("SELECT COUNT(*) AS n FROM trips WHERE source='demo' AND active=1"); return Number(row.n) ? 'demo' : 'managed'; }
  async function tripSearch(query,req,admin=false) {
    await refreshExpired();
    const {page,limit} = pageArgs(query);
    const clauses = [], args = [];
    if (!admin) { clauses.push('t.active=1','o.active=1','t.departure_at>?'); args.push(bookingCutoff()); }
    if (!admin && env.NODE_ENV === 'production') clauses.push("t.source='managed'");
    if (admin && req.user.role === 'operator') { clauses.push('t.operator_id=?'); args.push(req.user.operatorId || ''); }
    for (const [param,column] of [['from','from_id'],['to','to_id'],['date','date'],['operator','operator_id'],['type','type']]) {
      if (query[param]) { clauses.push('t.'+column+'=?'); args.push(clean(query[param])); }
    }
    if (query.date && !validDate(query.date)) fail(400,'Ngày đi không hợp lệ.');
    for (const [param,op] of [['minPrice','>='],['maxPrice','<=']]) if (query[param] !== undefined && query[param] !== '') {
      const value = Number(query[param]); if (!Number.isFinite(value) || value < 0) fail(400,'Khoảng giá không hợp lệ.');
      clauses.push('t.price'+op+'?'); args.push(value);
    }
    const times = {morning:['06:00','12:00'],afternoon:['12:00','18:00'],evening:['18:00','24:00'],night:['00:00','06:00']};
    if (query.time && times[query.time]) { clauses.push('t.departure_time>=? AND t.departure_time<?'); args.push(...times[query.time]); }
    for (const key of ['q','pickup','dropoff']) if (query[key]) {
      const jsonField=field => db.dialect === 'postgres' ? "COALESCE((t.data::jsonb->'"+field+"')::text,'')" : "COALESCE(json_extract(t.data,'$."+field+"'),'')";
      const field=key === 'q' ? '('+['pickupPoints','dropoffPoints','stops','operatorName','fromName','toName','amenities','typeName'].map(jsonField).join(' || ')+' || o.name)' : jsonField(key === 'pickup' ? 'pickupPoints' : 'dropoffPoints');
      if (db.dialect === 'postgres') {
        // PostgreSQL clusters using LC_CTYPE=C do not fold Vietnamese letters.
        // Explicit mapping makes the same search behavior portable across locales.
        const upper='ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ';
        clauses.push('LOWER(TRANSLATE('+field+',?,?)) LIKE ?');args.push(upper,upper.toLocaleLowerCase('vi'));
      } else clauses.push('vi_lower('+field+') LIKE ?');
      args.push('%'+clean(query[key],100).toLocaleLowerCase('vi')+'%');
    }
    const where = clauses.length ? ' WHERE '+clauses.join(' AND ') : '';
    const count = await db.get('SELECT COUNT(*) AS n FROM trips t JOIN operators o ON o.id=t.operator_id'+where,args);
    let order = query.sort === 'price' ? 't.price ASC,t.departure_at ASC' : 't.departure_at ASC,t.price ASC';
    const orderArgs=[];
    if (query.sort === 'rating') {
      const ops=await db.all('SELECT id,data FROM operators');
      if (ops.length) { order='CASE t.operator_id '+ops.map(op => {orderArgs.push(op.id,Number(parse(op.data).rating || 0)); return 'WHEN ? THEN ?';}).join(' ')+' ELSE 0 END DESC,t.departure_at ASC'; }
    }
    const rows = await db.all(tripSelect+where+' ORDER BY '+order+' LIMIT ? OFFSET ?',[...args,...orderArgs,limit,(page-1)*limit]);
    const trips = rows.map(decorate);
    return {trips,total:Number(count.n),page,pages:Math.ceil(Number(count.n)/limit)};
  }
  features=createBookingFeatures({db,env,fail,endpoint,clean,phone,validPhone,validEmail,getTrip,getBooking,bookingOwner,audit,adminAudit,staffActor,expire,refreshExpired,requireUser,requireAdmin,scope,payments,walletPayments,mail});
  features.installPublic(router);

  router.get('/health',endpoint(async (req,res) => { await db.get('SELECT 1 AS ok'); res.json({ok:true,database:db.dialect,dataMode:await mode()}); }));
  router.get('/demo-scenarios',endpoint(async(req,res)=>{if(env.NODE_ENV === 'production' || !seedDemo)fail(404,'Không tìm thấy.','NOT_FOUND');const row=await db.get('SELECT value FROM settings WHERE key=?',['demo_scenarios']);res.json(row ? parse(row.value) : {scenarios:[]});}));
  router.get('/locations',endpoint(async (req,res) => res.json({locations:await db.all('SELECT * FROM locations ORDER BY name')})));
  router.get('/bootstrap',endpoint(async (req,res) => {
    const locations = await db.all('SELECT * FROM locations ORDER BY name');
    const operatorRows = await db.all('SELECT data FROM operators WHERE active=1 ORDER BY name');
    const productionFilter=env.NODE_ENV === 'production' ? " AND t.source='managed'" : '';
    const cutoff=bookingCutoff();
    const counts = await db.get('SELECT COUNT(*) AS trips,COUNT(DISTINCT t.operator_id) AS operators,SUM(total_seats) AS seats FROM trips t JOIN operators o ON o.id=t.operator_id WHERE t.active=1 AND o.active=1 AND t.departure_at>?'+productionFilter,[cutoff]);
    const actualRoutes = await db.all('SELECT t.from_id,t.to_id,MIN(t.price) AS min_price,MIN(t.data) AS data FROM trips t JOIN operators o ON o.id=t.operator_id WHERE t.active=1 AND o.active=1 AND t.departure_at>?'+productionFilter+' GROUP BY t.from_id,t.to_id',[cutoff]);
    const rank={'ho-chi-minh':0,'ha-noi':1,'da-nang':2};
    actualRoutes.sort((a,b) => (rank[a.from_id] ?? 3)-(rank[b.from_id] ?? 3) || a.to_id.localeCompare(b.to_id));
    const popularRoutes = actualRoutes.slice(0,12).map(r => { const t=parse(r.data); return {id:r.from_id+'--'+r.to_id,from:r.from_id,to:r.to_id,fromName:t.fromName,toName:t.toName,image:locations.find(l => l.id === r.to_id)?.image || t.image,minPrice:r.min_price,durationMinutes:t.durationMinutes}; });
    res.json({locations,operators:operatorRows.map(row => parse(row.data)).filter(op => env.NODE_ENV !== 'production' || op.source !== 'demo'),busTypes,popularRoutes,
      stats:{trips:Number(counts.trips),operators:Number(counts.operators),routes:actualRoutes.length,seats:Number(counts.seats || 0)},
      today:todayVietnam(),dataMode:await mode(),paymentMethods,emailEnabled:Boolean(env.SMTP_HOST),
      provenance:seedDemo ? 'Dữ liệu mẫu được tạo để kiểm thử; không phải lịch hoặc giá của Vexere. Nhà xe cần nhập kho vé được xác thực để bán thật.' : 'Kho vé do nhà xe hoặc quản trị viên nhập; cần đối soát với nhà xe trước khi mở bán.'});
  }));
  router.get('/trips',endpoint(async (req,res) => res.json(await tripSearch({...req.query,date:req.query.date || todayVietnam()},req))));
  router.get('/trips/:id',endpoint(async (req,res) => {
    await refreshExpired();
    const trip = await getTrip(req.params.id,db,{activeOnly:true});
    if (!trip) fail(404,'Không tìm thấy chuyến xe.','NOT_FOUND');
    const occupied = await db.all('SELECT s.seat,b.status FROM reserved_seats s JOIN bookings b ON b.code=s.booking_code WHERE s.trip_id=?',[trip.id]);
    const states = Object.fromEntries(occupied.map(s => [s.seat,s.status === 'pending_payment' ? 'held' : 'booked']));
    const held=await db.all('SELECT s.seat,h.owner_key FROM hold_seats s JOIN seat_holds h ON h.hash=s.hold_hash WHERE s.trip_id=? AND h.expires_at>?',[trip.id,nowISO()]);
    const holds=Object.fromEntries(held.map(s=>[s.seat,s.owner_key]));
    if (env.NODE_ENV === 'production' && trip.source === 'demo') fail(404,'Không tìm thấy chuyến xe.','NOT_FOUND');
    res.json({...trip,seats:makeSeats(trip.type,trip.totalSeats).map(s => ({...s,price:trip.seatPrices?.[s.label] ?? trip.price,status:states[s.label] || (holds[s.label] ? 'held' : 'available'),ownHold:Boolean(holds[s.label] && features.ownsHold(req,holds[s.label]))}))});
  }));
  router.get('/operators',endpoint(async (req,res) => {
    const rows=await db.all('SELECT data FROM operators WHERE active=1 ORDER BY name'); res.json({operators:rows.map(r => parse(r.data)).filter(op => env.NODE_ENV !== 'production' || op.source !== 'demo')});
  }));
  router.get('/operators/:id',endpoint(async (req,res) => {
    const row=await db.get('SELECT data FROM operators WHERE id=? AND active=1',[req.params.id]);
    if (!row) fail(404,'Không tìm thấy nhà xe.','NOT_FOUND');
    if (env.NODE_ENV === 'production' && parse(row.data).source === 'demo') fail(404,'Không tìm thấy nhà xe.','NOT_FOUND');
    const operator=parse(row.data);
    const rows=await db.all('SELECT r.id,r.rating,r.title,r.comment,r.created_at,u.full_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.operator_id=? ORDER BY r.created_at DESC LIMIT 50',[req.params.id]);
    const reviews=rows.map(r => ({id:r.id,rating:r.rating,title:r.title,comment:r.comment,createdAt:r.created_at,authorName:r.full_name.split(' ')[0],verifiedBooking:true,source:'managed'}));
    if (operator.source === 'demo' && !reviews.length) reviews.push(
      {id:operator.id+'-sample-review-1',rating:5,title:'Nhận xét mẫu về tiện nghi',comment:'Nội dung minh họa: ghế thoải mái, xe có điều hòa và nước uống. Đây không phải đánh giá từ hành khách thật.',authorName:'Hành khách minh họa',createdAt:todayVietnam(),verifiedBooking:false,source:'demo'},
      {id:operator.id+'-sample-review-2',rating:4,title:'Nhận xét mẫu về điểm đón',comment:'Nội dung minh họa: nên có mặt trước 30 phút tại điểm đón. Dữ liệu dùng để kiểm thử giao diện đánh giá.',authorName:'Hành khách minh họa',createdAt:todayVietnam(),verifiedBooking:false,source:'demo'});
    res.json({operator,reviews});
  }));

  router.get('/auth/me',endpoint(async (req,res) => res.json({user:req.user || null})));
  async function establish(req,row) {
    if (!req.session) fail(500,'Phiên đăng nhập chưa được cấu hình.','SERVER_ERROR');
    const holdOwner=req.session.holdOwner;
    await new Promise((resolve,reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.userId = row.id;
    req.session.authVersion = row.auth_version;
    if (holdOwner) req.session.holdOwner=holdOwner;
    await new Promise((resolve,reject) => req.session.save(err => err ? reject(err) : resolve()));
  }
  async function issueToken(user,purpose) {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await db.transaction(async tx => {
      await tx.run('UPDATE auth_tokens SET used=1 WHERE user_id=? AND purpose=?',[user.id,purpose]);
      await tx.run('INSERT INTO auth_tokens(hash,user_id,purpose,expires_at) VALUES(?,?,?,?)',[hash,user.id,purpose,new Date(Date.now()+(purpose === 'reset' ? 3600000 : 86400000)).toISOString()]);
    });
    const base = (env.APP_URL || 'http://localhost:3000').replace(/\/$/,'');
    const url = base+'/#/'+(purpose === 'reset' ? 'reset-password' : 'verify')+'?token='+token;
    return mail({to:user.email,sensitive:true,subject:purpose === 'reset' ? 'Đặt lại mật khẩu Ticket4T' : 'Xác minh email Ticket4T',text:'Xin chào '+user.full_name+'\nMở liên kết: '+url+'\nLiên kết chỉ dùng một lần và có thời hạn. Nếu không yêu cầu, hãy bỏ qua email này.'});
  }
  router.post('/auth/register',endpoint(async (req,res) => {
    if (env.NODE_ENV === 'production' && !env.SMTP_HOST) fail(503,'Đăng ký cần được cấu hình dịch vụ email.','EMAIL_UNAVAILABLE');
    const fullName=clean(req.body.fullName,100),email=clean(req.body.email,254).toLowerCase(),mobile=phone(req.body.phone),password=req.body.password;
    if (fullName.length < 2 || !validEmail(email) || !validPhone(mobile)) fail(400,'Vui lòng nhập họ tên, email và số điện thoại hợp lệ.');
    if (!passwordValid(password)) fail(400,'Mật khẩu cần ít nhất 10 ký tự, có chữ hoa, chữ thường và chữ số.');
    const hash=await bcrypt.hash(password,12),id=crypto.randomUUID();
    try { await db.transaction(tx => tx.run('INSERT INTO users(id,full_name,email,phone,password_hash,role,verified,created_at) VALUES(?,?,?,?,?,?,0,?)',[id,fullName,email,mobile,hash,'customer',nowISO()])); }
    catch (error) { if (/unique|duplicate/i.test(error.message)) fail(409,'Email đã được đăng ký.','EMAIL_EXISTS'); throw error; }
    const row=await db.get('SELECT * FROM users WHERE id=?',[id]);
    const result=await issueToken(row,'verify');
    await establish(req,row);
    res.status(201).json({user:safeUser(row),message:result.development ? 'Tài khoản đã tạo. Email xác minh nằm trong hộp thư phát triển data/email-outbox.jsonl.' : result.delivered ? 'Tài khoản đã tạo. Vui lòng kiểm tra email để xác minh.' : 'Tài khoản đã tạo nhưng email chưa gửi được. Vui lòng dùng Gửi lại email xác minh.',emailDelivered:result.delivered});
  }));
  router.post('/auth/login',endpoint(async (req,res) => {
    const email=clean(req.body.email,254).toLowerCase();
    const row=await db.get('SELECT * FROM users WHERE email=?',[email]);
    const hash=row?.password_hash || dummyPasswordHash;
    const valid=typeof req.body.password === 'string' && req.body.password.length<=128 && await bcrypt.compare(req.body.password,hash);
    if (!row || row.active !== 1 || !valid) fail(401,'Email hoặc mật khẩu không đúng.','INVALID_CREDENTIALS');
    await establish(req,row); res.json({user:safeUser(row)});
  }));
  router.post('/auth/logout',endpoint(async (req,res) => {
    if (req.session) await new Promise((resolve,reject) => req.session.destroy(err => err ? reject(err) : resolve()));
    res.clearCookie('ticket4t.sid'); res.clearCookie('connect.sid'); res.json({message:'Đã đăng xuất.'});
  }));
  router.post('/auth/forgot-password',endpoint(async (req,res) => {
    if (env.NODE_ENV === 'production' && !env.SMTP_HOST) fail(503,'Dịch vụ khôi phục mật khẩu chưa được cấu hình.','EMAIL_UNAVAILABLE');
    const row=await db.get('SELECT * FROM users WHERE email=?',[clean(req.body.email,254).toLowerCase()]);
    if (row) await issueToken(row,'reset');
    res.json({message:'Nếu email đã đăng ký, liên kết khôi phục sẽ được gửi đến bạn.'});
  }));
  router.post('/auth/resend-verification',requireUser,endpoint(async (req,res) => {
    const result=!req.user.verified ? await issueToken(await db.get('SELECT * FROM users WHERE id=?',[req.user.id]),'verify') : {delivered:true};
    res.json({message:result.delivered ? 'Đã gửi email xác minh.' : result.development ? 'Email nằm trong hộp thư phát triển.' : 'Email chưa gửi được. Vui lòng thử lại sau.',emailDelivered:result.delivered});
  }));
  async function useToken(req,purpose) {
    const token=clean(req.body.token,100); if (!/^[a-f0-9]{64}$/.test(token)) fail(400,'Liên kết không hợp lệ hoặc đã hết hạn.','INVALID_TOKEN');
    const hash=crypto.createHash('sha256').update(token).digest('hex');
    const passwordHash=purpose === 'reset' ? await bcrypt.hash(req.body.password,12) : null;
    return db.transaction(async tx => {
      const row=await tx.get('SELECT * FROM auth_tokens WHERE hash=?'+lock,[hash]);
      if (!row || row.purpose !== purpose || row.used || row.expires_at<=nowISO()) fail(400,'Liên kết không hợp lệ hoặc đã hết hạn.','INVALID_TOKEN');
      if (purpose === 'reset') await tx.run('UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?',[passwordHash,row.user_id]);
      else await tx.run('UPDATE users SET verified=1 WHERE id=?',[row.user_id]);
      await tx.run('UPDATE auth_tokens SET used=1 WHERE user_id=? AND purpose=?',[row.user_id,purpose]);
      return row.user_id;
    });
  }
  router.post('/auth/reset-password',endpoint(async (req,res) => {
    if (!passwordValid(req.body.password)) fail(400,'Mật khẩu cần ít nhất 10 ký tự, có chữ hoa, chữ thường và chữ số.');
    await useToken(req,'reset'); res.json({message:'Đã đổi mật khẩu. Vui lòng đăng nhập lại.'});
  }));
  router.post('/auth/verify',endpoint(async (req,res) => { await useToken(req,'verify'); res.json({message:'Email đã được xác minh.'}); }));

  router.post('/bookings',endpoint(async (req,res) => {
    const result=await features.checkout(req,[req.body]),booking=result.bookings[0];
    const emailDelivery=result.replayed ? {delivered:false,skipped:true} : await features.notify(booking);
    let paymentUrl=payments.paymentUrl(booking,req,env),paymentError;
    if (['momo','zalopay'].includes(booking.paymentMethod) && booking.status==='pending_payment' && booking.paymentStatus==='pending') {
      try { paymentUrl=await walletPayments.createPaymentLink(booking,req); }
      catch (error) {
        // The reservation already committed. Return its recovery details even
        // when the provider response is missing; never hide a created booking.
        if (!(error instanceof ApiError)) throw error;
        paymentError={code:error.code,message:error.message};
      }
    }
    if (result.replayed) res.set('Idempotency-Replayed','true');
    res.status(201).json({booking,emailDelivery,...(paymentUrl ? {paymentUrl} : {}),...(paymentError ? {paymentError} : {}),...(result.replayed ? {replayed:true} : {})});
  }));
  router.post('/bookings/:code/payment-link',endpoint(async (req,res) => {
    const code=clean(req.params.code,30).toUpperCase();
    const initial=await getBooking(code);
    if (!initial || !bookingOwner(req,initial)) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
    const booking=await db.transaction(async tx=>{
      await tx.get('SELECT id FROM trips WHERE id=?'+lock,[initial.tripId]);
      await expire(tx,initial.tripId);
      const current=await getBooking(code,tx);
      if (!bookingOwner(req,current)) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
      return current;
    });
    if (!['vnpay','momo','zalopay'].includes(booking.paymentMethod) || booking.status !== 'pending_payment' || booking.paymentStatus !== 'pending' || !Number.isFinite(Date.parse(booking.expiresAt)) || Date.parse(booking.expiresAt)<=Date.now()) fail(409,'Đặt chỗ không còn chờ thanh toán trực tuyến.','PAYMENT_NOT_PAYABLE');
    if (['momo','zalopay'].includes(booking.paymentMethod)) return res.json({booking,paymentUrl:await walletPayments.createPaymentLink(booking,req)});
    if (!payments.configured(env)) fail(503,'VNPAY chưa được cấu hình. Vui lòng liên hệ nhà xe.','PAYMENT_UNAVAILABLE');
    if (!payments.acceptsSource(booking,env)) fail(409,'Đặt chỗ minh họa chỉ được thanh toán trên VNPAY sandbox.','DEMO_PAYMENT_BLOCKED');
    const paymentUrl=payments.paymentUrl(booking,req,env);
    if (!paymentUrl) fail(409,'Đặt chỗ đã hết thời gian thanh toán.','PAYMENT_NOT_PAYABLE');
    res.json({booking,paymentUrl});
  }));
  router.get('/bookings/lookup',endpoint(async (req,res) => {
    await refreshExpired();
    const booking=await getBooking(clean(req.query.code,30).toUpperCase());
    if (!booking || !validPhone(phone(req.query.phone)) || booking.phone !== phone(req.query.phone)) fail(404,'Không tìm thấy vé với mã và số điện thoại này.','NOT_FOUND');
    res.json({booking});
  }));
  router.get('/bookings',requireUser,endpoint(async (req,res) => {
    await refreshExpired();
    const rows=await db.all('SELECT code FROM bookings WHERE user_id=? ORDER BY created_at DESC LIMIT 100',[req.user.id]);
    const bookings=[]; for (const row of rows) bookings.push(await getBooking(row.code));
    res.json({bookings});
  }));
  async function cancelBooking(req,code,staff=false) {
    const initial=await db.get('SELECT trip_id FROM bookings WHERE code=?',[code]);
    if (!initial) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
    return db.transaction(async tx => {
      if (staff) await staffActor(tx,req);
      const tripRow=await tx.get('SELECT * FROM trips WHERE id=?'+lock,[initial.trip_id]);
      const row=await tx.get('SELECT * FROM bookings WHERE code=?'+lock,[code]);
      if (row.trip_id !== initial.trip_id) fail(409,'Vé vừa được đổi chuyến. Vui lòng tải lại.','CONFLICT');
      await expire(tx,initial.trip_id);
      const booking=await getBooking(code,tx);
      if (staff) scope(req,booking.trip?.operatorId || tripRow.operator_id); else if (!bookingOwner(req,booking)) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
      if (['cancelled','expired','refund_pending'].includes(booking.status)) return booking;
      if (!staff && new Date(tripRow.departure_at).getTime()<=Date.now()+2*3600000) fail(409,'Vé chỉ được hủy trước giờ khởi hành ít nhất 2 giờ.','CANCELLATION_CLOSED');
      const paid=row.payment_status === 'paid';
      await tx.run('UPDATE bookings SET status=?,payment_status=?,expires_at=NULL WHERE code=?',[paid ? 'refund_pending' : 'cancelled',paid ? 'refund_pending' : 'pending',code]);
      await tx.run('DELETE FROM reserved_seats WHERE booking_code=?',[code]);
      await features.releasePromotion(tx,code);
      await audit(tx,code,req.user?.id || 'guest',paid ? 'refund_requested' : 'cancelled');
      if (staff) await adminAudit(tx,req,'booking_cancelled','booking',code,booking.trip?.operatorId || tripRow.operator_id,{status:paid ? 'refund_pending' : 'cancelled',total:booking.total});
      return getBooking(code,tx);
    });
  }
  router.post('/bookings/:code/cancel',endpoint(async (req,res) => res.json({booking:await cancelBooking(req,clean(req.params.code,30).toUpperCase())})));
  router.post('/reviews',requireUser,endpoint(async (req,res) => {
    const code=clean(req.body.bookingCode,30).toUpperCase(),rating=Number(req.body.rating),title=clean(req.body.title,150),comment=clean(req.body.comment,2000);
    if (!Number.isInteger(rating) || rating<1 || rating>5 || comment.length<10) fail(400,'Đánh giá cần từ 1 đến 5 sao và nhận xét ít nhất 10 ký tự.');
    const booking=await getBooking(code);
    if (!booking || booking.userId !== req.user.id) fail(404,'Không tìm thấy vé của bạn.','NOT_FOUND');
    if (booking.paymentStatus !== 'paid' || booking.status !== 'confirmed' || booking.source === 'demo') fail(409,'Chỉ được đánh giá chuyến đi thực tế đã thanh toán.','REVIEW_NOT_ELIGIBLE');
    const departure=Date.parse(booking.trip.date+'T'+booking.trip.departureTime+':00+07:00');
    if (departure+booking.trip.durationMinutes*60000>Date.now()) fail(409,'Vui lòng đánh giá sau khi chuyến đi hoàn tất.','REVIEW_NOT_ELIGIBLE');
    await db.transaction(async tx => {
      const op=await tx.get('SELECT * FROM operators WHERE id=?'+lock,[booking.trip.operatorId]);
      if (await tx.get('SELECT id FROM reviews WHERE booking_code=?',[code])) fail(409,'Bạn đã đánh giá chuyến này.','ALREADY_REVIEWED');
      await tx.run('INSERT INTO reviews(id,booking_code,operator_id,user_id,rating,title,comment,created_at) VALUES(?,?,?,?,?,?,?,?)',[crypto.randomUUID(),code,booking.trip.operatorId,req.user.id,rating,title,comment,nowISO()]);
      const summary=await tx.get('SELECT COUNT(*) AS n,AVG(rating) AS average FROM reviews WHERE operator_id=?',[booking.trip.operatorId]);
      const data={...parse(op.data),rating:Math.round(Number(summary.average)*10)/10,reviewCount:Number(summary.n)};
      await tx.run('UPDATE operators SET data=? WHERE id=?',[json(data),booking.trip.operatorId]);
    }); res.status(201).json({message:'Cảm ơn bạn đã đánh giá chuyến đi.'});
  }));

  router.get('/payments/vnpay/ipn',endpoint(async (req,res) => {
    const params=payments.verifiedParams(req.query,env);
    if (!params) return res.json({RspCode:'97',Message:'Invalid signature'});
    const code=params.vnp_TxnRef,initial=await db.get('SELECT trip_id FROM bookings WHERE code=?',[code]);
    if (!initial) return res.json({RspCode:'01',Message:'Order not found'});
    const result=await db.transaction(async tx => {
      await tx.get('SELECT id FROM trips WHERE id=?'+lock,[initial.trip_id]);
      const row=await tx.get('SELECT * FROM bookings WHERE code=?'+lock,[code]);
      if (row.payment_method !== 'vnpay') return {RspCode:'01',Message:'Order not found'};
      if (!/^\d+$/.test(params.vnp_Amount || '') || Number(params.vnp_Amount) !== row.total*100) return {RspCode:'04',Message:'Invalid amount'};
      const reference='vnpay:'+params.vnp_TransactionNo;
      if (['paid','refund_pending'].includes(row.payment_status) || await tx.get('SELECT reference FROM payments WHERE reference=?',[reference])) return {RspCode:'02',Message:'Order already confirmed'};
      const success=params.vnp_ResponseCode === '00' && params.vnp_TransactionStatus === '00';
      if (success && (!params.vnp_TransactionNo || params.vnp_TransactionNo === '0')) return {RspCode:'99',Message:'Invalid transaction'};
      if (!success) {
        if (row.status === 'pending_payment') {
          await tx.run("UPDATE bookings SET status='cancelled',expires_at=NULL WHERE code=?",[code]);
          await tx.run('DELETE FROM reserved_seats WHERE booking_code=?',[code]);
          await features.releasePromotion(tx,code);
          await audit(tx,code,'vnpay','payment_failed',{responseCode:params.vnp_ResponseCode});
        }
        return {RspCode:'00',Message:'Confirm success'};
      }
      // Late payment cannot reclaim an expired/reallocated seat. Record funds and queue refund.
      await expire(tx,initial.trip_id);
      const current=await tx.get('SELECT status FROM bookings WHERE code=?',[code]);
      const seats=await tx.get('SELECT COUNT(*) AS n FROM reserved_seats WHERE booking_code=?',[code]);
      const intended=parse(row.data).seats.length;
      const fulfil=current.status === 'pending_payment' && Number(seats.n) === intended;
      await tx.run('INSERT INTO payments(reference,booking_code,provider,amount,status,created_at,data) VALUES(?,?,?,?,?,?,?)',[reference,code,'vnpay',row.total,fulfil ? 'paid' : 'refund_pending',nowISO(),json(params)]);
      await tx.run('UPDATE bookings SET status=?,payment_status=?,expires_at=NULL WHERE code=?',[fulfil ? 'confirmed' : 'refund_pending',fulfil ? 'paid' : 'refund_pending',code]);
      await audit(tx,code,'vnpay',fulfil ? 'payment_verified' : 'late_payment_refund_required',{reference});
      return {RspCode:'00',Message:'Confirm success'};
    });
    res.json(result);
  }));
  router.get('/payments/vnpay/return',endpoint(async (req,res) => {
    const params=payments.verifiedParams(req.query,env);
    if (!params) return res.status(400).send('Chữ ký thanh toán không hợp lệ.');
    // Only IPN confirms payment. Browser return must never mutate inventory or ledger.
    res.redirect('/#/lookup?code='+encodeURIComponent(params.vnp_TxnRef));
  }));

  async function settleWallet(notification) {
    if (notification.pending) return;
    const {bookingCode:code,provider,reference,amount,success}=notification;
    const initial=await db.get('SELECT trip_id FROM bookings WHERE code=?',[code]);
    if (!initial) fail(404,'Không tìm thấy giao dịch.','NOT_FOUND');
    await db.transaction(async tx=>{
      await tx.get('SELECT id FROM trips WHERE id=?'+lock,[initial.trip_id]);
      const row=await tx.get('SELECT * FROM bookings WHERE code=?'+lock,[code]);
      if (row.payment_method!==provider || row.total!==amount) fail(400,'Thông tin thanh toán không khớp.','PAYMENT_MISMATCH');
      if (db.dialect==='postgres') await tx.get('SELECT pg_advisory_xact_lock(hashtext(?))',['payment:'+reference]);
      const prior=await tx.get('SELECT booking_code FROM payments WHERE reference=?',[reference]);
      if (prior && prior.booking_code!==code) fail(409,'Mã giao dịch đã được sử dụng.','PAYMENT_CONFLICT');
      if (prior || ['paid','refund_pending','refunded'].includes(row.payment_status)) return;
      if (!success) {
        if (row.status==='pending_payment') {
          await tx.run("UPDATE bookings SET status='cancelled',expires_at=NULL WHERE code=?",[code]);
          await tx.run('DELETE FROM reserved_seats WHERE booking_code=?',[code]);
          await features.releasePromotion(tx,code);
          await audit(tx,code,provider,'payment_failed');
        }
        return;
      }
      await expire(tx,initial.trip_id);
      const current=await tx.get('SELECT status FROM bookings WHERE code=?',[code]);
      const seats=await tx.get('SELECT COUNT(*) AS n FROM reserved_seats WHERE booking_code=?',[code]);
      const fulfil=current.status==='pending_payment' && Number(seats.n)===parse(row.data).seats.length;
      await tx.run('INSERT INTO payments(reference,booking_code,provider,amount,status,created_at,data) VALUES(?,?,?,?,?,?,?)',[reference,code,provider,amount,fulfil ? 'paid' : 'refund_pending',nowISO(),json({reference,amount})]);
      await tx.run('UPDATE bookings SET status=?,payment_status=?,expires_at=NULL WHERE code=?',[fulfil ? 'confirmed' : 'refund_pending',fulfil ? 'paid' : 'refund_pending',code]);
      await audit(tx,code,provider,fulfil ? 'payment_verified' : 'late_payment_refund_required',{reference});
    });
  }
  router.post('/payments/momo/ipn',endpoint(async(req,res)=>{
    const notification=await walletPayments.verifyNotification('momo',req.body);
    if (!notification) fail(400,'Thông báo thanh toán không hợp lệ.','INVALID_PAYMENT_SIGNATURE');
    await settleWallet(notification);
    res.status(204).end();
  }));
  router.post('/payments/zalopay/ipn',endpoint(async(req,res)=>{
    const notification=await walletPayments.verifyNotification('zalopay',req.body);
    if (!notification) return res.json({return_code:-1,return_message:'Invalid callback'});
    try { await settleWallet(notification); }
    catch { return res.json({return_code:0,return_message:'Retry callback'}); }
    res.json({return_code:1,return_message:'success'});
  }));
  for (const provider of ['momo','zalopay']) router.get('/payments/'+provider+'/return',endpoint(async(req,res)=>{
    // The browser only resumes lookup. Signed server callbacks own settlement.
    res.redirect('/#/lookup?code='+encodeURIComponent(clean(req.query.code,30).toUpperCase()));
  }));

  router.use('/admin',requireStaff);
  router.get('/admin/integrations',requireAdmin,endpoint(async (req,res) => res.json(await getIntegrationStatus({db,env}))));
  features.installAdmin(router);
  router.get('/admin/audit',endpoint(async (req,res) => {
    const {page,limit}=pageArgs(req.query),range=dateRange(req.query,fail),clauses=[],args=[];
    if (req.user.role==='operator') {clauses.push('e.operator_id=?');args.push(req.user.operatorId || '');}
    for (const [param,column] of [['actor','actor_id'],['action','action'],['entityType','entity_type'],['entityId','entity_id'],['operator','operator_id']]) if (req.query[param]) {clauses.push('e.'+column+'=?');args.push(clean(req.query[param]));}
    addDateClauses(clauses,args,'e.created_at',range);
    if (req.query.q) {const search='%'+clean(req.query.q,100).toLocaleLowerCase('vi')+'%',lower=db.dialect==='postgres' ? 'LOWER' : 'vi_lower';clauses.push('('+lower+'(e.actor_name) LIKE ? OR '+lower+'(e.entity_id) LIKE ? OR '+lower+'(e.action) LIKE ?)');args.push(search,search,search);}
    const where=clauses.length ? ' WHERE '+clauses.join(' AND ') : '',count=await db.get('SELECT COUNT(*) AS n FROM admin_audit_events e'+where,args);
    const rows=await db.all('SELECT e.* FROM admin_audit_events e'+where+' ORDER BY e.created_at DESC,e.id DESC LIMIT ? OFFSET ?',[...args,limit,(page-1)*limit]);
    res.json({events:rows.map(row=>({id:row.id,actorId:row.actor_id,actorName:row.actor_name,actorRole:row.actor_role,action:row.action,entityType:row.entity_type,entityId:row.entity_id,operatorId:row.operator_id,createdAt:row.created_at,data:parse(row.data)})),total:Number(count.n),page,pages:Math.ceil(Number(count.n)/limit)});
  }));
  router.get('/admin/users',requireAdmin,endpoint(async (req,res) => {
    const rows=await db.all('SELECT * FROM users ORDER BY created_at DESC LIMIT 1000'); res.json({users:rows.map(safeUser)});
  }));
  async function validateStaff(input,current={},tx=db) {
    if (input.active!==undefined && typeof input.active!=='boolean') fail(400,'Trạng thái hoạt động phải là true hoặc false.');
    const fullName=clean(input.fullName ?? current.full_name,100),email=clean(input.email ?? current.email,254).toLowerCase(),mobile=phone(input.phone ?? current.phone);
    const role=input.role ?? current.role ?? 'operator',operatorId=role === 'operator' ? clean(input.operatorId ?? current.operator_id) : null;
    if (fullName.length<2 || !validEmail(email) || !validPhone(mobile)) fail(400,'Họ tên, email và số điện thoại không hợp lệ.');
    if (!['customer','operator'].includes(role)) fail(400,'Chỉ được tạo khách hàng hoặc nhân viên nhà xe.');
    if (role === 'operator' && !(current.id && input.active === false && operatorId === current.operator_id) && !await tx.get('SELECT id FROM operators WHERE id=? AND active=1'+(tx===db ? '' : lock),[operatorId])) fail(400,'Cần chọn nhà xe đang hoạt động cho tài khoản nhân viên.');
    if ((!current.id || input.password !== undefined) && !passwordValid(input.password)) fail(400,'Mật khẩu cần ít nhất 10 ký tự, có chữ hoa, chữ thường và chữ số.');
    return {id:current.id || crypto.randomUUID(),fullName,email,phone:mobile,role,operatorId,active:input.active === undefined ? current.active !== 0 : Boolean(input.active),passwordHash:input.password !== undefined ? await bcrypt.hash(input.password,12) : current.password_hash};
  }
  router.post('/admin/users',requireAdmin,endpoint(async (req,res) => {
    const user=await validateStaff(req.body);
    await db.transaction(async tx => {await staffActor(tx,req);if(req.user.role!=='admin')fail(403,'Chỉ quản trị viên có quyền thực hiện.','FORBIDDEN');if(user.role==='operator' && !await tx.get('SELECT id FROM operators WHERE id=? AND active=1'+lock,[user.operatorId]))fail(400,'Cần chọn nhà xe đang hoạt động cho tài khoản nhân viên.');await tx.run('INSERT INTO users(id,full_name,email,phone,password_hash,role,operator_id,verified,active,created_at) VALUES(?,?,?,?,?,?,?,1,?,?)',[user.id,user.fullName,user.email,user.phone,user.passwordHash,user.role,user.operatorId,user.active ? 1 : 0,nowISO()]);await adminAudit(tx,req,'user_created','user',user.id,null,{role:user.role,operatorId:user.operatorId,active:user.active});});
    res.status(201).json({user:safeUser(await db.get('SELECT * FROM users WHERE id=?',[user.id]))});
  }));
  router.patch('/admin/users/:id',requireAdmin,endpoint(async (req,res) => {
    const user=await db.transaction(async tx => {
      await staffActor(tx,req);if(req.user.role!=='admin')fail(403,'Chỉ quản trị viên có quyền thực hiện.','FORBIDDEN');
      const current=await tx.get('SELECT * FROM users WHERE id=?'+lock,[req.params.id]);if(!current)fail(404,'Không tìm thấy tài khoản.','NOT_FOUND');
      if(current.role==='admin')fail(403,'Tài khoản quản trị được cấu hình riêng và không được thay đổi tại chức năng này.','FORBIDDEN');
      const user=await validateStaff(req.body,current,tx);await tx.run('UPDATE users SET full_name=?,email=?,phone=?,password_hash=?,role=?,operator_id=?,active=?,auth_version=auth_version+1 WHERE id=?',[user.fullName,user.email,user.phone,user.passwordHash,user.role,user.operatorId,user.active ? 1 : 0,user.id]);
      await adminAudit(tx,req,'user_updated','user',user.id,null,{role:user.role,operatorId:user.operatorId,active:user.active,passwordChanged:req.body.password!==undefined});return user;
    });res.json({user:safeUser(await db.get('SELECT * FROM users WHERE id=?',[user.id]))});
  }));
  router.get('/admin/stats',endpoint(async (req,res) => {
    await refreshExpired();res.json(await adminStats({db,user:req.user,query:req.query,fail,paymentMethods,dataMode:await mode()}));
  }));
  router.post('/admin/bookings',endpoint(async(req,res)=>{const result=await features.checkout(req,[req.body],{staff:true});res.status(201).json({booking:result.bookings[0]});}));
  router.get('/admin/trips',endpoint(async (req,res) => res.json(await tripSearch(req.query,req,true))));
  router.get('/admin/operators',endpoint(async (req,res) => {
    const rows=await db.all('SELECT * FROM operators'+(req.user.role === 'operator' ? ' WHERE id=?' : '')+' ORDER BY name',req.user.role === 'operator' ? [req.user.operatorId || ''] : []);
    res.json({operators:rows.map(r => ({...parse(r.data),active:r.active === 1}))});
  }));
  function operatorData(input,current={}) {
    if (input.active!==undefined && typeof input.active!=='boolean') fail(400,'Trạng thái hoạt động phải là true hoặc false.');
    const name=clean(input.name ?? current.name,120); if (name.length<2) fail(400,'Tên nhà xe cần ít nhất 2 ký tự.');
    const image=clean(input.image ?? current.image ?? '/images/chuyenxe/hoang-anh-1.jpg',500);
    if (!/^\/images\/[a-zA-Z0-9_\-/.]+$/.test(image)) fail(400,'Ảnh nhà xe phải là ảnh cục bộ trong /images/.');
    const mobile=phone(input.phone ?? current.phone),email=clean(input.email ?? current.email,254).toLowerCase();if((mobile && !validPhone(mobile)) || (email && !validEmail(email)))fail(400,'Số điện thoại hoặc email nhà xe không hợp lệ.');
    return {...current,id:current.id || 'op-'+crypto.randomUUID(),name,phone:mobile,email,
      description:clean(input.description ?? current.description,2000),image,rating:current.rating || 0,reviewCount:current.reviewCount || 0,source:current.source || 'managed',active:input.active === undefined ? current.active !== false : Boolean(input.active)};
  }
  router.post('/admin/operators',requireAdmin,endpoint(async (req,res) => {
    const op=operatorData(req.body);await db.transaction(async tx=>{await staffActor(tx,req);if(req.user.role!=='admin')fail(403,'Chỉ quản trị viên có quyền thực hiện.','FORBIDDEN');await tx.run('INSERT INTO operators(id,name,data,active) VALUES(?,?,?,?)',[op.id,op.name,json(op),op.active ? 1 : 0]);await adminAudit(tx,req,'operator_created','operator',op.id,op.id,{name:op.name,active:op.active});});res.status(201).json({operator:op});
  }));
  router.patch('/admin/operators/:id',endpoint(async (req,res) => {
    const op=await db.transaction(async tx=>{await staffActor(tx,req);scope(req,req.params.id);const row=await tx.get('SELECT data,active FROM operators WHERE id=?'+lock,[req.params.id]);if(!row)fail(404,'Không tìm thấy nhà xe.','NOT_FOUND');const op=operatorData(req.body,{...parse(row.data),active:row.active===1});if(req.user.role!=='admin' && op.active!==(row.active===1))fail(403,'Chỉ quản trị viên được bật hoặc ngừng hoạt động nhà xe.','FORBIDDEN');await tx.run('UPDATE operators SET name=?,data=?,active=? WHERE id=?',[op.name,json(op),op.active ? 1 : 0,op.id]);await adminAudit(tx,req,'operator_updated','operator',op.id,op.id,{name:op.name,active:op.active});return op;});res.json({operator:op});
  }));
  router.delete('/admin/operators/:id',requireAdmin,endpoint(async (req,res) => {
    const id=req.params.id;await db.transaction(async tx=>{await staffActor(tx,req);if(req.user.role!=='admin')fail(403,'Chỉ quản trị viên có quyền thực hiện.','FORBIDDEN');if(!await tx.get('SELECT id FROM operators WHERE id=?'+lock,[id]))fail(404,'Không tìm thấy nhà xe.','NOT_FOUND');await tx.run('UPDATE operators SET active=0 WHERE id=?',[id]);await adminAudit(tx,req,'operator_deactivated','operator',id,id);});res.json({message:'Nhà xe đã ngừng mở bán; dữ liệu lịch sử được giữ lại.'});
  }));
  async function validateTrip(input,current={},tx=db) {
    if (!input || typeof input!=='object' || Array.isArray(input)) fail(400,'Dữ liệu chuyến xe phải là một đối tượng.');
    if (input.active!==undefined && typeof input.active!=='boolean') fail(400,'Trạng thái hoạt động phải là true hoặc false.');
    const operatorId=clean(input.operatorId ?? current.operatorId),from=clean(input.from ?? current.from),to=clean(input.to ?? current.to);
    const opRow=await tx.get('SELECT * FROM operators WHERE id=?'+(tx===db ? '' : lock),[operatorId]);
    if (!opRow || !opRow.active) fail(400,'Nhà xe không hợp lệ hoặc đã ngừng hoạt động.');
    if (current.source !== 'demo' && parse(opRow.data).source === 'demo') fail(400,'Cần tạo nhà xe vận hành thật trước khi nhập kho vé thật. Nhà xe mẫu không được dùng làm nguồn bán thật.');
    const [origin,destination]=await Promise.all([tx.get('SELECT * FROM locations WHERE id=?',[from]),tx.get('SELECT * FROM locations WHERE id=?',[to])]);
    if (!origin || !destination || from === to) fail(400,'Điểm đi và điểm đến phải hợp lệ và khác nhau.');
    const date=clean(input.date ?? current.date),departureTime=clean(input.departureTime ?? current.departureTime);
    if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime)) fail(400,'Ngày hoặc giờ khởi hành không hợp lệ.');
    const scheduleChanged=!current.id || date!==current.date || departureTime!==current.departureTime || (input.active===true && current.active===false);
    if (scheduleChanged && (date < todayVietnam() || date > addDays(todayVietnam(),365))) fail(400,'Ngày mở bán cần trong 365 ngày tới.');
    if (scheduleChanged && new Date(date+'T'+departureTime+':00+07:00').getTime()<=Date.now()+BOOKING_LEAD_MINUTES*60000) fail(400,'Giờ khởi hành cần cách hiện tại ít nhất '+BOOKING_LEAD_MINUTES+' phút.');
    const type=busTypes.find(t => t.id === (input.type ?? current.type)); if (!type) fail(400,'Loại xe không hợp lệ.');
    const price=Number(input.price ?? current.price),totalSeats=Number(input.totalSeats ?? current.totalSeats ?? type.seats),durationMinutes=Number(input.durationMinutes ?? current.durationMinutes);
    if (!Number.isSafeInteger(price) || price<10000 || price>10000000 || !Number.isInteger(totalSeats) || totalSeats<1 || totalSeats>60 || !Number.isInteger(durationMinutes) || durationMinutes<30 || durationMinutes>2880) fail(400,'Giá vé, số ghế hoặc thời gian hành trình không hợp lệ.');
    const arrays={};
    for (const key of ['pickupPoints','dropoffPoints','amenities','policies']) {
      const values=input[key] ?? current[key] ?? (key === 'pickupPoints' ? ['Bến xe '+origin.name] : key === 'dropoffPoints' ? ['Bến xe '+destination.name] : []);
      if (!Array.isArray(values) || values.length>20 || values.some(x => typeof x !== 'string' || x.length>500) || ((key === 'pickupPoints' || key === 'dropoffPoints') && !values.length)) fail(400,'Danh sách '+key+' không hợp lệ.');
      arrays[key]=values.map(x => x.trim()).filter(Boolean); if ((key === 'pickupPoints' || key === 'dropoffPoints') && !arrays[key].length) fail(400,'Cần ít nhất một điểm đón và trả.');
    }
    const provenance=clean(input.provenance ?? current.provenance,2000); if (!provenance) fail(400,'Cần ghi nguồn cung cấp và căn cứ xác nhận lịch/giá (provenance).');
    const seatPrices=input.seatPrices ?? current.seatPrices ?? {};
    const seatLabels=makeSeats(type.id,totalSeats).map(s => s.label);
    if (!seatPrices || typeof seatPrices !== 'object' || Array.isArray(seatPrices) || Object.entries(seatPrices).some(([label,value]) => !seatLabels.includes(label) || !Number.isSafeInteger(value) || value<price || value>10000000)) fail(400,'Giá theo ghế phải hợp lệ và không thấp hơn giá niêm yết.');
    const departureMinutes=Number(departureTime.slice(0,2))*60+Number(departureTime.slice(3)),arrival=(departureMinutes+durationMinutes)%1440;
    const op=parse(opRow.data);
    return {...current,...arrays,id:current.id || 'trip-'+crypto.randomUUID(),operatorId,operatorName:op.name,rating:op.rating || 0,reviewCount:op.reviewCount || 0,
      from,to,fromName:origin.name,toName:destination.name,date,departureTime,type:type.id,typeName:type.name,price,totalSeats,durationMinutes,
      arrivalTime:String(Math.floor(arrival/60)).padStart(2,'0')+':'+String(arrival%60).padStart(2,'0'),arrivalDate:addDays(date,Math.floor((departureMinutes+durationMinutes)/1440)),
      image:op.image,seatPrices,source:current.source === 'demo' ? 'demo' : 'managed',provenance,active:input.active === undefined ? current.active !== false : Boolean(input.active)};
  }
  async function insertManaged(req,input,tx=db) { const trip=await validateTrip(input,{},tx); scope(req,trip.operatorId); return trip; }
  async function syncOperatorFeed(req,apply=false) {
    let feed;
    try { feed=await fetchOperatorFeed(env); }
    catch (error) { fail(error.status || 502,error.message,error.code || 'OPERATOR_FEED_UPSTREAM'); }
    if (apply && (!/^[a-f0-9]{64}$/.test(req.body.digest || '') || req.body.digest!==feed.digest)) fail(409,'Lịch đối tác đã thay đổi. Đọc lại và xem trước dữ liệu mới trước khi áp dụng.','OPERATOR_FEED_CHANGED');
    return db.transaction(async tx => {
      await staffActor(tx,req);
      if (req.user.role!=='admin') fail(403,'Chỉ quản trị viên có quyền đồng bộ API.','FORBIDDEN');
      if (db.dialect==='postgres') await tx.get('SELECT pg_advisory_xact_lock(hashtext(?))',['operator-feed:'+feed.operatorId]);
      // Lock in a stable order shared with checkout. Preview and apply both check
      // current reservations; the preview digest never bypasses these checks.
      for (const input of feed.trips) await tx.get('SELECT id FROM trips WHERE id=?'+lock,[input.id]);
      const changes=[],counts={created:0,updated:0,unchanged:0};
      const protectedFields=['operatorId','from','to','date','departureTime','type','totalSeats','price','seatPrices','durationMinutes','pickupPoints','dropoffPoints'];
      const contentFields=[...protectedFields,'amenities','policies','provenance','active'];
      for (const input of feed.trips) {
        const current=await getTrip(input.id,tx);
        if (current && (current.source!=='managed' || current.operatorId!==feed.operatorId || current.feedExternalId!==input.externalId)) fail(409,'Mã chuyến đối tác xung đột với kho hiện tại. Kiểm tra ánh xạ nhà xe.','OPERATOR_FEED_CONFLICT');
        const trip=await validateTrip(input,current || {id:input.id},tx);
        trip.feedExternalId=input.externalId;
        await expire(tx,trip.id);
        if (current) {
          const occupied=await tx.get('SELECT (SELECT COUNT(*) FROM reserved_seats WHERE trip_id=?) + (SELECT COUNT(*) FROM hold_seats WHERE trip_id=?) AS n',[trip.id,trip.id]);
          if (Number(occupied.n) && protectedFields.some(key=>json(current[key] ?? (key==='seatPrices' ? {} : undefined))!==json(trip[key]))) fail(409,'Chuyến '+input.externalId+' đã có khách hoặc đang giữ ghế; không thể cập nhật lịch, giá hay sơ đồ.','HAS_BOOKINGS');
        }
        const change=!current ? 'created' : contentFields.some(key=>json(current[key] ?? (key==='seatPrices' ? {} : []))!==json(trip[key] ?? (key==='seatPrices' ? {} : []))) ? 'updated' : 'unchanged';
        counts[change]++;
        changes.push({trip,change});
      }
      if (apply) {
        for (const {trip,change} of changes) {
          if (change==='created') await tx.run(INSERT_TRIP,tripToRow(trip));
          if (change==='updated') {
            const values=tripToRow(trip);
            await tx.run('UPDATE trips SET operator_id=?,from_id=?,to_id=?,date=?,departure_time=?,departure_at=?,price=?,total_seats=?,type=?,active=?,source=?,data=? WHERE id=?',[...values.slice(1),trip.id]);
          }
        }
        if (counts.created || counts.updated) await adminAudit(tx,req,'operator_feed_synced','import',feed.digest,feed.operatorId,{...counts,sourceReference:feed.sourceReference,tripIds:changes.filter(item=>item.change!=='unchanged').map(item=>item.trip.id)});
        return {sync:counts};
      }
      return {preview:{digest:feed.digest,sourceReference:feed.sourceReference,counts,trips:changes.map(({trip,change})=>({id:trip.id,externalId:trip.feedExternalId,fromName:trip.fromName,toName:trip.toName,date:trip.date,departureTime:trip.departureTime,price:trip.price,change}))}};
    });
  }
  router.post('/admin/integrations/operator-feed/preview',requireAdmin,endpoint(async (req,res)=>res.json(await syncOperatorFeed(req))));
  router.post('/admin/integrations/operator-feed/apply',requireAdmin,endpoint(async (req,res)=>res.json(await syncOperatorFeed(req,true))));
  router.post('/admin/trips',endpoint(async (req,res) => {
    const trip=await db.transaction(async tx=>{await staffActor(tx,req);const trip=await insertManaged(req,req.body,tx);await tx.run(INSERT_TRIP,tripToRow(trip));await adminAudit(tx,req,'trip_created','trip',trip.id,trip.operatorId,{date:trip.date,departureTime:trip.departureTime,from:trip.from,to:trip.to,price:trip.price,totalSeats:trip.totalSeats});return trip;});res.status(201).json({trip:await getTrip(trip.id)});
  }));
  router.patch('/admin/trips/:id',endpoint(async (req,res) => {
    await db.transaction(async tx => {
      await staffActor(tx,req);
      const row=await tx.get('SELECT id FROM trips WHERE id=?'+lock,[req.params.id]);if(!row)fail(404,'Không tìm thấy chuyến xe.','NOT_FOUND');
      const current=await getTrip(req.params.id,tx);scope(req,current.operatorId);
      const trip=await validateTrip(req.body,current,tx);scope(req,trip.operatorId);
      await expire(tx,trip.id);
      const booked=await tx.get('SELECT (SELECT COUNT(*) FROM reserved_seats WHERE trip_id=?) + (SELECT COUNT(*) FROM hold_seats WHERE trip_id=?) AS n',[trip.id,trip.id]);
      if (Number(booked.n) && ['operatorId','from','to','date','departureTime','type','totalSeats','price','seatPrices','durationMinutes','pickupPoints','dropoffPoints'].some(k => json(current[k] ?? (k === 'seatPrices' ? {} : undefined)) !== json(trip[k]))) fail(409,'Chuyến đã có khách; không được đổi lịch, giá, tuyến hoặc sơ đồ ghế.','HAS_BOOKINGS');
      const values=tripToRow(trip); await tx.run('UPDATE trips SET operator_id=?,from_id=?,to_id=?,date=?,departure_time=?,departure_at=?,price=?,total_seats=?,type=?,active=?,source=?,data=? WHERE id=?',[...values.slice(1),trip.id]);
      await adminAudit(tx,req,'trip_updated','trip',trip.id,trip.operatorId,{changedFields:Object.keys(req.body).filter(key=>json(current[key])!==json(trip[key])),active:trip.active});
    });
    res.json({trip:await getTrip(req.params.id)});
  }));
  router.delete('/admin/trips/:id',endpoint(async (req,res) => {
    await db.transaction(async tx => {await staffActor(tx,req);const row=await tx.get('SELECT id,operator_id FROM trips WHERE id=?'+lock,[req.params.id]);if(!row)fail(404,'Không tìm thấy chuyến xe.','NOT_FOUND');scope(req,row.operator_id);await tx.run('UPDATE trips SET active=0 WHERE id=?',[row.id]);await adminAudit(tx,req,'trip_deactivated','trip',row.id,row.operator_id);});
    res.json({message:'Chuyến đã ngừng mở bán. Đặt chỗ hiện có vẫn được giữ; liên hệ khách nếu thay đổi lịch.'});
  }));
  router.post('/admin/trips/:id/duplicate',endpoint(async (req,res) => {
    const trip=await db.transaction(async tx=>{await staffActor(tx,req);const row=await tx.get('SELECT id FROM trips WHERE id=?'+lock,[req.params.id]);if(!row)fail(404,'Không tìm thấy chuyến xe.','NOT_FOUND');const current=await getTrip(row.id,tx);scope(req,current.operatorId);const copy={...current,...req.body};delete copy.id;if(current.source==='demo')copy.provenance='Bản sao mẫu: '+current.provenance;const trip=await validateTrip(copy,{source:current.source},tx);scope(req,trip.operatorId);await tx.run(INSERT_TRIP,tripToRow(trip));await adminAudit(tx,req,'trip_duplicated','trip',trip.id,trip.operatorId,{fromTrip:current.id,date:trip.date,departureTime:trip.departureTime,from:trip.from,to:trip.to,price:trip.price,totalSeats:trip.totalSeats});return trip;});res.status(201).json({trip:await getTrip(trip.id)});
  }));
  router.post('/admin/import',endpoint(async (req,res) => {
    if (req.body.source !== 'operator' || clean(req.body.sourceReference,2000).length<5) fail(400,'Cần source=operator và sourceReference chỉ rõ nguồn được nhà xe xác nhận.');
    if (req.body.csv !== undefined) {try {req.body.trips=parseCsv(req.body.csv);} catch (error) {fail(400,error.message);}}
    if (!Array.isArray(req.body.trips) || req.body.trips.length<1 || req.body.trips.length>500) fail(400,'Chỉ nhập từ 1 đến 500 chuyến mỗi lần.');
    const trips=await db.transaction(async tx=>{await staffActor(tx,req);const trips=[];for(let index=0;index<req.body.trips.length;index++){try{const input=req.body.trips[index];if(!input || typeof input!=='object' || Array.isArray(input))fail(400,'Dữ liệu chuyến xe phải là một đối tượng.');trips.push(await insertManaged(req,{...input,provenance:req.body.sourceReference},tx));}catch(error){if(error instanceof ApiError)error.message='Dòng '+(index+1)+': '+error.message;throw error;}}for(const trip of trips)await tx.run(INSERT_TRIP,tripToRow(trip));for(const opId of new Set(trips.map(trip=>trip.operatorId))){const owned=trips.filter(trip=>trip.operatorId===opId);await adminAudit(tx,req,'trips_imported','import',crypto.randomUUID(),opId,{count:owned.length,tripIds:owned.map(trip=>trip.id),sourceReference:clean(req.body.sourceReference,2000)});}return trips;});
    res.status(201).json({imported:trips.length,trips:trips.map(t => ({id:t.id,operatorId:t.operatorId,date:t.date,source:t.source}))});
  }));
  router.get('/admin/bookings',endpoint(async (req,res) => {
    await refreshExpired(); const {page,limit}=pageArgs(req.query),clauses=[],args=[];
    if (req.user.role === 'operator') { clauses.push(bookingTripField(db,'operatorId','t.operator_id')+'=?'); args.push(req.user.operatorId || ''); }
    if (req.query.status) { clauses.push('b.status=?'); args.push(clean(req.query.status)); }
    if (req.query.paymentStatus) {clauses.push('b.payment_status=?');args.push(clean(req.query.paymentStatus));}
    if (req.query.operator) {clauses.push(bookingTripField(db,'operatorId','t.operator_id')+'=?');args.push(clean(req.query.operator));}
    if (req.query.tripId) {clauses.push('b.trip_id=?');args.push(clean(req.query.tripId));}
    if (req.query.code) { clauses.push('b.code=?'); args.push(clean(req.query.code).toUpperCase()); }
    if (req.query.q) { clauses.push('(b.code LIKE ? OR b.phone LIKE ? OR LOWER(b.email) LIKE ?)'); args.push('%'+clean(req.query.q,60).toUpperCase()+'%','%'+clean(req.query.q,60)+'%','%'+clean(req.query.q,60).toLowerCase()+'%'); }
    if (req.query.date) { if (!validDate(req.query.date)) fail(400,'Ngày đặt vé không hợp lệ.'); clauses.push('b.created_at>=? AND b.created_at<?'); args.push(new Date(req.query.date+'T00:00:00+07:00').toISOString(),new Date(addDays(req.query.date,1)+'T00:00:00+07:00').toISOString()); }
    addDateClauses(clauses,args,'b.created_at',dateRange(req.query,fail));
    const where=clauses.length ? ' WHERE '+clauses.join(' AND ') : '';
    const count=await db.get('SELECT COUNT(*) AS n FROM bookings b JOIN trips t ON t.id=b.trip_id'+where,args);
    const rows=await db.all('SELECT b.code FROM bookings b JOIN trips t ON t.id=b.trip_id'+where+' ORDER BY b.created_at DESC LIMIT ? OFFSET ?',[...args,limit,(page-1)*limit]);
    const bookings=[]; for (const row of rows) bookings.push(await getBooking(row.code));
    res.json({bookings,total:Number(count.n),page,pages:Math.ceil(Number(count.n)/limit)});
  }));
  router.patch('/admin/bookings/:code',endpoint(async (req,res) => {
    const code=clean(req.params.code,30).toUpperCase();
    if (req.body.status === 'cancelled') return res.json({booking:await cancelBooking(req,code,true)});
    if (req.body.status !== 'confirmed') fail(400,'Chỉ hỗ trợ xác nhận hoặc hủy. Ghi nhận tiền qua biên nhận thu tiền hoặc IPN hợp lệ.');
    const initial=await getBooking(code); if (!initial) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
    await db.transaction(async tx => {
      await staffActor(tx,req);const tripRow=await tx.get('SELECT id,operator_id FROM trips WHERE id=?'+lock,[initial.tripId]);
      await expire(tx,initial.tripId);
      const row=await tx.get('SELECT * FROM bookings WHERE code=?'+lock,[code]);
      const bookingOperatorId=parse(row.data).trip?.operatorId || tripRow.operator_id;scope(req,bookingOperatorId);
      if(row.trip_id!==initial.tripId)fail(409,'Vé vừa được đổi chuyến. Vui lòng tải lại.','CONFLICT');
      if (!['reserved','confirmed'].includes(row.status)) fail(409,'Đặt chỗ không thể xác nhận ở trạng thái này.','INVALID_TRANSITION');
      if(row.status==='confirmed')return;
      await tx.run("UPDATE bookings SET status='confirmed' WHERE code=?",[code]);
      await audit(tx,code,req.user.id,'operator_confirmed');
      await adminAudit(tx,req,'booking_confirmed','booking',code,bookingOperatorId,{status:'confirmed',total:row.total});
    }); res.json({booking:await getBooking(code)});
  }));
  router.post('/admin/bookings/:code/cash-receipt',endpoint(async (req,res) => {
    const code=clean(req.params.code,30).toUpperCase(),reference=clean(req.body.reference,100);
    if (reference.length<5) fail(400,'Cần mã biên nhận thu tiền thực tế dài ít nhất 5 ký tự.');
    const initial=await getBooking(code); if (!initial) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
    await db.transaction(async tx => {
      await staffActor(tx,req);const tripRow=await tx.get('SELECT id,operator_id FROM trips WHERE id=?'+lock,[initial.tripId]);
      const row=await tx.get('SELECT * FROM bookings WHERE code=?'+lock,[code]);
      const bookingOperatorId=parse(row.data).trip?.operatorId || tripRow.operator_id;scope(req,bookingOperatorId);
      if(row.trip_id!==initial.tripId)fail(409,'Vé vừa được đổi chuyến. Vui lòng tải lại.','CONFLICT');
      if (row.payment_method !== 'cash' || !['reserved','confirmed'].includes(row.status) || row.payment_status !== 'pending') fail(409,'Đặt chỗ không đủ điều kiện ghi nhận thu tiền.','INVALID_TRANSITION');
      if(req.body.amount!==undefined && (!Number.isSafeInteger(Number(req.body.amount)) || Number(req.body.amount)!==row.total))fail(400,'Số tiền biên nhận phải đúng số tiền cần thanh toán.');
      const receipt='cash:'+reference;
      if (await tx.get('SELECT reference FROM payments WHERE reference=?',[receipt])) fail(409,'Mã biên nhận đã được dùng.','DUPLICATE_RECEIPT');
      await tx.run('INSERT INTO payments(reference,booking_code,provider,amount,status,created_at,data) VALUES(?,?,?,?,?,?,?)',[receipt,code,'cash',row.total,'paid',nowISO(),json({actor:req.user.id,reference})]);
      await tx.run("UPDATE bookings SET payment_status='paid',status='confirmed' WHERE code=?",[code]);
      await audit(tx,code,req.user.id,'cash_received',{reference,amount:row.total});
      await adminAudit(tx,req,'cash_received','booking',code,bookingOperatorId,{reference,amount:row.total});
    }); res.json({booking:await getBooking(code)});
  }));
  router.post('/admin/bookings/:code/refund-receipt',endpoint(async (req,res) => {
    const code=clean(req.params.code,30).toUpperCase(),reference=clean(req.body.reference,100),amount=Number(req.body.amount);
    if (reference.length<5 || !Number.isSafeInteger(amount) || amount<=0) fail(400,'Cần mã biên nhận hoàn tiền thực tế và số tiền nguyên hợp lệ.');
    const initial=await getBooking(code); if (!initial) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');
    await db.transaction(async tx => {
      await staffActor(tx,req);const tripRow=await tx.get('SELECT id,operator_id FROM trips WHERE id=?'+lock,[initial.tripId]);
      const row=await tx.get('SELECT * FROM bookings WHERE code=?'+lock,[code]);
      const bookingOperatorId=parse(row.data).trip?.operatorId || tripRow.operator_id;scope(req,bookingOperatorId);
      if(row.trip_id!==initial.tripId)fail(409,'Vé vừa được đổi chuyến. Vui lòng tải lại.','CONFLICT');
      if (row.status !== 'refund_pending' || row.payment_status !== 'refund_pending' || amount !== row.total) fail(409,'Chỉ ghi nhận hoàn đủ số tiền cho vé đang chờ hoàn tiền.','INVALID_TRANSITION');
      const receipt='refund:'+reference;
      if (await tx.get('SELECT reference FROM payments WHERE reference=?',[receipt])) fail(409,'Mã biên nhận đã được dùng.','DUPLICATE_RECEIPT');
      await tx.run('INSERT INTO payments(reference,booking_code,provider,amount,status,created_at,data) VALUES(?,?,?,?,?,?,?)',[receipt,code,'manual_refund',amount,'refunded',nowISO(),json({actor:req.user.id,reference})]);
      await tx.run("UPDATE bookings SET payment_status='refunded',status='cancelled' WHERE code=?",[code]);
      await audit(tx,code,req.user.id,'refund_recorded',{reference,amount});
      await adminAudit(tx,req,'refund_recorded','booking',code,bookingOperatorId,{reference,amount});
    }); res.json({booking:await getBooking(code)});
  }));
  router.get('/admin/bookings/:code/events',endpoint(async (req,res) => {
    const booking=await getBooking(clean(req.params.code,30).toUpperCase()); if (!booking) fail(404,'Không tìm thấy đặt chỗ.','NOT_FOUND');scope(req,booking.trip?.operatorId || (await db.get('SELECT operator_id FROM trips WHERE id=?',[booking.tripId])).operator_id);
    const events=await db.all('SELECT * FROM booking_events WHERE booking_code=? ORDER BY created_at',[booking.code]); res.json({events:events.map(e => ({...e,data:parse(e.data)}))});
  }));
  router.use((error,req,res,next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ApiError) return res.status(error.status).json({error:error.message,code:error.code});
    if (/unique|duplicate/i.test(error.message)) return res.status(409).json({error:'Dữ liệu vừa được thay đổi hoặc mã đã tồn tại. Vui lòng tải lại.',code:'CONFLICT'});
    console.error('API error:',error.stack || error.message);
    res.status(500).json({error:'Có lỗi hệ thống. Vui lòng thử lại.',code:'SERVER_ERROR'});
  });

  let sweepBusy=false;
  const timer=setInterval(() => { if (sweepBusy) return; sweepBusy=true; refreshExpired().catch(error => console.error('Reservation expiry failed:',error.message)).finally(() => {sweepBusy=false;}); },60000);
  timer.unref();
  return {router,db,sessionStore:new DatabaseSessionStore(db),async close() {clearInterval(timer); await db.close();}};
}

module.exports = {createApi,ApiError};
