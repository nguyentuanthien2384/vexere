'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createFeatureFixture} = require('./helpers/feature-fixture');

const fixture = t => createFeatureFixture(t,{databaseUrl:process.env.TEST_DATABASE_URL});
const post = (body,cookie) => ({method:'POST',body,cookie});
const search = async (f,date,query={}) => f.expect(await f.request('/trips?'+new URLSearchParams({date,...query}),{cookie:null}),200).data;

test('[IT-SEARCH-001] trip search rejects repeated scalar fields, prototype enums and malformed filters without server errors',async t => {
  const f=await fixture(t),item=await f.trip();
  const invalid=['q=missing&q=other','q=%00','from=%00','q%5B%5D=missing','pickup%5Bname%5D=missing','time.value=morning','from=ho-chi-minh&from=ha-noi','date='+item.date+'&date='+item.date,
    'time=morning&time=evening','time=constructor','time=__proto__','time=toString','time=invalid','sort=invalid','type=invalid',
    'from=invalid','to=invalid','operator=invalid','from=da-lat&to=da-lat','minPrice=300000&maxPrice=100000',
    'minPrice=NaN','maxPrice=Infinity','minPrice=-1','page=2garbage','limit=2.9','page=0','limit=-1','available=1','q='+encodeURIComponent('x'.repeat(101))];
  for (const query of invalid) {
    const result=f.expect(await f.request('/trips?'+query+(query.startsWith('date=') ? '' : '&date='+item.date),{cookie:null}),400);
    assert.equal(result.data.code,'VALIDATION_ERROR',query);
  }
  const result=await search(f,item.date,{q:'',type:'',available:''});assert.equal(result.total,1);
  assert.equal((await search(f,item.date,{maxPrice:'.5'})).total,0);
  assert.equal((await search(f,item.date,{maxPrice:'1e308'})).total,1);
  assert.equal((await search(f,item.date,{minPrice:'249999.5',maxPrice:'250000.5'})).total,1);
  assert.equal(f.expect(await f.request('/admin/trips?'+new URLSearchParams({date:item.date,minPrice:'249999.5',maxPrice:'250000.5'})),200).data.total,1);
});

test('[IT-SEARCH-002] keyword and stop filters fold Vietnamese encodings and match percent underscore escape and backslash literally',async t => {
  const f=await fixture(t),target=await f.trip({pickupPoints:['Văn phòng ĐÀ NẴNG 50%_! \\ Cổng A'],dropoffPoints:['Bến xe Đà Lạt'.normalize('NFD')]}),other=await f.trip({pickupPoints:['Bến xe Hà Nội'],dropoffPoints:['Văn phòng TP Hồ Chí Minh']});
  for (const query of [{q:'da nang'},{q:'Đà Nẵng'.normalize('NFD')},{pickup:'VAN PHONG DA NANG'},{pickup:'ĐÀ NẴNG'},{dropoff:'Đà Lạt'},{dropoff:'da lat'},{pickup:'50%_!'},{q:'50%_!'},{pickup:'\\ Cổng A'}]) {
    const result=await search(f,target.date,query);assert.deepEqual(result.trips.map(item=>item.id),[target.id],JSON.stringify(query));
  }
  for (const query of [{pickup:'%'},{pickup:'_'},{pickup:'!'},{q:'%'}]) assert.deepEqual((await search(f,target.date,query)).trips.map(item=>item.id),[target.id]);
  assert.equal((await search(f,target.date,{pickup:'50XY'})).total,0);
  assert.equal((await search(f,target.date,{pickup:"' OR 1=1 --"})).total,0);
  assert.equal((await search(f,target.date)).total,2);assert.notEqual(target.id,other.id);
});

test('[IT-SEARCH-003] public price bands require an individual free seat in range and sorting uses the matching price',async t => {
  const f=await fixture(t);
  const expensive=await f.trip({price:100000,totalSeats:2,seatPrices:{A01:300000,A02:500000},departureTime:'06:00'});
  const cheaper=await f.trip({price:200000,totalSeats:1,seatPrices:{A01:200000},departureTime:'18:00'});
  const result=await search(f,expensive.date,{sort:'price'});
  assert.deepEqual(result.trips.map(item=>item.id),[cheaper.id,expensive.id]);
  const trip=result.trips[1];assert.equal(trip.price,100000);assert.equal(trip.displayPrice,300000);assert.equal(trip.minAvailablePrice,300000);assert.equal(trip.maxAvailablePrice,500000);assert.equal(trip.matchingSeats,2);
  assert.equal((await search(f,expensive.date,{minPrice:'350000',maxPrice:'450000'})).total,0,'An interval overlapping min/max is not a seat');
  const band=await search(f,expensive.date,{minPrice:'400000',maxPrice:'500000'});
  assert.equal(band.total,1);assert.equal(band.trips[0].displayPrice,500000);assert.equal(band.trips[0].matchingSeats,1);assert.equal(band.trips[0].minAvailablePrice,300000);
  assert.equal((await search(f,expensive.date,{maxPrice:'199999'})).total,0,'Base fares do not bypass actual seat prices');
  assert.equal((await search(f,expensive.date,{minPrice:'200000',maxPrice:'200000'})).trips[0].id,cheaper.id);
});

test('[IT-SEARCH-004] held and booked seats leave price results and expiry restores only the released seat',async t => {
  const f=await fixture(t),item=await f.trip({price:100000,totalSeats:3,seatPrices:{A02:200000,A03:300000}});
  const held=f.expect(await f.request('/holds',post({tripId:item.id,seats:['A01']},null)),201).data.hold;
  await f.reserve(item,{seats:['A02']});
  let trip=(await search(f,item.date)).trips[0];assert.equal(trip.availableSeats,1);assert.equal(trip.displayPrice,300000);assert.equal(trip.matchingSeats,1);
  assert.equal((await search(f,item.date,{maxPrice:'250000'})).total,0);
  const hash=require('node:crypto').createHash('sha256').update(held.token).digest('hex');
  await f.db.transaction(tx=>tx.run('UPDATE seat_holds SET expires_at=? WHERE hash=?',['2000-01-01T00:00:00.000Z',hash]));
  trip=(await search(f,item.date)).trips[0];assert.equal(trip.availableSeats,2);assert.equal(trip.displayPrice,100000);assert.equal(trip.maxAvailablePrice,300000);
  assert.equal((await search(f,item.date,{minPrice:'150000',maxPrice:'250000'})).total,0,'Booked seat stays unavailable');
  const detail=f.expect(await f.request('/trips/'+item.id,{cookie:null}),200).data;assert.equal(detail.minAvailablePrice,100000);assert.equal(detail.maxAvailablePrice,300000);assert.equal(detail.price,100000);
});

test('[IT-SEARCH-005] sold out trips have null current prices and explicit availability filters partition inventory',async t => {
  const f=await fixture(t),sold=await f.trip({price:100000,totalSeats:1}),free=await f.trip({price:200000,totalSeats:1});
  await f.reserve(sold);
  const all=await search(f,sold.date,{sort:'price'});assert.deepEqual(all.trips.map(item=>item.id),[free.id,sold.id]);
  const empty=all.trips[1];assert.equal(empty.availableSeats,0);assert.equal(empty.displayPrice,null);assert.equal(empty.minAvailablePrice,null);assert.equal(empty.maxAvailablePrice,null);assert.equal(empty.matchingSeats,0);assert.equal(empty.price,100000);
  assert.deepEqual((await search(f,sold.date,{available:'true'})).trips.map(item=>item.id),[free.id]);
  assert.deepEqual((await search(f,sold.date,{available:'false'})).trips.map(item=>item.id),[sold.id]);
  assert.equal((await search(f,sold.date,{available:'false',maxPrice:'300000'})).total,0);
  const detail=f.expect(await f.request('/trips/'+sold.id,{cookie:null}),200).data;assert.equal(detail.minAvailablePrice,null);assert.equal(detail.maxAvailablePrice,null);
});

test('[IT-SEARCH-006] page overshoot clamps to the last stable page and empty results always report page one',async t => {
  const f=await fixture(t),items=[];
  for (const departureTime of ['06:00','12:00','18:00']) items.push(await f.trip({departureTime}));
  const last=await search(f,items[0].date,{page:'99999',limit:'2'});assert.equal(last.page,2);assert.equal(last.pages,2);assert.equal(last.total,3);assert.deepEqual(last.trips.map(item=>item.id),[items[2].id]);
  const empty=await search(f,items[0].date,{q:'absent inventory',page:'9999',limit:'1'});assert.equal(empty.page,1);assert.equal(empty.pages,0);assert.equal(empty.total,0);assert.deepEqual(empty.trips,[]);
  const capped=await search(f,items[0].date,{limit:'9999'});assert.equal(capped.pages,1);assert.equal(capped.trips.length,3);
  const lastAgain=await search(f,items[0].date,{page:'2',limit:'2'});assert.deepEqual(lastAgain.trips.map(item=>item.id),last.trips.map(item=>item.id));
});

test('[IT-SEARCH-007] admin search preserves base fare sorting and price filters without leaking another operator inventory',async t => {
  const f=await fixture(t),first=await f.trip({price:100000,totalSeats:1,seatPrices:{A01:500000}}),second=await f.trip({price:200000,totalSeats:1});
  const foreign=f.expect(await f.request('/admin/operators',post({name:'Nhà xe phạm vi khác',phone:'0901234567'},f.adminCookie)),201).data.operator;
  await f.trip({operatorId:foreign.id,price:150000,totalSeats:1});
  const sorted=f.expect(await f.request('/admin/trips?'+new URLSearchParams({date:first.date,sort:'price'})),200).data;
  assert.equal(sorted.trips[0].id,first.id);assert.equal(sorted.trips[0].price,100000);
  const filtered=f.expect(await f.request('/admin/trips?'+new URLSearchParams({date:first.date,maxPrice:'100000'})),200).data;
  assert.deepEqual(filtered.trips.map(item=>item.id),[first.id]);
  const staff=await f.staff();const login=await f.login(staff.email,'StaffTest@12345');
  const scoped=f.expect(await f.request('/admin/trips?'+new URLSearchParams({date:first.date,sort:'rating',available:'true'}),{cookie:login.cookie}),200).data;
  assert.equal(scoped.total,2);assert.ok(scoped.trips.every(item=>item.operatorId===first.operatorId));assert.ok(scoped.trips.some(item=>item.id===second.id));
  const denied=f.expect(await f.request('/admin/trips?'+new URLSearchParams({date:first.date,operator:foreign.id}),{cookie:login.cookie}),200).data;assert.equal(denied.total,0);
});

test('[IT-SEARCH-008] current display prices do not change checkout base snapshots or authoritative seat totals',async t => {
  const f=await fixture(t),item=await f.trip({price:100000,totalSeats:2,seatPrices:{A01:300000,A02:500000}});
  assert.equal((await search(f,item.date)).trips[0].displayPrice,300000);
  const booking=await f.reserve(item,{seats:['A01','A02'],total:1});assert.equal(booking.total,800000);assert.equal(booking.trip.price,100000);assert.equal(booking.trip.seatPrices.A02,500000);
  const row=await f.db.get('SELECT price FROM trips WHERE id=?',[item.id]);assert.equal(row.price,100000);
});

test('[IT-SEARCH-009] popular route prices follow available seats and omit routes with no bookable seats',async t => {
  const f=await fixture(t),expensive=await f.trip({price:100000,totalSeats:1,seatPrices:{A01:300000}}),cheap=await f.trip({price:100000,totalSeats:1,seatPrices:{A01:200000}});
  const routes=async()=>f.expect(await f.request('/bootstrap',{cookie:null}),200).data.popularRoutes;
  assert.equal((await routes())[0].minPrice,200000);
  await f.reserve(cheap);assert.equal((await routes())[0].minPrice,300000);
  await f.reserve(expensive);assert.deepEqual(await routes(),[]);
});

test('[IT-SEARCH-010] free seat prices respect odd upper deck capacities and all supported physical layouts',async t => {
  const f=await fixture(t),items=[];
  for (const type of ['limousine','seater','sleeper','cabin']) {
    const doubleDeck=['sleeper','cabin'].includes(type),last=doubleDeck?'B02':'A05';
    const item=await f.trip({type,totalSeats:5,price:100000,seatPrices:{A01:200000,[last]:500000}});items.push(item);
    await f.reserve(item,{seats:['A01',last]});
  }
  const result=await search(f,items[0].date);assert.equal(result.total,4);
  for (const trip of result.trips) {assert.equal(trip.availableSeats,3);assert.equal(trip.minAvailablePrice,100000);assert.equal(trip.maxAvailablePrice,100000);assert.equal(trip.matchingSeats,3);}
  assert.equal((await search(f,items[0].date,{minPrice:'200000'})).total,0,'Reserved upper deck labels cannot reappear under another generated number');
});
