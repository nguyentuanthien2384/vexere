'use strict';

const {describe,test}=require('node:test');
const assert=require('node:assert/strict');
const {busTypes,locations,operators,routes,todayVietnam,addDays,makeSeats,enrichDemoTrip,tripToRow,INSERT_TRIP}=require('../../server/catalog');
const {parseCsv}=require('../../server/import');
const {dateRange,addDateClauses,bookingTripField}=require('../../server/admin-analytics');

const HEADER='operatorId,from,to,date,departureTime,durationMinutes,price,type';
const ROW='op-1,ho-chi-minh,da-lat,2028-02-29,22:30,360,250000,sleeper';
function fail(status,message){const error=new Error(message);error.status=status;throw error;}
const invalidRange=error=>error.status===400;

describe('[UT-GROUP-CATALOG] Calendar, seat and itinerary contracts',()=>{
  test('[UT-CAT-001] Vietnam booking day changes exactly at 17:00 UTC',()=>{
    assert.equal(todayVietnam(new Date('2028-02-29T16:59:59.999Z')),'2028-02-29');
    assert.equal(todayVietnam(new Date('2028-02-29T17:00:00.000Z')),'2028-03-01');
    assert.equal(todayVietnam(new Date('2027-12-31T17:00:00.000Z')),'2028-01-01');
  });
  test('[UT-CAT-002] Date arithmetic honors leap years and Gregorian century rules',()=>{
    assert.equal(addDays('2028-02-28',1),'2028-02-29');
    assert.equal(addDays('2028-02-29',1),'2028-03-01');
    assert.equal(addDays('2100-02-28',1),'2100-03-01');
    assert.equal(addDays('2000-02-28',1),'2000-02-29');
  });
  test('[UT-CAT-003] Outward and return calendar offsets remain reversible across month and year boundaries',()=>{
    assert.equal(addDays('2027-12-31',1),'2028-01-01');
    assert.equal(addDays('2028-01-01',-1),'2027-12-31');
    assert.equal(addDays('2028-03-01',-1),'2028-02-29');
    for(const [departure,stay] of [['2028-02-27',4],['2027-12-30',5],['2028-03-25',14]]){
      const returning=addDays(departure,stay);assert.ok(returning>departure);assert.equal(addDays(returning,-stay),departure);
    }
    assert.equal(addDays('2028-02-29',0),'2028-02-29');
  });
  test('[UT-CAT-004] Standard seat layouts expose the expected capacity, decks and physical labels',()=>{
    const layouts={limousine:[9,'A09',1],seater:[29,'A29',1],sleeper:[40,'B20',2],cabin:[22,'B11',2]};
    for(const type of busTypes){
      const [capacity,last,deck]=layouts[type.id],seats=makeSeats(type.id,type.seats);
      assert.equal(seats.length,capacity);assert.equal(seats[0].label,'A01');assert.equal(seats.at(-1).label,last);assert.equal(seats.at(-1).deck,deck);
      assert.equal(new Set(seats.map(seat=>seat.id)).size,capacity);assert.ok(seats.every(seat=>seat.id===seat.label));
    }
  });
  test('[UT-CAT-005] Odd double-deck capacities retain every seat without duplicate labels',()=>{
    assert.deepEqual(makeSeats('cabin',5),[{id:'A01',label:'A01',deck:1},{id:'A02',label:'A02',deck:1},{id:'A03',label:'A03',deck:1},{id:'B01',label:'B01',deck:2},{id:'B02',label:'B02',deck:2}]);
    assert.deepEqual(makeSeats('sleeper',1),[{id:'A01',label:'A01',deck:1}]);
    assert.deepEqual(makeSeats('seater',0),[]);
    for(const type of busTypes){const seats=makeSeats(type.id,60);assert.equal(seats.length,60);assert.equal(new Set(seats.map(seat=>seat.label)).size,60);}
  });
  test('[UT-CAT-006] Catalog routes have reciprocal schedules and only reference known locations',()=>{
    const locationIds=new Set(locations.map(location=>location.id)),byId=new Map(routes.map(route=>[route.id,route]));assert.equal(byId.size,routes.length);
    for(const route of routes){
      assert.ok(locationIds.has(route.from));assert.ok(locationIds.has(route.to));assert.notEqual(route.from,route.to);
      const reverse=byId.get(route.to+'--'+route.from);assert.ok(reverse);assert.equal(reverse.durationMinutes,route.durationMinutes);assert.equal(reverse.minPrice,route.minPrice);
      assert.equal(route.image,locations.find(location=>location.id===route.to).image);
    }
    assert.ok(operators.every(operator=>operator.source==='demo'&&operator.reviewCount===0),'Invented operators must not claim verified trip reviews');
  });
  test('[UT-CAT-007] Trip storage binds Vietnam departure time and preserves the immutable input snapshot',()=>{
    const trip={id:'trip-unit',operatorId:'operator-unit',from:'ho-chi-minh',to:'da-lat',date:'2028-02-29',departureTime:'00:10',price:250000,totalSeats:9,type:'limousine',active:false,source:'managed',pickupPoints:['Bến xe'],seatPrices:{A01:270000}};
    const original=structuredClone(trip),columns=INSERT_TRIP.match(/\(([^)]+)\) VALUES/)[1].split(','),values=tripToRow(trip),stored=Object.fromEntries(columns.map((column,index)=>[column,values[index]]));
    assert.equal(values.length,columns.length);assert.equal(stored.departure_at,'2028-02-28T17:10:00.000Z');assert.equal(stored.active,0);assert.equal(stored.source,'managed');assert.equal(stored.price,250000);assert.deepEqual(JSON.parse(stored.data),original);assert.deepEqual(trip,original);
    const defaults=tripToRow({...trip,active:undefined,source:undefined});assert.equal(defaults[columns.indexOf('active')],1);assert.equal(defaults[columns.indexOf('source')],'managed');
  });
  test('[UT-CAT-008] Overnight demo itinerary has chronological UTC stops and explicit sample provenance',()=>{
    const trip={date:'2028-02-29',departureTime:'23:30',durationMinutes:360,fromName:'TP. Hồ Chí Minh',toName:'Đà Lạt',pickupPoints:['Bến xe đi','Văn phòng đi'],dropoffPoints:['Bến xe đến','Văn phòng đến']};
    const enriched=enrichDemoTrip(trip),times=enriched.stops.map(stop=>Date.parse(stop.estimatedAt));
    assert.equal(enriched.stops[0].estimatedAt,'2028-02-29T16:30:00.000Z');assert.equal(enriched.stops.at(-1).estimatedAt,'2028-02-29T22:30:00.000Z');assert.ok(times.every((time,index)=>index===0||time>=times[index-1]));assert.ok(enriched.stops.every(stop=>stop.isDemo===true));
    assert.equal(enriched.stops.filter(stop=>stop.kind==='rest').length,1);assert.equal(enriched.cancellationPolicy.cutoffMinutes,120);assert.equal(enriched.changePolicy.sameOperator,true);
  });
  test('[UT-CAT-009] Short itineraries do not invent rest stops and support one pickup and dropoff',()=>{
    const enriched=enrichDemoTrip({date:'2028-01-01',departureTime:'06:00',durationMinutes:120,fromName:'A',toName:'B',pickupPoints:['Điểm đi'],dropoffPoints:['Điểm đến']});
    assert.equal(enriched.stops.filter(stop=>stop.kind==='rest').length,0);assert.equal(enriched.stops[1].name,'Điểm đi');assert.equal(enriched.stops.at(-2).name,'Điểm đến');
  });
});

describe('[UT-GROUP-CSV] Operator CSV format and bounded import contracts',()=>{
  test('[UT-CSV-001] Minimal CSV produces typed schedule and fare fields without inventing optional values',()=>{
    const [trip]=parseCsv(HEADER+'\n'+ROW);
    assert.deepEqual(trip,{operatorId:'op-1',from:'ho-chi-minh',to:'da-lat',date:'2028-02-29',departureTime:'22:30',durationMinutes:360,price:250000,type:'sleeper'});
  });
  test('[UT-CSV-002] RFC4180 quotes preserve commas, escaped quotes, CRLF cells and JSON seat prices',()=>{
    const csv=HEADER+',totalSeats,pickupPoints,dropoffPoints,amenities,policies,seatPrices\r\n'+ROW+',40,"Bến xe, cổng A| Văn phòng ""An Việt"" ",Điểm trả,"Điều hòa|Nước uống","Có mặt sớm\r\nKhông hút thuốc","{""A01"":270000}"\r\n';
    const [trip]=parseCsv(csv);assert.equal(trip.totalSeats,40);assert.deepEqual(trip.pickupPoints,['Bến xe, cổng A','Văn phòng "An Việt"']);assert.deepEqual(trip.amenities,['Điều hòa','Nước uống']);assert.deepEqual(trip.policies,['Có mặt sớm\r\nKhông hút thuốc']);assert.deepEqual(trip.seatPrices,{A01:270000});
  });
  test('[UT-CSV-003] BOM, supported newline styles and blank lines do not create phantom trips',()=>{
    for(const newline of ['\n','\r\n','\r']){
      const trips=parseCsv('\uFEFF'+HEADER+newline+newline+ROW+newline+'   '+newline);assert.equal(trips.length,1);assert.equal(trips[0].operatorId,'op-1');
    }
  });
  test('[UT-CSV-004] Header ordering is independent of data mapping and whitespace is normalized',()=>{
    const headers=HEADER.split(',').reverse().map(header=>' '+header+' '),values=ROW.split(',').reverse().map(value=>' '+value+' ');
    assert.deepEqual(parseCsv(headers.join(',')+'\n'+values.join(',')),parseCsv(HEADER+'\n'+ROW));
  });
  test('[UT-CSV-005] Optional empty columns are omitted and list separators discard empty entries',()=>{
    const [trip]=parseCsv(HEADER+',totalSeats,pickupPoints,dropoffPoints,amenities,policies,seatPrices\n'+ROW+',,Điểm A|| Điểm B |,,,,');
    assert.deepEqual(trip.pickupPoints,['Điểm A','Điểm B']);for(const key of ['totalSeats','dropoffPoints','amenities','policies','seatPrices'])assert.equal(Object.hasOwn(trip,key),false);
  });
  test('[UT-CSV-006] Unsupported or duplicate headers cannot alter the import schema',()=>{
    assert.throws(()=>parseCsv(HEADER+',source\n'+ROW+',managed'),/Tiêu đề/);
    assert.throws(()=>parseCsv(HEADER+',price\n'+ROW+',1'),/Tiêu đề/);
    assert.throws(()=>parseCsv(HEADER+',__proto__\n'+ROW+',ignored'),/Tiêu đề/);
  });
  test('[UT-CSV-007] Every required identity, schedule and fare column must be present',()=>{
    const headers=HEADER.split(','),values=ROW.split(',');
    headers.forEach((required,index)=>assert.throws(()=>parseCsv(headers.filter((_,i)=>i!==index).join(',')+'\n'+values.filter((_,i)=>i!==index).join(',')),error=>error.message.includes('thiếu cột '+required)));
  });
  test('[UT-CSV-008] Row width and malformed JSON report the offending data row',()=>{
    assert.throws(()=>parseCsv(HEADER+'\n'+ROW+'\n'+ROW+',extra'),/Dòng 3/);
    assert.throws(()=>parseCsv(HEADER+',seatPrices\n'+ROW+',not-json'),/Dòng 2.*seatPrices/);
    assert.throws(()=>parseCsv(HEADER+'\n'+ROW.split(',').slice(1).join(',')),/Dòng 2/);
  });
  test('[UT-CSV-009] Unterminated quotes and quotes inside unquoted fields are rejected',()=>{
    for(const value of ['"op-1','op"-1',' "op-1"'])assert.throws(()=>parseCsv(HEADER+'\n'+ROW.replace('op-1',value)),/ngoặc kép/);
  });
  test('[UT-CSV-010] Characters after a closing quote are rejected instead of silently changing identity',()=>{
    for(const value of ['"op-1"x','"op-1" x','""x','"op-1""unfinished'])assert.throws(()=>parseCsv(HEADER+'\n'+ROW.replace('op-1',value)),/ngoặc kép/);
  });
  test('[UT-CSV-011] Import accepts exactly 500 trips and rejects 501 with or without a final newline',()=>{
    const fiveHundred=HEADER+'\n'+Array(500).fill(ROW).join('\n');
    assert.equal(parseCsv(fiveHundred).length,500);assert.equal(parseCsv(fiveHundred+'\n').length,500);
    for(const ending of ['','\n','\r\n'])assert.throws(()=>parseCsv(fiveHundred+'\n'+ROW+ending),/500 chuyến/);
  });
  test('[UT-CSV-012] One megabyte limit counts UTF8 bytes before parsing multilingual imports',()=>{
    const multilingual=HEADER+'\n'+Array(400).fill(ROW.replace('op-1','ế'.repeat(1000))).join('\n');
    assert.ok(multilingual.length<1000000);assert.ok(Buffer.byteLength(multilingual,'utf8')>1000000);assert.throws(()=>parseCsv(multilingual),/1 MB/);
    assert.throws(()=>parseCsv('x'.repeat(1000001)),/1 MB/);
  });
  test('[UT-CSV-013] Empty imports, non-text inputs and oversized cells fail explicitly',()=>{
    for(const value of [undefined,null,[],{},42,'',HEADER,HEADER+'\n\n'])assert.throws(()=>parseCsv(value));
    assert.equal(parseCsv(HEADER+'\n'+ROW.replace('op-1','a'.repeat(10000)))[0].operatorId.length,10000);
    assert.throws(()=>parseCsv(HEADER+'\n'+ROW.replace('op-1','a'.repeat(10001))),/ô quá dài/);
  });
  test('[UT-CSV-014] Importing spreadsheet-looking text treats it as inert operator data',()=>{
    const [trip]=parseCsv(HEADER+'\n'+ROW.replace('op-1','=SUM(1+1)'));assert.equal(trip.operatorId,'=SUM(1+1)');
  });
});

describe('[UT-GROUP-REPORT] Reporting dates and historical ownership expressions',()=>{
  test('[UT-REPORT-001] Open and one-sided date filters preserve Vietnam timezone metadata',()=>{
    assert.deepEqual(dateRange({},fail),{dateFrom:null,dateTo:null,timeZone:'Asia/Ho_Chi_Minh'});
    assert.deepEqual(dateRange({dateFrom:'2028-02-29'},fail),{dateFrom:'2028-02-29',dateTo:null,timeZone:'Asia/Ho_Chi_Minh'});
    assert.deepEqual(dateRange({dateTo:'2028-03-01'},fail),{dateFrom:null,dateTo:'2028-03-01',timeZone:'Asia/Ho_Chi_Minh'});
  });
  test('[UT-REPORT-002] Reporting range accepts real leap days and rejects normalized impossible dates',()=>{
    assert.equal(dateRange({dateFrom:'2000-02-29',dateTo:'2000-02-29'},fail).dateFrom,'2000-02-29');
    for(const dateFrom of ['2100-02-29','2028-02-30','2028-04-31','2028-13-01','2028-2-01','2028-01-01T00:00:00Z','1899-12-31','9999-01-01',[],{}])assert.throws(()=>dateRange({dateFrom},fail),invalidRange);
  });
  test('[UT-REPORT-003] Inclusive report range permits 366 calendar days and rejects longer or reversed ranges',()=>{
    assert.deepEqual(dateRange({dateFrom:'2028-01-01',dateTo:'2028-12-31'},fail),{dateFrom:'2028-01-01',dateTo:'2028-12-31',timeZone:'Asia/Ho_Chi_Minh'});
    assert.throws(()=>dateRange({dateFrom:'2028-01-01',dateTo:'2029-01-01'},fail),invalidRange);
    assert.throws(()=>dateRange({dateFrom:'2028-03-01',dateTo:'2028-02-29'},fail),invalidRange);
  });
  test('[UT-REPORT-004] Receipt filters include the full local last day using an exclusive UTC endpoint',()=>{
    const clauses=['b.operator_id=?'],args=['operator-unit'];
    addDateClauses(clauses,args,'p.created_at',{dateFrom:'2028-02-29',dateTo:'2028-02-29'});
    assert.deepEqual(clauses,['b.operator_id=?','p.created_at>=?','p.created_at<?']);assert.deepEqual(args,['operator-unit','2028-02-28T17:00:00.000Z','2028-02-29T17:00:00.000Z']);
    const included=['2028-02-28T17:00:00.000Z','2028-02-29T16:59:59.999Z'],excluded=['2028-02-28T16:59:59.999Z','2028-02-29T17:00:00.000Z'];
    assert.ok(included.every(time=>time>=args[1]&&time<args[2]));assert.ok(excluded.every(time=>!(time>=args[1]&&time<args[2])));
  });
  test('[UT-REPORT-005] Trip calendar filters preserve inclusive dates without converting them to UTC timestamps',()=>{
    const clauses=[],args=[];addDateClauses(clauses,args,'t.date',{dateFrom:'2027-12-31',dateTo:'2028-01-01'},{calendarDate:true});
    assert.deepEqual(clauses,['t.date>=?','t.date<=?']);assert.deepEqual(args,['2027-12-31','2028-01-01']);
    const openClauses=[],openArgs=[];addDateClauses(openClauses,openArgs,'t.date',{dateFrom:null,dateTo:null});assert.deepEqual(openClauses,[]);assert.deepEqual(openArgs,[]);
  });
  test('[UT-REPORT-006] Historical ownership and routes use booking snapshots before current inventory fallbacks',()=>{
    const sqlite=bookingTripField({dialect:'sqlite'},'operatorId','t.operator_id'),postgres=bookingTripField({dialect:'postgres'},'operatorId','t.operator_id');
    assert.match(sqlite,/json_extract\(b\.data,'\$\.trip\.operatorId'\)/);assert.match(postgres,/b\.data::jsonb->'trip'->>'operatorId'/);
    for(const expression of [sqlite,postgres]){assert.ok(expression.startsWith('COALESCE(NULLIF('));assert.ok(expression.endsWith(",''),t.operator_id)"));}
    assert.match(bookingTripField({dialect:'sqlite'},'from','t.from_id'),/trip\.from/);assert.match(bookingTripField({dialect:'postgres'},'to','t.to_id'),/->>'to'/);
  });
});
