"use strict";

const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

const busTypes = [
  {id: 'limousine', name: 'Limousine 9 chỗ', seats: 9, multiplier: 1.3},
  {id: 'sleeper', name: 'Giường nằm 40 chỗ', seats: 40, multiplier: 1},
  {id: 'cabin', name: 'Limousine phòng 22 chỗ', seats: 22, multiplier: 1.65},
  {id: 'seater', name: 'Ghế ngồi 29 chỗ', seats: 29, multiplier: 0.85},
];

const locationRows = [
  ['ho-chi-minh','TP. Hồ Chí Minh','Miền Nam','sai-gon'], ['da-lat','Đà Lạt','Tây Nguyên','da-lat'],
  ['nha-trang','Nha Trang','Miền Trung','nha-trang'], ['vung-tau','Vũng Tàu','Miền Nam','vung-tau'],
  ['can-tho','Cần Thơ','Miền Nam','can-tho'], ['ca-mau','Cà Mau','Miền Nam','ca-mau'],
  ['phan-thiet','Phan Thiết','Miền Trung','phan-thiet'], ['buon-ma-thuot','Buôn Ma Thuột','Tây Nguyên','dak-lak'],
  ['da-nang','Đà Nẵng','Miền Trung','da-nang'], ['hue','Huế','Miền Trung','da-nang'],
  ['ha-noi','Hà Nội','Miền Bắc','ha-noi'], ['hai-phong','Hải Phòng','Miền Bắc','hai-phong'],
  ['sa-pa','Sa Pa','Miền Bắc','lao-cai'], ['ha-long','Hạ Long','Miền Bắc','hai-phong'],
  ['ninh-binh','Ninh Bình','Miền Bắc','ha-noi'], ['vinh','Vinh','Miền Trung','nghe-an'],
  ['quy-nhon','Quy Nhơn','Miền Trung','nha-trang'], ['pleiku','Pleiku','Tây Nguyên','dak-lak'],
  ['dien-bien','Điện Biên','Miền Bắc','dien-bien'], ['quang-tri','Quảng Trị','Miền Trung','quang-tri'],
  ['thanh-hoa','Thanh Hóa','Miền Bắc','nghe-an'], ['dong-hoi','Đồng Hới','Miền Trung','quang-tri'],
  ['an-giang','An Giang','Miền Nam','can-tho'], ['rach-gia','Rạch Giá','Miền Nam','can-tho'],
  ['tay-ninh','Tây Ninh','Miền Nam','sai-gon'], ['bao-loc','Bảo Lộc','Tây Nguyên','lam-dong'],
];
const locations = locationRows.map(([id,name,region,image]) => ({id,name,region,image: '/images/locationImages/' + image + '.jpg'}));
const locationMap = Object.fromEntries(locations.map(item => [item.id, item]));

// All invented operators, schedules, prices and ratings are expressly sample data.
const operatorNames = ['An Việt','Bình Minh','Đại Phát','Hải Đăng','Hoàng Gia','Hưng Thịnh','Khánh An','Kim Long','Lâm Sơn','Minh Anh','Nam Phương','Ngọc Việt','Phúc An','Quang Minh','Sao Mai','Thiên Phú','Trường Sơn','Tuấn Việt','Vạn An','Việt Hành','Đông Dương','Tây Nguyên'];
const images = ['ha-my','hoang-anh','minh-phuong','phat-thuy','tien-dat'];
const operators = operatorNames.map((name,i) => ({id: 'demo-op-' + (i+1), name: name + ' (mẫu)', rating: +(4.2 + (i % 8) * .1).toFixed(1), reviewCount: 0,
  image: '/images/chuyenxe/' + images[i % images.length] + '-1.jpg', phone: '', email: '', description: 'Nhà xe minh họa dùng để kiểm thử. Lịch, giá và đánh giá không phải dữ liệu thương mại.', source: 'demo', active: true}));

const routeSpecs = [
  ['ho-chi-minh','da-lat',360,280000], ['ho-chi-minh','nha-trang',480,320000], ['ho-chi-minh','vung-tau',150,150000],
  ['ho-chi-minh','can-tho',210,165000], ['ho-chi-minh','ca-mau',450,250000], ['ho-chi-minh','phan-thiet',240,200000],
  ['ho-chi-minh','buon-ma-thuot',480,300000], ['ho-chi-minh','quy-nhon',720,400000], ['ho-chi-minh','pleiku',660,350000],
  ['ho-chi-minh','an-giang',330,220000], ['ho-chi-minh','rach-gia',360,230000], ['ho-chi-minh','tay-ninh',150,120000],
  ['ho-chi-minh','bao-loc',240,210000], ['da-lat','nha-trang',210,190000], ['da-lat','da-nang',780,450000],
  ['da-nang','hue',150,140000], ['da-nang','quy-nhon',360,230000], ['da-nang','quang-tri',240,220000],
  ['da-nang','dong-hoi',330,250000], ['ha-noi','hai-phong',120,150000], ['ha-noi','sa-pa',360,280000],
  ['ha-noi','ha-long',180,190000], ['ha-noi','ninh-binh',120,130000], ['ha-noi','vinh',360,260000],
  ['ha-noi','dien-bien',600,350000], ['ha-noi','thanh-hoa',180,170000], ['ha-noi','dong-hoi',540,380000],
  ['ha-noi','da-nang',900,550000], ['can-tho','ca-mau',210,140000], ['nha-trang','quy-nhon',240,200000],
];
const routes = routeSpecs.flatMap(([from,to,durationMinutes,minPrice]) => [
  {id: from+'--'+to,from,to,fromName:locationMap[from].name,toName:locationMap[to].name,durationMinutes,minPrice,image:locationMap[to].image},
  {id: to+'--'+from,from:to,to:from,fromName:locationMap[to].name,toName:locationMap[from].name,durationMinutes,minPrice,image:locationMap[from].image},
]);

function todayVietnam(now = new Date()) { return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(now); }
function addDays(date, count) { const d = new Date(date+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+count); return d.toISOString().slice(0,10); }
function makeSeats(type, count) { return Array.from({length: count}, (_,i) => {
  const doubleDeck = ['sleeper','cabin'].includes(type);
  const half = Math.ceil(count/2);
  const deck = doubleDeck && i >= half ? 2 : 1;
  const label = doubleDeck ? (deck === 1 ? 'A' : 'B') + String(i % half + 1).padStart(2,'0') : 'A' + String(i+1).padStart(2,'0');
  return {id:label,label,deck};
}); }

// This itinerary is deliberately illustrative. It is not an operator's live stop list.
function enrichDemoTrip(trip) {
  const departure = new Date(trip.date+'T'+trip.departureTime+':00+07:00').getTime();
  const stop = (name,kind,offsetMinutes,address) => ({name,kind,offsetMinutes,address,isDemo:true,
    estimatedAt:new Date(departure+offsetMinutes*60000).toISOString()});
  trip.stops = [
    stop(trip.pickupPoints[0],'pickup',0,'Khu vực bến xe '+trip.fromName+' · địa chỉ minh họa'),
    stop(trip.pickupPoints[1] || trip.pickupPoints[0],'pickup',15,'Khu vực trung tâm '+trip.fromName+' · địa chỉ minh họa'),
    ...(trip.durationMinutes >= 180 ? [stop('Trạm nghỉ dọc tuyến (mẫu)','rest',Math.round(trip.durationMinutes/2),'Dừng nghỉ dự kiến 15 phút; vị trí minh họa')] : []),
    stop(trip.dropoffPoints[1] || trip.dropoffPoints[0],'dropoff',Math.max(20,trip.durationMinutes-15),'Khu vực trung tâm '+trip.toName+' · địa chỉ minh họa'),
    stop(trip.dropoffPoints[0],'dropoff',trip.durationMinutes,'Khu vực bến xe '+trip.toName+' · địa chỉ minh họa'),
  ];
  trip.luggageKg = 15;
  trip.cancellationPolicy = {cutoffMinutes:120,description:'Có thể gửi yêu cầu hủy trước giờ khởi hành ít nhất 2 giờ. Đơn đã thanh toán được chuyển sang chờ đối soát hoàn tiền.'};
  trip.changePolicy = {cutoffMinutes:120,sameOperator:true,description:'Đổi sang chuyến cùng nhà xe, tuyến và giá trước giờ đi ít nhất 2 giờ. Chênh lệch giá cần nhà xe xử lý.'};
  return trip;
}

function tripToRow(trip) {
  return [trip.id,trip.operatorId,trip.from,trip.to,trip.date,trip.departureTime,
    new Date(trip.date+'T'+trip.departureTime+':00+07:00').toISOString(), trip.price,trip.totalSeats,trip.type,trip.active === false ? 0 : 1,trip.source || 'managed',JSON.stringify(trip)];
}
const INSERT_TRIP = 'INSERT INTO trips(id,operator_id,from_id,to_id,date,departure_time,departure_at,price,total_seats,type,active,source,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)';

async function initializeCatalog(db, {seedDemo = false, env = process.env, days = 30} = {}) {
  await db.transaction(async tx => {
    for (const l of locations) await tx.run('INSERT INTO locations(id,name,region,image) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',[l.id,l.name,l.region,l.image]);
    if (!seedDemo) return;
    for (const op of operators) await tx.run('INSERT INTO operators(id,name,data,active) VALUES(?,?,?,1) ON CONFLICT(id) DO NOTHING',[op.id,op.name,JSON.stringify(op)]);
    // Existing v2 databases gain the same itinerary information as fresh installations.
    const migration = await tx.get('SELECT value FROM settings WHERE key=?',['demo_itinerary_version']);
    if (migration?.value !== '3.1') {
      const existing = await tx.all("SELECT id,data FROM trips WHERE source='demo'");
      for (const row of existing) await tx.run('UPDATE trips SET data=? WHERE id=?',[JSON.stringify(enrichDemoTrip(JSON.parse(row.data))),row.id]);
      await tx.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',['demo_itinerary_version','3.1']);
    }
    const today = todayVietnam();
    const seeded = await tx.get('SELECT value FROM settings WHERE key=?',['seeded_until']);
    const until = addDays(today,days-1);
    if (seeded && seeded.value >= until) return;
    const start = seeded && seeded.value >= today ? addDays(seeded.value,1) : today;
    for (let date = start; date <= until; date = addDays(date,1)) {
      for (let r = 0; r < routes.length; r++) {
        const route = routes[r];
        for (let k = 0; k < 4; k++) {
          const op = operators[(r*3+k) % operators.length];
          const type = busTypes[k];
          const hour = [6,12,18,22][k];
          const minute = (r % 4) * 15;
          const departureTime = String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0');
          const arrival = (hour*60+minute+route.durationMinutes) % 1440;
          const trip = {id:'demo-'+date+'-'+r+'-'+k,operatorId:op.id,operatorName:op.name,rating:op.rating,reviewCount:0,
            type:type.id,typeName:type.name,from:route.from,to:route.to,fromName:route.fromName,toName:route.toName,date,departureTime,
            arrivalTime: String(Math.floor(arrival/60)).padStart(2,'0')+':'+String(arrival%60).padStart(2,'0'),
            arrivalDate:addDays(date,Math.floor((hour*60+minute+route.durationMinutes)/1440)),durationMinutes:route.durationMinutes,
            price:Math.round(route.minPrice*type.multiplier/10000)*10000,totalSeats:type.seats,image:op.image,
            pickupPoints:['Bến xe '+route.fromName,'Văn phòng '+route.fromName],dropoffPoints:['Bến xe '+route.toName,'Văn phòng '+route.toName],
            amenities:['Điều hòa','Nước uống','Wi-Fi',...(type.id === 'cabin' ? ['USB','Rèm riêng tư'] : [])],
            policies:['Có mặt trước giờ khởi hành 30 phút.','Hủy trước giờ khởi hành ít nhất 2 giờ.','Hành lý tối đa 15 kg; liên hệ nhà xe nếu cần thêm.'],
            source:'demo',active:true,provenance:'Lịch và giá được tạo để minh họa; không phải dữ liệu Vexere hoặc nguồn bán vé thật.'};
          if (type.id === 'cabin') trip.seatPrices=Object.fromEntries(makeSeats(type.id,type.seats).filter(s => s.deck === 1).map(s => [s.label,trip.price+20000]));
          enrichDemoTrip(trip);
          await tx.run(INSERT_TRIP+' ON CONFLICT(id) DO NOTHING',tripToRow(trip));
        }
      }
    }
    await tx.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',['seeded_until',until]);
  });
  if (seedDemo && (env.NODE_ENV !== 'production' || env.SEED_DEMO === 'true')) {
    for (const account of [{email:'admin@ticket4t.vn',name:'Quản trị mẫu',password:'Admin@12345',role:'admin'}, {email:'khach@ticket4t.vn',name:'Khách hàng mẫu',password:'Khach@12345',role:'customer'}]) {
      if (await db.get('SELECT id FROM users WHERE email=?',[account.email])) continue;
      const hash = await bcrypt.hash(account.password,12);
      await db.transaction(tx => tx.run('INSERT INTO users(id,full_name,email,phone,password_hash,role,verified,created_at) VALUES(?,?,?,?,?,?,1,?)',[crypto.randomUUID(),account.name,account.email,'0900000000',hash,account.role,new Date().toISOString()]));
    }
  }
}

module.exports = {busTypes,locations,locationMap,operators,routes,todayVietnam,addDays,makeSeats,enrichDemoTrip,tripToRow,INSERT_TRIP,initializeCatalog};
