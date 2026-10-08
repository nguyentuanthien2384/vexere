'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openDatabase}=require('../server/database');
const {initializeCatalog}=require('../server/catalog');
const {initializeDemoFixtures}=require('../server/demo-fixtures');

test('demo scenarios remain coherent and idempotent, including inventory and round-trip linkage',async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ticket4t-fixtures-'));
  const env={NODE_ENV:'development',SEED_DEMO:'true'};
  const db=await openDatabase({env,dataDir});
  try {
    await initializeCatalog(db,{seedDemo:true,env,days:5});
    await initializeDemoFixtures(db,{seedDemo:true,env});
    const first=Number((await db.get('SELECT COUNT(*) AS n FROM bookings')).n);
    assert.ok(first>=15,'Sample scenarios contain useful booking statuses');
    await initializeDemoFixtures(db,{seedDemo:true,env});
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM bookings')).n),first,'Startup does not duplicate sample orders');
    const rows=await db.all('SELECT * FROM bookings');
    for (const row of rows) {
      const data=JSON.parse(row.data);
      assert.equal(data.isDemo,true);
      const reserved=await db.all('SELECT seat FROM reserved_seats WHERE booking_code=?',[row.code]);
      if (['reserved','confirmed','pending_payment'].includes(row.status)) assert.deepEqual(reserved.map(s=>s.seat).sort(),data.seats.slice().sort());
      else assert.equal(reserved.length,0);
      assert.equal(row.total,data.subtotal-data.discount);
    }
    const order=await db.get('SELECT * FROM orders WHERE code=?',['T4ODEMOROUND']);
    const codes=JSON.parse(order.data).bookingCodes;
    assert.equal(codes.length,2);
    let sum=0;
    for (const code of codes) {const booking=await db.get('SELECT total,order_code FROM bookings WHERE code=?',[code]);assert.equal(booking.order_code,order.code);sum+=booking.total;}
    assert.equal(sum,order.total);
    const promos=await db.all('SELECT * FROM promotions');
    assert.equal(promos.length,6);
    assert.ok(promos.every(p=>JSON.parse(p.data).source==='demo'));
    assert.ok(promos.some(p=>new Date(JSON.parse(p.data).expiresAt)<new Date()));
    assert.ok(promos.some(p=>p.used_count===JSON.parse(p.data).maxUses));
    assert.equal((await db.get('SELECT role,operator_id FROM users WHERE email=?',['operator@ticket4t.vn'])).operator_id,'demo-op-1');
    const manifest=JSON.parse((await db.get('SELECT value FROM settings WHERE key=?',['demo_scenarios'])).value);
    assert.equal(manifest.bookings.length,rows.length);
    assert.match(manifest.note,/không có giao dịch tiền thật/);
  } finally {await db.close();fs.rmSync(dataDir,{recursive:true,force:true});}
});

test('sample fixture initialization never populates production or disabled demo databases',async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ticket4t-fixtures-production-'));
  const db=await openDatabase({env:{},dataDir});
  try {
    await initializeDemoFixtures(db,{seedDemo:true,env:{NODE_ENV:'production'}});
    await initializeDemoFixtures(db,{seedDemo:false,env:{NODE_ENV:'development'}});
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM bookings')).n),0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM promotions')).n),0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM users')).n),0);
  } finally {await db.close();fs.rmSync(dataDir,{recursive:true,force:true});}
});
