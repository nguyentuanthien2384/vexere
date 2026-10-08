'use strict';

const {todayVietnam,addDays}=require('./catalog');
const DAY=86400000;
function isDate(value) {return typeof value==='string' && value>='1900-01-01' && value<='9998-12-31' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function dateRange(query,fail) {
  const dateFrom=query.dateFrom || null,dateTo=query.dateTo || null;
  if ((dateFrom && !isDate(dateFrom)) || (dateTo && !isDate(dateTo))) fail(400,'Khoảng ngày không hợp lệ.');
  if (dateFrom && dateTo && (dateFrom>dateTo || (Date.parse(dateTo)-Date.parse(dateFrom))/DAY>365)) fail(400,'Ngày bắt đầu phải trước ngày kết thúc và khoảng lọc tối đa 366 ngày.');
  return {dateFrom,dateTo,timeZone:'Asia/Ho_Chi_Minh'};
}
function addDateClauses(clauses,args,column,range,{calendarDate=false}={}) {
  if (range.dateFrom) {clauses.push(column+'>=?');args.push(calendarDate ? range.dateFrom : new Date(range.dateFrom+'T00:00:00+07:00').toISOString());}
  if (range.dateTo) {clauses.push(column+(calendarDate ? '<=?' : '<?'));args.push(calendarDate ? range.dateTo : new Date(addDays(range.dateTo,1)+'T00:00:00+07:00').toISOString());}
}
const where=clauses=>clauses.length ? ' WHERE '+clauses.join(' AND ') : '';
const number=value=>Number(value || 0);
function bookingTripField(db,field,fallback) {
  const stored=db.dialect==='postgres' ? "(b.data::jsonb->'trip'->>'"+field+"')" : "json_extract(b.data,'$.trip."+field+"')";
  return 'COALESCE(NULLIF('+stored+",''),"+fallback+')';
}

async function adminStats({db,user,query,fail,paymentMethods,dataMode}) {
  const range=dateRange(query,fail),scoped=user.role==='operator';
  const bookingOperator=bookingTripField(db,'operatorId','t.operator_id'),bookingFromLocation=bookingTripField(db,'from','t.from_id'),bookingToLocation=bookingTripField(db,'to','t.to_id');
  const conditions=(alias,historical=false)=>({clauses:scoped ? [(historical ? bookingOperator : alias+'.operator_id')+'=?'] : [],args:scoped ? [user.operatorId || ''] : []});
  const trips=conditions('t');addDateClauses(trips.clauses,trips.args,'t.date',range,{calendarDate:true});
  const tripCounts=await db.get("SELECT COUNT(*) AS trips,SUM(CASE WHEN t.source='managed' THEN 1 ELSE 0 END) AS managed,SUM(CASE WHEN t.source='demo' THEN 1 ELSE 0 END) AS demo,SUM(CASE WHEN t.active=1 AND o.active=1 AND t.departure_at>? THEN 1 ELSE 0 END) AS active FROM trips t JOIN operators o ON o.id=t.operator_id"+where(trips.clauses),[new Date(Date.now()+30*60000).toISOString(),...trips.args]);
  const capacity=await db.get('SELECT COALESCE(SUM(t.total_seats),0) AS capacity,(SELECT COUNT(*) FROM reserved_seats s JOIN trips t ON t.id=s.trip_id'+where(trips.clauses)+') AS booked,(SELECT COUNT(*) FROM hold_seats s JOIN trips t ON t.id=s.trip_id'+where(trips.clauses)+') AS held FROM trips t'+where(trips.clauses),[...trips.args,...trips.args,...trips.args]);
  const bookingFilter=conditions('t',true);addDateClauses(bookingFilter.clauses,bookingFilter.args,'b.created_at',range);
  const bookingFrom=' FROM bookings b JOIN trips t ON t.id=b.trip_id'+where(bookingFilter.clauses);
  const bookingTotals=await db.get("SELECT COUNT(*) AS bookings,SUM(CASE WHEN b.status IN ('pending_payment','reserved') THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN b.status='confirmed' THEN 1 ELSE 0 END) AS confirmed,SUM(CASE WHEN b.status='cancelled' THEN 1 ELSE 0 END) AS cancelled,SUM(CASE WHEN b.status='expired' THEN 1 ELSE 0 END) AS expired,SUM(CASE WHEN b.status IN ('reserved','confirmed') AND b.payment_status='pending' THEN b.total ELSE 0 END) AS outstanding,SUM(CASE WHEN b.payment_status='refund_pending' THEN b.total ELSE 0 END) AS refund_pending"+bookingFrom,bookingFilter.args);
  const financialFilter=conditions('t',true);financialFilter.clauses.push("p.status IN ('paid','refund_pending','refunded')");addDateClauses(financialFilter.clauses,financialFilter.args,'p.created_at',range);
  const paymentFrom=' FROM payments p JOIN bookings b ON b.code=p.booking_code JOIN trips t ON t.id=b.trip_id'+where(financialFilter.clauses);
  // A verified late online payment has collected funds even though its seat
  // cannot be fulfilled. Its receipt remains refund_pending until reconciled.
  const moneyColumns="SUM(CASE WHEN p.status IN ('paid','refund_pending') THEN p.amount ELSE 0 END) AS gross,SUM(CASE WHEN p.status='refunded' THEN p.amount ELSE 0 END) AS refunded";
  const financial=await db.get('SELECT '+moneyColumns+paymentFrom,financialFilter.args);
  const operators=await db.get('SELECT COUNT(*) AS n FROM operators'+(scoped ? ' WHERE id=?' : ''),scoped ? [user.operatorId || ''] : []);
  const byStatus=(await db.all('SELECT b.status,COUNT(*) AS bookings'+bookingFrom+' GROUP BY b.status',bookingFilter.args)).map(row=>({status:row.status,bookings:number(row.bookings)}));
  // Monetary breakdowns use receipt dates. Booking counts use creation dates.
  // Aggregating separately avoids multiplying receipts when a booking has a refund.
  async function breakdown(fields,group,shape) {
    const rows=await db.all('SELECT '+fields+',COUNT(*) AS bookings'+bookingFrom+' GROUP BY '+group,bookingFilter.args);
    const receipts=await db.all('SELECT '+fields+','+moneyColumns+paymentFrom+' GROUP BY '+group,financialFilter.args);
    const entries=new Map();
    for (const row of rows) {const value=shape(row);entries.set(JSON.stringify(value),{...value,bookings:number(row.bookings),revenue:0});}
    for (const row of receipts) {const value=shape(row),key=JSON.stringify(value),entry=entries.get(key) || {...value,bookings:0,revenue:0};entry.revenue=number(row.gross)-number(row.refunded);entries.set(key,entry);}
    return [...entries.values()].sort((a,b)=>b.revenue-a.revenue || b.bookings-a.bookings);
  }
  const byPaymentMethod=await breakdown('b.payment_method','b.payment_method',row=>({paymentMethod:row.payment_method}));
  const byOperator=await breakdown(bookingOperator+' AS operator_id',bookingOperator,row=>({operatorId:row.operator_id}));
  const operatorRows=await db.all('SELECT id,name FROM operators'+(scoped ? ' WHERE id=?' : ''),scoped ? [user.operatorId || ''] : []),operatorNames=new Map(operatorRows.map(row=>[row.id,row.name]));
  byOperator.forEach(row=>{row.operatorName=operatorNames.get(row.operatorId) || row.operatorId;});
  const byRoute=await breakdown(bookingFromLocation+' AS from_id,'+bookingToLocation+' AS to_id',bookingFromLocation+','+bookingToLocation,row=>({from:row.from_id,to:row.to_id}));
  const locationRows=await db.all('SELECT id,name FROM locations'),locationNames=new Map(locationRows.map(row=>[row.id,row.name]));
  byRoute.forEach(row=>{row.fromName=locationNames.get(row.from) || row.from;row.toName=locationNames.get(row.to) || row.to;});
  const dailyEnd=range.dateTo || (range.dateFrom && range.dateFrom>todayVietnam() ? range.dateFrom : todayVietnam()),dailyStart=range.dateFrom || addDays(dailyEnd,-13);
  const dailyRange={dateFrom:dailyStart,dateTo:dailyEnd};
  // A one-sided historical filter may span years; charts show at most 366 days.
  if ((Date.parse(dailyEnd)-Date.parse(dailyStart))/DAY>365) dailyRange.dateFrom=addDays(dailyEnd,-365);
  const dayExpr=column=>db.dialect==='postgres' ? "TO_CHAR(("+column+"::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh'),'YYYY-MM-DD')" : "DATE("+column+",'+7 hours')";
  const dailyBookings=conditions('t',true);addDateClauses(dailyBookings.clauses,dailyBookings.args,'b.created_at',dailyRange);
  const dailyPayments=conditions('t',true);dailyPayments.clauses.push("p.status IN ('paid','refund_pending','refunded')");addDateClauses(dailyPayments.clauses,dailyPayments.args,'p.created_at',dailyRange);
  const bookingDays=await db.all('SELECT '+dayExpr('b.created_at')+' AS day,COUNT(*) AS bookings FROM bookings b JOIN trips t ON t.id=b.trip_id'+where(dailyBookings.clauses)+' GROUP BY '+dayExpr('b.created_at'),dailyBookings.args);
  const paymentDays=await db.all('SELECT '+dayExpr('p.created_at')+' AS day,'+moneyColumns+' FROM payments p JOIN bookings b ON b.code=p.booking_code JOIN trips t ON t.id=b.trip_id'+where(dailyPayments.clauses)+' GROUP BY '+dayExpr('p.created_at'),dailyPayments.args);
  const dayBookings=new Map(bookingDays.map(row=>[row.day,number(row.bookings)])),dayPayments=new Map(paymentDays.map(row=>[row.day,row]));
  const daily=[];for (let date=dailyRange.dateFrom;date<=dailyRange.dateTo;date=addDays(date,1)) {const item=dayPayments.get(date);daily.push({date,bookings:dayBookings.get(date) || 0,grossRevenue:number(item?.gross),refundedAmount:number(item?.refunded),revenue:number(item?.gross)-number(item?.refunded)});}
  const occupied=number(capacity.booked)+number(capacity.held),seats=number(capacity.capacity);
  return {stats:{trips:number(tripCounts.trips),managedTrips:number(tripCounts.managed),demoTrips:number(tripCounts.demo),activeTrips:number(tripCounts.active),operators:number(operators.n),bookings:number(bookingTotals.bookings),pendingBookings:number(bookingTotals.pending),confirmedBookings:number(bookingTotals.confirmed),cancelledBookings:number(bookingTotals.cancelled),expiredBookings:number(bookingTotals.expired),grossRevenue:number(financial.gross),refundedAmount:number(financial.refunded),revenue:number(financial.gross)-number(financial.refunded),outstandingAmount:number(bookingTotals.outstanding),refundPendingAmount:number(bookingTotals.refund_pending),occupiedSeats:occupied,availableSeats:Math.max(0,seats-occupied),occupancyRate:seats ? Math.round(occupied/seats*1000)/10 : 0},range,analytics:{daily,dailyRange,byStatus,byPaymentMethod,byOperator,byRoute},dataMode,paymentMethods};
}

module.exports={adminStats,dateRange,addDateClauses,bookingTripField};
