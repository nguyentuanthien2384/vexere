'use strict';

const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {fetchOperatorFeed,getOperatorFeedStatus} = require('../server/operator-feed');

let server,base,responder,requests = 0,lastAuthorization;
const token = 'secret-partner-token-not-for-response';
const trip = (extra = {}) => ({externalId:'PARTNER-001',from:'ho-chi-minh',to:'da-lat',date:'2027-01-10',departureTime:'18:00',type:'limousine',price:250000,totalSeats:9,durationMinutes:360,pickupPoints:['Bến xe đối tác'],dropoffPoints:['Bến xe Đà Lạt'],...extra});
const feed = (trips = [trip()]) => ({version:1,sourceReference:'Phân bổ kho riêng theo hợp đồng thử nghiệm',trips});
const env = (extra = {}) => ({NODE_ENV:'test',OPERATOR_FEED_URL:base+'/feed?private=unprinted-query',OPERATOR_FEED_TOKEN:token,OPERATOR_FEED_OPERATOR_ID:'operator-contracted',...extra});
function respond(body) { responder = (req,res) => {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));}; }
async function rejectsSafely(work,code) {
  await assert.rejects(work,error => {
    assert.equal(error.code,code);
    assert.ok([502,503].includes(error.status));
    const exposed = error.message+JSON.stringify(error);
    for (const secret of [token,base,'unprinted-query','secret-upstream-customer']) assert.ok(!exposed.includes(secret),'error exposed private data');
    return true;
  });
}
before(async () => {
  server = http.createServer((req,res) => {requests++;lastAuthorization=req.headers.authorization;responder(req,res);});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  base = 'http://127.0.0.1:'+server.address().port;
});
after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});

test('feed configuration is explicit and HTTPS is required outside local development',async () => {
  assert.equal(getOperatorFeedStatus({}).configured,false);
  assert.equal(getOperatorFeedStatus({}).missingConfiguration.length,3);
  const initial = requests;
  for (const configuration of [env({OPERATOR_FEED_TOKEN:''}),env({NODE_ENV:'production'}),env({OPERATOR_FEED_URL:'http://partner.example.test/feed'}),env({OPERATOR_FEED_URL:'ftp://partner.example.test/feed'}),env({OPERATOR_FEED_URL:'https://user:password@partner.example.test/feed'}),env({OPERATOR_FEED_URL:'https://partner.example.test/feed#secret'}),env({OPERATOR_FEED_TOKEN:'token\r\nheader:bad'}),env({OPERATOR_FEED_OPERATOR_ID:'bad operator'}),env({OPERATOR_FEED_TIMEOUT_MS:'0'})]) {
    assert.equal(getOperatorFeedStatus(configuration).configured,false);
    await rejectsSafely(() => fetchOperatorFeed(configuration),'OPERATOR_FEED_NOT_CONFIGURED');
  }
  assert.equal(requests,initial);
  const production = getOperatorFeedStatus(env({NODE_ENV:'production',OPERATOR_FEED_URL:'https://partner.example.test/feed'}));
  assert.equal(production.configured,true);
  assert.equal(production.externallyVerified,false);
  assert.ok(!JSON.stringify(production).includes('partner.example.test'));
  assert.ok(!JSON.stringify(production).includes('operator-contracted'));
});

test('normalized feed forces configured operator and stable IDs; digest changes with effective data',async () => {
  respond(feed([trip({operatorId:'untrusted-other-operator',id:'untrusted-trip-id',provenance:'untrusted evidence',seatPrices:{A02:270000,A01:260000}}),trip({externalId:'PARTNER-002'})]));
  const first = await fetchOperatorFeed(env());
  assert.equal(lastAuthorization,'Bearer '+token);
  assert.equal(first.operatorId,'operator-contracted');
  assert.match(first.digest,/^[a-f0-9]{64}$/);
  assert.equal(first.trips.length,2);
  for (const item of first.trips) {
    assert.equal(item.operatorId,'operator-contracted');
    assert.match(item.id,/^feed-[a-f0-9]{64}$/);
    assert.equal(item.provenance,first.sourceReference);
  }
  respond(feed([trip({externalId:'PARTNER-002'}),trip({seatPrices:{A01:260000,A02:270000}})]));
  const reordered = await fetchOperatorFeed(env());
  assert.equal(first.digest,reordered.digest);
  assert.deepEqual(first.trips.map(item => item.id),reordered.trips.map(item => item.id));
  respond(feed([trip({price:260000})]));
  const changed = await fetchOperatorFeed(env());
  assert.equal(first.trips.find(item=>item.externalId==='PARTNER-001').id,changed.trips[0].id);
  assert.notEqual(changed.digest,first.digest);
  const otherOperator = await fetchOperatorFeed(env({OPERATOR_FEED_OPERATOR_ID:'operator-other'}));
  assert.notEqual(otherOperator.trips[0].id,changed.trips[0].id);
  assert.equal(otherOperator.trips[0].operatorId,'operator-other');
});

test('invalid normalized payloads and duplicate IDs fail before import',async () => {
  for (const body of [null,[],{...feed(),version:2},{...feed(),sourceReference:'x'},{...feed(),customer:'secret-upstream-customer'},feed(Array.from({length:501},(_,i)=>trip({externalId:String(i)}))),feed([null]),feed([trip({externalId:''})]),feed([trip({date:'2027-02-30'})]),feed([trip({price:'250000'})]),feed([trip({totalSeats:61})]),feed([trip({pickupPoints:[]})]),feed([trip({seatPrices:{A01:1}})]),feed([trip({active:'false'})])]) {
    respond(body);
    await rejectsSafely(() => fetchOperatorFeed(env()),'OPERATOR_FEED_INVALID');
  }
  respond(feed([trip(),trip({externalId:' PARTNER-001 '})]));
  await rejectsSafely(() => fetchOperatorFeed(env()),'OPERATOR_FEED_DUPLICATE');
  respond(feed([]));
  assert.deepEqual((await fetchOperatorFeed(env())).trips,[]);
});

test('external seat availability, bookings and unknown fields are refused',async () => {
  for (const field of ['seats','bookedSeats','availableSeats','reservedSeats','remainingSeats','seatAvailability','heldSeats','occupiedSeats','seatMap','availability','bookings','holds']) {
    respond(feed([trip({[field]:[]})]));
    await rejectsSafely(() => fetchOperatorFeed(env()),'OPERATOR_FEED_UNSUPPORTED_INVENTORY');
  }
  respond(feed([trip({unexpectedCustomerData:'secret-upstream-customer'})]));
  await rejectsSafely(() => fetchOperatorFeed(env()),'OPERATOR_FEED_INVALID');
});

test('upstream HTTP errors, redirects and invalid content never expose upstream details',async () => {
  responder = (req,res) => {res.writeHead(401,{'content-type':'application/json'});res.end('{"error":"secret-upstream-customer '+token+'"}');};
  await rejectsSafely(() => fetchOperatorFeed(env()),'OPERATOR_FEED_UPSTREAM');
  const initial = requests;
  responder = (req,res) => {res.writeHead(302,{location:base+'/redirected'});res.end();};
  await rejectsSafely(() => fetchOperatorFeed(env()),'OPERATOR_FEED_UPSTREAM');
  assert.equal(requests,initial+1,'must not follow redirects with partner credentials');
  for (const [contentType,raw] of [['text/html','secret-upstream-customer'],['application/json','not JSON secret-upstream-customer']]) {
    responder = (req,res) => {res.writeHead(200,{'content-type':contentType});res.end(raw);};
    await rejectsSafely(() => fetchOperatorFeed(env()),'OPERATOR_FEED_INVALID');
  }
});

test('response limit covers declared and streamed sizes',async () => {
  responder = (req,res) => {res.writeHead(200,{'content-type':'application/json','content-length':String(1024*1024+1)});res.flushHeaders();};
  await rejectsSafely(() => fetchOperatorFeed(env()),'OPERATOR_FEED_TOO_LARGE');
  responder = (req,res) => {res.writeHead(200,{'content-type':'application/json'});res.write(' '.repeat(600000));res.end(' '.repeat(600000));};
  await rejectsSafely(() => fetchOperatorFeed(env()),'OPERATOR_FEED_TOO_LARGE');
});

test('timeout bounds both response headers and slow response bodies',async () => {
  responder = () => {};
  await rejectsSafely(() => fetchOperatorFeed(env({OPERATOR_FEED_TIMEOUT_MS:'100'})),'OPERATOR_FEED_TIMEOUT');
  responder = (req,res) => {res.writeHead(200,{'content-type':'application/json'});res.write('{"version":1,');};
  await rejectsSafely(() => fetchOperatorFeed(env({OPERATOR_FEED_TIMEOUT_MS:'100'})),'OPERATOR_FEED_TIMEOUT');
});
