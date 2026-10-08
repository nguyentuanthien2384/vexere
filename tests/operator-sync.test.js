'use strict';

const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../index');
const {addDays}=require('../server/catalog');

let runtime,server,feedServer,dataDir,base,adminCookie,operatorCookie,feed,operatorId,date;
async function request(url,{method='GET',body,cookie=adminCookie}={}) {
  const response=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
}
function input(externalId,extra={}) {
  return {externalId,from:'ho-chi-minh',to:'da-lat',date,departureTime:'22:00',type:'sleeper',price:250000,totalSeats:20,durationMinutes:420,pickupPoints:['Bến đi'],dropoffPoints:['Bến đến'],...extra};
}
async function preview() { return request('/admin/integrations/operator-feed/preview',{method:'POST',body:{}}); }
async function apply(digest) { return request('/admin/integrations/operator-feed/apply',{method:'POST',body:{digest}}); }

before(async()=>{
  dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'ticket4t-operator-sync-'));
  feedServer=http.createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer operator-test-token');
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(feed));
  }).listen(0,'127.0.0.1');
  await new Promise(resolve=>feedServer.once('listening',resolve));
  const env={NODE_ENV:'test',SESSION_SECRET:'operator-sync-test-'.repeat(4),SEED_DEMO:'true',OPERATOR_FEED_URL:'http://127.0.0.1:'+feedServer.address().port,OPERATOR_FEED_TOKEN:'operator-test-token',OPERATOR_FEED_OPERATOR_ID:'configured-later'};
  runtime=await createApp({env,dataDir,seedDays:2,disableRateLimit:true});
  server=runtime.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@ticket4t.vn',password:'Admin@12345'})});
  adminCookie=login.headers.get('set-cookie').split(';')[0];
  const created=await request('/admin/operators',{method:'POST',body:{name:'Nhà xe tích hợp kiểm thử',phone:'0901234567',email:'feed@example.com'}});
  assert.equal(created.status,201);
  operatorId=created.data.operator.id;
  env.OPERATOR_FEED_OPERATOR_ID=operatorId;
  const bootstrap=await request('/bootstrap');
  date=addDays(bootstrap.data.today,1);
  assert.equal((await request('/admin/users',{method:'POST',body:{fullName:'Nhân viên kiểm thử',email:'sync-staff@example.com',phone:'0901234567',password:'SyncStaff@12345',role:'operator',operatorId}})).status,201);
  const operatorLogin=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'sync-staff@example.com',password:'SyncStaff@12345'})});
  operatorCookie=operatorLogin.headers.get('set-cookie').split(';')[0];
});

after(async()=>{
  if(server) await new Promise(resolve=>server.close(resolve));
  if(runtime) await runtime.close();
  if(feedServer) await new Promise(resolve=>feedServer.close(resolve));
  if(dataDir) {
    const target=path.resolve(dataDir);
    assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(target).startsWith('ticket4t-operator-sync-'));
    await fs.rm(target,{recursive:true,force:true});
  }
});

test('integration configuration and operator sync are administrator-only',async()=>{
  assert.equal((await request('/admin/integrations',{cookie:null})).status,403);
  assert.equal((await request('/admin/integrations',{cookie:operatorCookie})).status,403);
  assert.equal((await request('/admin/integrations/operator-feed/preview',{method:'POST',body:{},cookie:operatorCookie})).status,403);
  const status=await request('/admin/integrations');
  assert.equal(status.status,200);
  assert.equal(status.data.inventory.providerSync.configured,true);
  assert.ok(!JSON.stringify(status.data).includes('operator-test-token'));
});

test('feed preview writes no inventory; applying twice upserts with stable partner mapping',async()=>{
  feed={version:1,sourceReference:'TEST allocated schedule 001',trips:[input('SYNC-001')]};
  const checked=await preview();
  assert.equal(checked.status,200);
  assert.deepEqual(checked.data.preview.counts,{created:1,updated:0,unchanged:0});
  const id=checked.data.preview.trips[0].id;
  assert.equal(await runtime.api.db.get('SELECT id FROM trips WHERE id=?',[id]),undefined);
  assert.equal((await apply(checked.data.preview.digest)).status,200);
  const repeated=await preview();
  assert.deepEqual(repeated.data.preview.counts,{created:0,updated:0,unchanged:1});
  assert.deepEqual((await apply(repeated.data.preview.digest)).data.sync,{created:0,updated:0,unchanged:1});
  const trip=await request('/trips/'+id);
  assert.equal(trip.data.source,'managed');
  assert.equal(trip.data.operatorId,operatorId);
  assert.equal(trip.data.feedExternalId,'SYNC-001');
  const audit=await runtime.api.db.all("SELECT id FROM admin_audit_events WHERE action='operator_feed_synced'");
  assert.equal(audit.length,1);
});

test('changed upstream content invalidates approval and a fresh preview updates the same trip',async()=>{
  const old=await preview();
  feed.trips[0].price=275000;
  const stale=await apply(old.data.preview.digest);
  assert.equal(stale.status,409);
  assert.equal(stale.data.code,'OPERATOR_FEED_CHANGED');
  const fresh=await preview();
  assert.equal(fresh.data.preview.counts.updated,1);
  assert.equal((await apply(fresh.data.preview.digest)).status,200);
  assert.equal((await request('/trips/'+fresh.data.preview.trips[0].id)).data.price,275000);
});

test('held inventory blocks upstream fare updates and rolls back the complete batch',async()=>{
  const before=await preview(),id=before.data.preview.trips[0].id;
  const hold=await request('/holds',{method:'POST',body:{tripId:id,seats:['A01']},cookie:null});
  assert.equal(hold.status,201);
  // A new trip first in upstream input must also remain absent when another row fails.
  feed.trips=[input('SYNC-002'),input('SYNC-001',{price:300000})];
  const blocked=await preview();
  assert.equal(blocked.status,409);
  assert.equal(blocked.data.code,'HAS_BOOKINGS');
  const count=await runtime.api.db.get('SELECT COUNT(*) AS n FROM trips WHERE operator_id=?',[operatorId]);
  assert.equal(Number(count.n),1);
  assert.equal((await request('/trips/'+id)).data.price,275000);
  await request('/holds/'+hold.data.hold.token,{method:'DELETE',cookie:null});
  const next=await preview();
  assert.equal(next.status,200);
  assert.deepEqual((await apply(next.data.preview.digest)).data.sync,{created:1,updated:1,unchanged:0});
});

test('local reservations created after preview are checked again when applying',async()=>{
  feed.trips=[input('SYNC-001',{price:325000})];
  const checked=await preview(),id=checked.data.preview.trips[0].id;
  const reserved=await request('/bookings',{method:'POST',cookie:null,body:{tripId:id,seats:['A02'],fullName:'Khách kiểm thử',phone:'0901234567',email:'guest@example.com',pickup:'Bến đi',dropoff:'Bến đến',paymentMethod:'cash'}});
  assert.equal(reserved.status,201);
  const blocked=await apply(checked.data.preview.digest);
  assert.equal(blocked.status,409);
  assert.equal(blocked.data.code,'HAS_BOOKINGS');
  assert.equal((await request('/trips/'+id)).data.price,300000);
  await request('/bookings/'+reserved.data.booking.code+'/cancel',{method:'POST',cookie:null,body:{phone:'0901234567'}});
});
