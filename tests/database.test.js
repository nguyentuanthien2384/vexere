'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {openDatabase,DatabaseSessionStore}=require('../server/database');

async function databaseFixture(t,prepare){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ticket4t-database-it-'));
  const fixture={directory,db:null};
  t.after(async()=>{
    const errors=[];
    try{await fixture.db?.close();}catch(error){errors.push(error);}
    try{const target=path.resolve(directory);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('ticket4t-database-it-'));await fs.rm(target,{recursive:true,force:true});}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'SQLite fixture cleanup failed');
  });
  fixture.close=async()=>{if(fixture.db){await fixture.db.close();fixture.db=null;}};
  fixture.reopen=async()=>{await fixture.close();fixture.db=await openDatabase({env:{NODE_ENV:'test'},dataDir:directory});return fixture.db;};
  if(prepare)await prepare(path.join(directory,'ticket4t.sqlite'));
  await fixture.reopen();assert.equal(fixture.db.dialect,'sqlite');assert.equal(fixture.db.filename,path.join(directory,'ticket4t.sqlite'));
  return fixture;
}
function sessionCall(store,method,...args){return new Promise((resolve,reject)=>{store[method](...args,(error,value)=>error?reject(error):resolve(value));});}
async function seedTrip(db){
  await db.transaction(async tx=>{
    for(const [id,name] of [['origin','Điểm đi'],['destination','Điểm đến']])await tx.run('INSERT INTO locations(id,name,region,image) VALUES(?,?,?,?)',[id,name,'test','']);
    await tx.run('INSERT INTO operators(id,name,data) VALUES(?,?,?)',['operator','Nhà xe thử nghiệm','{}']);
    await tx.run('INSERT INTO trips(id,operator_id,from_id,to_id,date,departure_time,departure_at,price,total_seats,type,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)',['trip','operator','origin','destination','2027-01-01','08:00','2027-01-01T01:00:00.000Z',250000,9,'limousine','{}']);
  });
}

test('[IT-DB-001] committed transactions return their result and persist every write after reopening SQLite',async t=>{
  const f=await databaseFixture(t),expected={saved:2};
  const result=await f.db.transaction(async tx=>{await tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['first','Đà Lạt']);await tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['second','Literal ? and quoted \' text']);return expected;});
  assert.equal(result,expected);await f.reopen();assert.deepEqual((await f.db.all('SELECT key,value FROM settings ORDER BY key')).map(row=>[row.key,row.value]),[['first','Đà Lạt'],['second','Literal ? and quoted \' text']]);
});

test('[IT-DB-002] a rejected transaction rolls back both updates and all preceding inserts',async t=>{
  const f=await databaseFixture(t),failure=new Error('Expected transaction rejection');
  await f.db.transaction(tx=>tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['existing','original']));
  await assert.rejects(f.db.transaction(async tx=>{await tx.run('UPDATE settings SET value=? WHERE key=?',['changed','existing']);await tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['temporary-one','one']);await tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['temporary-two','two']);throw failure;}),error=>error===failure);
  await f.reopen();assert.deepEqual((await f.db.all('SELECT key,value FROM settings')).map(row=>[row.key,row.value]),[['existing','original']]);
});

test('[IT-DB-003] queued transactions wait for an earlier rejection and the queue remains usable',async t=>{
  const f=await databaseFixture(t),events=[],failure=new Error('First transaction rejected');let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const first=f.db.transaction(async tx=>{events.push('first');started();await tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['rolled-back','temporary']);await gate;throw failure;});
  await entered;
  const next=f.db.transaction(async tx=>{events.push('next');await tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['next','saved']);return 'committed';});
  const outcomes=Promise.allSettled([first,next]);
  try{await Promise.resolve();assert.deepEqual(events,['first']);}finally{release();}
  const results=await outcomes;assert.equal(results[0].status,'rejected');assert.equal(results[0].reason,failure);assert.deepEqual(results[1],{status:'fulfilled',value:'committed'});assert.deepEqual(events,['first','next']);assert.equal(await f.db.get('SELECT value FROM settings WHERE key=?',['rolled-back']),undefined);
  await f.db.transaction(tx=>tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['after','still usable']));assert.equal((await f.db.get('SELECT value FROM settings WHERE key=?',['after'])).value,'still usable');
});

test('[IT-DB-004] concurrent inserts for a unique key commit exactly one winner',async t=>{
  const f=await databaseFixture(t);
  const results=await Promise.allSettled(Array.from({length:8},(_,index)=>f.db.transaction(async tx=>{await tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['contended',String(index)]);return index;})));
  const winners=results.filter(result=>result.status==='fulfilled'),rejected=results.filter(result=>result.status==='rejected');assert.equal(winners.length,1);assert.equal(rejected.length,7);for(const result of rejected)assert.match(result.reason.message,/UNIQUE constraint failed/i);
  const rows=await f.db.all('SELECT value FROM settings WHERE key=?',['contended']);assert.equal(rows.length,1);assert.equal(rows[0].value,String(winners[0].value));
});

test('[IT-DB-005] foreign keys reject orphan users and deletion of an operator that still has a user',async t=>{
  const f=await databaseFixture(t),insertUser=tx=>tx.run('INSERT INTO users(id,full_name,email,phone,password_hash,operator_id,created_at) VALUES(?,?,?,?,?,?,?)',['user','Nhân viên','staff@example.test','0901234567','test-password-hash','operator','2027-01-01T00:00:00.000Z']);
  await assert.rejects(f.db.transaction(async tx=>{await tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['before-fk','temporary']);await insertUser(tx);}),/FOREIGN KEY constraint failed/i);assert.equal(await f.db.get('SELECT value FROM settings WHERE key=?',['before-fk']),undefined);
  await f.db.transaction(async tx=>{await tx.run('INSERT INTO operators(id,name,data) VALUES(?,?,?)',['operator','Nhà xe thử nghiệm','{}']);await insertUser(tx);});
  await assert.rejects(f.db.transaction(tx=>tx.run('DELETE FROM operators WHERE id=?',['operator'])),/FOREIGN KEY constraint failed/i);assert.equal((await f.db.get('SELECT operator_id FROM users WHERE id=?',['user'])).operator_id,'operator');assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM operators')).n,1);
});

test('[IT-DB-006] SQLite Vietnamese case folding supports accented operator searches',async t=>{
  const f=await databaseFixture(t);
  assert.equal((await f.db.get('SELECT vi_lower(?) AS normalized',['ĐÀ LẠT – BẾN XE MIỀN ĐÔNG'])).normalized,'đà lạt – bến xe miền đông');assert.equal((await f.db.get('SELECT vi_lower(NULL) AS normalized')).normalized,'');assert.equal((await f.db.get('SELECT vi_lower(?) AS normalized',[42])).normalized,'42');
  await f.db.transaction(tx=>tx.run('INSERT INTO operators(id,name,data) VALUES(?,?,?)',['operator','AN VIỆT ĐÀ LẠT','{}']));assert.deepEqual((await f.db.all('SELECT id FROM operators WHERE vi_lower(name) LIKE ?',['%việt đà lạt%'])).map(row=>row.id),['operator']);
});

test('[IT-DB-007] opening a legacy SQLite schema adds missing account and booking columns without resetting existing data',async t=>{
  const f=await databaseFixture(t,async filename=>{
    const legacy=new DatabaseSync(filename);
    try{legacy.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,full_name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,phone TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',operator_id TEXT,verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE bookings(code TEXT PRIMARY KEY,trip_id TEXT NOT NULL,user_id TEXT,phone TEXT NOT NULL,email TEXT NOT NULL,status TEXT NOT NULL,payment_status TEXT NOT NULL DEFAULT 'pending',payment_method TEXT NOT NULL,total INTEGER NOT NULL,expires_at TEXT,created_at TEXT NOT NULL,data TEXT NOT NULL);
INSERT INTO users(id,full_name,email,phone,password_hash,created_at) VALUES('legacy-user','Khách cũ','legacy@example.test','0901234567','legacy-hash','2020-01-01T00:00:00.000Z');`);}finally{legacy.close();}
  });
  const user=await f.db.get('SELECT full_name,active,auth_version FROM users WHERE id=?',['legacy-user']);assert.equal(user.full_name,'Khách cũ');assert.equal(user.active,1);assert.equal(user.auth_version,1);
  for(const [table,columns] of [['users',['active','auth_version']],['bookings',['order_code','promo_code']]]){const actual=(await f.db.all('PRAGMA table_info('+table+')')).map(row=>row.name);for(const column of columns)assert.equal(actual.filter(name=>name===column).length,1);}
  await seedTrip(f.db);await f.db.transaction(async tx=>{await tx.run('INSERT INTO bookings(code,trip_id,user_id,phone,email,status,payment_method,total,created_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)',['legacy-compatible-booking','trip','legacy-user','0901234567','legacy@example.test','reserved','cash',250000,'2027-01-01T00:00:00.000Z','{}']);await tx.run('UPDATE users SET active=0,auth_version=5 WHERE id=?',['legacy-user']);});
  assert.equal((await f.db.get('SELECT order_code,promo_code FROM bookings WHERE code=?',['legacy-compatible-booking'])).order_code,null);assert.equal((await f.db.get('SELECT order_code,promo_code FROM bookings WHERE code=?',['legacy-compatible-booking'])).promo_code,null);
  await f.reopen();const reopened=await f.db.get('SELECT active,auth_version FROM users WHERE id=?',['legacy-user']);assert.equal(reopened.active,0);assert.equal(reopened.auth_version,5);assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM bookings')).n,1);
});

test('[IT-DB-008] session upsert and touch replace one stored session and extend its expiration',async t=>{
  const f=await databaseFixture(t),store=new DatabaseSessionStore(f.db),sid='session-upsert';
  const first={cookie:{expires:'2098-01-01T00:00:00.000Z'},user:{id:'user',role:'customer'}};await sessionCall(store,'set',sid,first);assert.deepEqual(await sessionCall(store,'get',sid),first);
  const updated={cookie:{expires:'2098-02-01T00:00:00.000Z'},user:{id:'user',role:'operator'},authVersion:2};await sessionCall(store,'set',sid,updated);assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sessions WHERE sid=?',[sid])).n,1);assert.deepEqual(await sessionCall(store,'get',sid),updated);
  const touched={...updated,cookie:{expires:'2098-03-01T00:00:00.000Z'}};await sessionCall(store,'touch',sid,touched);assert.deepEqual(await sessionCall(store,'get',sid),touched);assert.equal((await f.db.get('SELECT expires_at FROM sessions WHERE sid=?',[sid])).expires_at,touched.cookie.expires);
});

test('[IT-DB-009] expired and missing sessions are rejected while sessions without a deadline receive a one-day expiry',async t=>{
  const f=await databaseFixture(t),store=new DatabaseSessionStore(f.db);assert.equal(await sessionCall(store,'get','missing'),null);
  await sessionCall(store,'set','expired',{cookie:{expires:'2000-01-01T00:00:00.000Z'},userId:'expired-user'});assert.equal(await sessionCall(store,'get','expired'),null);
  const before=Date.now(),value={userId:'current-user'};await sessionCall(store,'set','default-expiry',value);const after=Date.now(),expiry=Date.parse((await f.db.get('SELECT expires_at FROM sessions WHERE sid=?',['default-expiry'])).expires_at);assert.ok(expiry>=before+86400000&&expiry<=after+86400000);assert.deepEqual(await sessionCall(store,'get','default-expiry'),value);
});

test('[IT-DB-010] destroying a session removes its stored credentials and is idempotent',async t=>{
  const f=await databaseFixture(t),store=new DatabaseSessionStore(f.db);await sessionCall(store,'set','destroyed',{userId:'user'});await sessionCall(store,'destroy','destroyed');assert.equal(await sessionCall(store,'get','destroyed'),null);assert.equal(await f.db.get('SELECT sid FROM sessions WHERE sid=?',['destroyed']),undefined);await sessionCall(store,'destroy','destroyed');
});

test('[IT-DB-011] session callbacks propagate closed-database errors once for get, set, touch and destroy',async t=>{
  const f=await databaseFixture(t),store=new DatabaseSessionStore(f.db);await f.close();
  for(const method of ['get','set','touch','destroy']){
    const observed=[],args=['failed-session',...(['set','touch'].includes(method)?[{userId:'user'}]:[])];
    await new Promise(resolve=>{store[method](...args,(error,value)=>{observed.push({error,value});resolve();});});await Promise.resolve();assert.equal(observed.length,1,method);assert.ok(observed[0].error instanceof Error,method);assert.equal(observed[0].value,undefined,method);
  }
});

test('[IT-DB-012] database close waits for an active transaction to commit before releasing SQLite',async t=>{
  const f=await databaseFixture(t);let release,started,closed=false;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const work=f.db.transaction(async tx=>{started();await tx.run('INSERT INTO settings(key,value) VALUES(?,?)',['before-close','saved']);await gate;});await entered;
  const closing=f.close().then(()=>{closed=true;});
  try{await Promise.resolve();assert.equal(closed,false);}finally{release();}
  await Promise.all([work,closing]);assert.equal(closed,true);await f.reopen();assert.equal((await f.db.get('SELECT value FROM settings WHERE key=?',['before-close'])).value,'saved');
});
