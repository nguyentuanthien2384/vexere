'use strict';

const bcrypt = require('bcryptjs');
const {todayVietnam,addDays,makeSeats,enrichDemoTrip,tripToRow,INSERT_TRIP} = require('./catalog');

const DISCLAIMER = 'Chứng từ, hành khách và trạng thái thanh toán đều là dữ liệu kiểm thử; không có giao dịch tiền thật.';
const DEFAULT_OPERATOR_PASSWORD = 'Nhaxe@12345';

async function initializeDemoFixtures(db,{seedDemo=false,env=process.env}={}) {
  if (!seedDemo || env.NODE_ENV === 'production' || env.NODE_ENV === 'test') return;
  const version=await db.get('SELECT value FROM settings WHERE key=?',['demo_fixtures_version']);
  if (version?.value === '3') return;
  const today=todayVietnam(), tomorrow=addDays(today,1), createdAt=new Date().toISOString();
  const operatorHash=await bcrypt.hash(DEFAULT_OPERATOR_PASSWORD,12);
  await db.transaction(async tx => {
    await tx.run('INSERT INTO users(id,full_name,email,phone,password_hash,role,operator_id,verified,created_at) VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT(email) DO NOTHING',
      ['demo-operator-user','Nhân viên nhà xe mẫu','operator@ticket4t.vn','0900000001',operatorHash,'operator','demo-op-1',createdAt]);
    const customer=await tx.get('SELECT id FROM users WHERE email=?',['khach@ticket4t.vn']);
    if (!customer) throw new Error('Demo customer must exist before sample booking scenarios are initialized.');
    const promos=[
      {code:'TEST50K',title:'Giảm 50.000đ cho lần thử đầu',type:'fixed',value:50000,minSpend:200000,maxDiscount:50000,maxUses:500,perCustomer:5},
      {code:'KHUHOI10',title:'Khứ hồi giảm 10%',type:'percentage',value:10,minSpend:300000,maxDiscount:150000,maxUses:500,perCustomer:5,roundTripOnly:true},
      {code:'LIMO15',title:'Nhà xe An Việt giảm 15%',type:'percentage',value:15,minSpend:100000,maxDiscount:100000,maxUses:200,perCustomer:3,operatorIds:['demo-op-1']},
      {code:'HETHAN',title:'Mã đã hết hạn để kiểm thử',type:'fixed',value:30000,minSpend:0,maxDiscount:30000,maxUses:100,perCustomer:1,expired:true},
      {code:'HETLUOT',title:'Mã đã hết lượt để kiểm thử',type:'fixed',value:30000,minSpend:0,maxDiscount:30000,maxUses:1,perCustomer:1,usedCount:1},
      {code:'DALAT20',title:'Tuyến Sài Gòn – Đà Lạt giảm 20.000đ',type:'fixed',value:20000,minSpend:100000,maxDiscount:20000,maxUses:500,perCustomer:5,routeIds:['ho-chi-minh--da-lat','da-lat--ho-chi-minh']},
    ];
    for (const p of promos) {
      const data={active:true,source:'demo',description:'Ưu đãi minh họa dùng kiểm thử; không phải chương trình thương mại.',roundTripOnly:false,operatorIds:[],routeIds:[],
        startsAt:new Date(Date.now()-86400000).toISOString(),expiresAt:new Date(Date.now()+(p.expired ? -3600000 : 90*86400000)).toISOString(),...p};
      delete data.expired; delete data.usedCount;
      await tx.run('INSERT INTO promotions(code,data,active,used_count,created_at) VALUES(?,?,1,?,?) ON CONFLICT(code) DO NOTHING',[p.code,JSON.stringify(data),p.usedCount || 0,createdAt]);
    }
    const scenarios=[];
    async function insertBooking({code,tripId,seats,status='reserved',paymentStatus='pending',method='cash',orderCode=null,discount=0}) {
      const row=await tx.get('SELECT * FROM trips WHERE id=?',[tripId]);
      if (!row) return null;
      const trip=JSON.parse(row.data),subtotal=seats.reduce((sum,seat) => sum+(trip.seatPrices?.[seat] ?? trip.price),0),total=subtotal-discount;
      if (['reserved','confirmed','pending_payment'].includes(status)) {
        const occupied=await tx.all('SELECT seat FROM reserved_seats WHERE trip_id=?',[trip.id]);
        if (occupied.some(s=>seats.includes(s.seat))) return null;
      }
      const expiresAt=status==='pending_payment' ? new Date(Date.now()+15*60000).toISOString() : null;
      const data={tripId,trip,seats,fullName:'Hành khách mẫu '+String(scenarios.length+1).padStart(2,'0'),email:'khach@ticket4t.vn',phone:'0900000000',
        pickup:trip.pickupPoints[0],dropoff:trip.dropoffPoints[0],subtotal,discount,couponCode:null,orderCode,source:'demo',isDemo:true,note:DISCLAIMER};
      await tx.run('INSERT INTO bookings(code,trip_id,user_id,phone,email,status,payment_status,payment_method,total,expires_at,created_at,data,order_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING',
        [code,trip.id,customer.id,data.phone,data.email,status,paymentStatus,method,total,expiresAt,createdAt,JSON.stringify(data),orderCode]);
      if (['reserved','confirmed','pending_payment'].includes(status)) for (const seat of seats) {
        // Never replace reservations created by users of an existing v2 database.
        await tx.run('INSERT INTO reserved_seats(trip_id,seat,booking_code) VALUES(?,?,?) ON CONFLICT(trip_id,seat) DO NOTHING',[trip.id,seat,code]);
      }
      if (['paid','refund_pending','refunded'].includes(paymentStatus)) {
        await tx.run('INSERT INTO payments(reference,booking_code,provider,amount,status,created_at,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(reference) DO NOTHING',
          ['fixture:'+code,code,'fixture',total,paymentStatus,createdAt,JSON.stringify({isDemo:true,note:DISCLAIMER})]);
      }
      await tx.run('INSERT INTO booking_events(id,booking_code,actor,event,created_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        ['fixture-event-'+code,code,'demo-fixture','demo_created',createdAt,JSON.stringify({isDemo:true,note:DISCLAIMER})]);
      const fixture={code,phone:data.phone,status,paymentStatus,tripId,route:trip.fromName+' → '+trip.toName,seats,total,orderCode};
      scenarios.push(fixture); return fixture;
    }
    await insertBooking({code:'T4TDEMORESERVED',tripId:'demo-'+tomorrow+'-0-0',seats:['A08']});
    const paidSample=await insertBooking({code:'T4TDEMOPAID',tripId:'demo-'+tomorrow+'-0-0',seats:['A09'],status:'confirmed',paymentStatus:'paid'});
    if (paidSample) await tx.run('INSERT INTO promotion_uses(id,code,booking_code,phone,status,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      ['fixture-promo-exhausted','HETLUOT',paidSample.code,'0900000000','active',createdAt]);
    await insertBooking({code:'T4TDEMOPENDING',tripId:'demo-'+tomorrow+'-0-2',seats:['B11'],status:'pending_payment',method:'vnpay'});
    await insertBooking({code:'T4TDEMOCANCELLED',tripId:'demo-'+tomorrow+'-0-1',seats:['B20'],status:'cancelled'});
    await insertBooking({code:'T4TDEMOEXPIRED',tripId:'demo-'+tomorrow+'-0-1',seats:['B19'],status:'expired',method:'vnpay'});
    await insertBooking({code:'T4TDEMOREFUND',tripId:'demo-'+tomorrow+'-0-3',seats:['A29'],status:'refund_pending',paymentStatus:'refund_pending'});
    await insertBooking({code:'T4TDEMOREFUNDED',tripId:'demo-'+tomorrow+'-0-3',seats:['A28'],status:'cancelled',paymentStatus:'refunded'});
    const outward=await insertBooking({code:'T4TDEMOROUNDOUT',tripId:'demo-'+tomorrow+'-0-1',seats:['B18'],orderCode:'T4ODEMOROUND'});
    const returning=await insertBooking({code:'T4TDEMOROUNDBACK',tripId:'demo-'+addDays(today,2)+'-1-1',seats:['B18'],orderCode:'T4ODEMOROUND'});
    if (outward && returning) await tx.run('INSERT INTO orders(code,user_id,phone,email,subtotal,discount,total,coupon_code,created_at,data) VALUES(?,?,?,?,?,0,?,?,?,?) ON CONFLICT(code) DO NOTHING',
      ['T4ODEMOROUND',customer.id,'0900000000','khach@ticket4t.vn',outward.total+returning.total,outward.total+returning.total,null,createdAt,JSON.stringify({fullName:'Hành khách khứ hồi mẫu',bookingCodes:[outward.code,returning.code],isDemo:true,note:DISCLAIMER})]);
    const sampleRow=await tx.get('SELECT data FROM trips WHERE id=?',['demo-'+tomorrow+'-0-0']);
    if (sampleRow) {
      const past=enrichDemoTrip({...JSON.parse(sampleRow.data),id:'demo-history-'+today,date:addDays(today,-3),departureTime:'06:00',arrivalDate:addDays(today,-3)});
      await tx.run(INSERT_TRIP+' ON CONFLICT(id) DO NOTHING',tripToRow(past));
      await insertBooking({code:'T4TDEMOCOMPLETED',tripId:past.id,seats:['A01'],status:'confirmed',paymentStatus:'paid'});
    }
    // A sold-out case and a last-seat case on day three, without changing search route counts.
    for (const [routeIndex,kind] of [[38,'sold-out'],[40,'last-seat']]) {
      const id='demo-'+addDays(today,3)+'-'+routeIndex+'-0';
      const row=await tx.get('SELECT data FROM trips WHERE id=?',[id]);
      if (!row) continue;
      const trip=JSON.parse(row.data),labels=makeSeats(trip.type,trip.totalSeats).map(s=>s.label).slice(0,kind==='last-seat' ? -1 : undefined);
      for (let i=0;i<labels.length;i+=3) await insertBooking({code:'T4TDEMO'+kind.replace(/-/g,'').toUpperCase()+i,tripId:id,seats:labels.slice(i,i+3)});
    }
    const manifest={generatedOn:today,isDemo:true,note:DISCLAIMER,accounts:[
      {email:'khach@ticket4t.vn',role:'customer',phone:'0900000000'},
      {email:'operator@ticket4t.vn',role:'operator',operatorId:'demo-op-1'}],
      promotions:promos.map(p=>({code:p.code,title:p.title})),orders:[{code:'T4ODEMOROUND',phone:'0900000000'}],bookings:scenarios};
    await tx.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',['demo_scenarios',JSON.stringify(manifest)]);
    await tx.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',['demo_fixtures_version','3']);
  });
}

module.exports={initializeDemoFixtures,DISCLAIMER,DEFAULT_OPERATOR_PASSWORD};
