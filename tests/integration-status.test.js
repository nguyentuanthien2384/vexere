'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {getIntegrationStatus} = require('../server/integration-status');
const payments = require('../server/payments');
const {providerConfig} = require('../server/wallet-payments');

function database(dialect = 'sqlite') {
  return {dialect,async get(sql) {
    assert.match(sql,/FROM trips$/);
    assert.ok(!/users|bookings|payments|sessions|email_outbox/.test(sql));
    return {managed_trips:'3',demo_trips:7,active_managed_trips:2,active_demo_trips:'6'};
  }};
}

test('missing integration settings describe development limitations and expose aggregate inventory only',async () => {
  const result = await getIntegrationStatus({db:database(),env:{}});
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.equal(result.inventory.managedTrips,3);
  assert.equal(result.inventory.demoTrips,7);
  assert.equal(result.inventory.activeManagedTrips,2);
  assert.equal(result.inventory.activeDemoTrips,6);
  assert.equal(result.inventory.providerSync.configured,false);
  assert.equal(result.inventory.providerSync.mode,'unavailable');
  assert.equal(result.payments.cash.enabled,true);
  assert.equal(result.payments.vnpay.configured,false);
  assert.equal(result.payments.vnpay.environment,'sandbox');
  assert.equal(result.payments.vnpay.missingConfiguration.length,3);
  assert.equal(result.email.configured,false);
  assert.equal(result.email.mode,'development_outbox');
  assert.equal(result.database.dialect,'sqlite');
  assert.equal(result.database.connected,true);
  assert.equal(result.database.productionReady,false);
});

test('inventory count query works on empty and mixed real SQL inventory without reading trip data',async () => {
  const connection = new DatabaseSync(':memory:');
  try {
    connection.exec('CREATE TABLE trips(source TEXT,active INTEGER,data TEXT)');
    const db = {dialect:'sqlite',async get(sql) {return connection.prepare(sql).get();}};
    const empty = await getIntegrationStatus({db,env:{}});
    assert.equal(empty.inventory.managedTrips,0);
    assert.equal(empty.inventory.demoTrips,0);
    connection.exec("INSERT INTO trips VALUES('managed',1,'private customer data'),('managed',0,'private customer data'),('demo',1,'private customer data')");
    const mixed = await getIntegrationStatus({db,env:{}});
    assert.equal(mixed.inventory.managedTrips,2);
    assert.equal(mixed.inventory.activeManagedTrips,1);
    assert.equal(mixed.inventory.demoTrips,1);
    assert.equal(mixed.inventory.activeDemoTrips,1);
    assert.ok(!JSON.stringify(mixed).includes('private customer data'));
  } finally {connection.close();}
});

test('VNPAY configured matches the runtime helper and distinguishes sandbox, live and invalid endpoints',async () => {
  for (let flags=0;flags<8;flags++) {
    const env = {...(flags&1 ? {VNPAY_TMN_CODE:'private-merchant'} : {}),...(flags&2 ? {VNPAY_HASH_SECRET:'private-key'} : {}),...(flags&4 ? {APP_URL:'https://private-app.test'} : {})};
    const result = await getIntegrationStatus({db:database(),env});
    assert.equal(result.payments.vnpay.configured,payments.configured(env));
    assert.equal(result.payments.vnpay.missingConfiguration.length,3-Number(Boolean(flags&1))-Number(Boolean(flags&2))-Number(Boolean(flags&4)));
  }
  const result = await getIntegrationStatus({db:database('postgres'),env:{NODE_ENV:'production',VNPAY_TMN_CODE:'private-merchant',VNPAY_HASH_SECRET:'private-key',APP_URL:'https://private-app.test'}});
  assert.equal(result.payments.vnpay.configured,true);
  assert.equal(result.payments.vnpay.environment,'sandbox');
  assert.equal(result.payments.vnpay.externallyVerified,false);
  assert.match(result.payments.vnpay.missingConfiguration.join(' '),/VNPAY_URL/);
  for (const [url,environment] of [['https://sandbox.vnpayment.vn/paymentv2/vpcpay.html','sandbox'],['https://merchant-live.test/pay','live'],['not a URL','invalid'],['ftp://merchant-live.test/pay','invalid']]) {
    const status = await getIntegrationStatus({db:database(),env:{VNPAY_URL:url}});
    assert.equal(status.payments.vnpay.environment,environment);
    assert.equal(status.payments.vnpay.externallyVerified,false);
  }
});

test('SMTP status follows mailer relay and password-alias behavior and disables development fallback in production',async () => {
  const absent = await getIntegrationStatus({db:database('postgres'),env:{NODE_ENV:'production'}});
  assert.equal(absent.email.mode,'disabled');
  assert.equal(absent.email.configured,false);
  assert.equal(absent.database.productionReady,true);
  const hostOnly = await getIntegrationStatus({db:database(),env:{SMTP_HOST:'private-smtp.test'}});
  assert.equal(hostOnly.email.configured,true);
  assert.equal(hostOnly.email.mode,'smtp');
  assert.match(hostOnly.email.missingConfiguration.join(' '),/SMTP_FROM/);
  const noPassword = await getIntegrationStatus({db:database(),env:{SMTP_HOST:'private-smtp.test',SMTP_USER:'private-user'}});
  assert.match(noPassword.email.missingConfiguration.join(' '),/SMTP_PASS/);
  for (const settings of [{SMTP_FROM:'Private <private@test>',SMTP_USER:undefined},{SMTP_USER:'private-user',SMTP_PASS:'private-pass'},{SMTP_USER:'private-user',SMTP_PASSWORD:'private-password-alias'}]) {
    const status = await getIntegrationStatus({db:database(),env:{SMTP_HOST:'private-smtp.test',...settings}});
    assert.deepEqual(status.email.missingConfiguration,[]);
    assert.equal(status.email.externallyVerified,false);
  }
});

test('diagnostics never expose credentials, merchant/operator IDs, URL hostnames, paths or customer data',async () => {
  const secrets = ['database-user','database-secret','private-database.test','private-merchant','private-vnpay-key','private-live-payment.test','private-app.test','private-smtp.test','private-user','private-mail-pass','private-sender@test','private-feed.test','private-feed-token','private-operator-id','private-local-path','private-momo-partner','private-momo-access','private-momo-secret','private-zalo-key1','private-zalo-key2'];
  const env = {NODE_ENV:'production',DATABASE_URL:'postgresql://database-user:database-secret@private-database.test/app',VNPAY_TMN_CODE:'private-merchant',VNPAY_HASH_SECRET:'private-vnpay-key',VNPAY_URL:'https://private-live-payment.test/pay',APP_URL:'https://private-app.test',SMTP_HOST:'private-smtp.test',SMTP_USER:'private-user',SMTP_PASS:'private-mail-pass',SMTP_FROM:'private-sender@test',OPERATOR_FEED_URL:'https://private-feed.test/api',OPERATOR_FEED_TOKEN:'private-feed-token',OPERATOR_FEED_OPERATOR_ID:'private-operator-id',SQLITE_FILE:'private-local-path',MOMO_PARTNER_CODE:'private-momo-partner',MOMO_ACCESS_KEY:'private-momo-access',MOMO_SECRET_KEY:'private-momo-secret',MOMO_URL:'https://payment.momo.vn/v2/gateway/api/create',ZALOPAY_APP_ID:'987654321',ZALOPAY_KEY1:'private-zalo-key1',ZALOPAY_KEY2:'private-zalo-key2',ZALOPAY_URL:'https://openapi.zalopay.vn/v2/create'};
  const result = await getIntegrationStatus({db:database('postgres'),env});
  const exposed = JSON.stringify(result);
  for (const secret of secrets) assert.ok(!exposed.includes(secret),'diagnostics exposed secret or identifying infrastructure');
  assert.equal(result.inventory.providerSync.configured,true);
  assert.equal(result.inventory.providerSync.externallyVerified,false);
  assert.equal(result.database.productionReady,true);
  const unknown = await getIntegrationStatus({db:database('private-dialect-host'),env:{}});
  assert.equal(unknown.database.dialect,'unknown');
  assert.equal(unknown.database.productionReady,false);
});

test('wallet status follows exact provider configuration for partial credentials, invalid endpoints and production',async () => {
  for (const env of [{},{APP_URL:'http://localhost:3000',MOMO_PARTNER_CODE:'partner',MOMO_ACCESS_KEY:'access'},{APP_URL:'http://localhost:3000',MOMO_PARTNER_CODE:'partner',MOMO_ACCESS_KEY:'access',MOMO_SECRET_KEY:'secret',ZALOPAY_APP_ID:'12345',ZALOPAY_KEY1:'key-one',ZALOPAY_KEY2:'key-two'},{NODE_ENV:'production',APP_URL:'https://app.test',MOMO_PARTNER_CODE:'partner',MOMO_ACCESS_KEY:'access',MOMO_SECRET_KEY:'secret',ZALOPAY_APP_ID:'12345',ZALOPAY_KEY1:'key-one',ZALOPAY_KEY2:'key-two'},{APP_URL:'http://localhost:3000',MOMO_URL:'https://untrusted-gateway.test/pay',ZALOPAY_URL:'not a URL'}]) {
    const result = await getIntegrationStatus({db:database(),env});
    for (const provider of ['momo','zalopay']) {
      const config = providerConfig(provider,env),status = result.payments[provider];
      assert.equal(status.configured,config.configured);
      assert.equal(status.environment,config.environment);
      assert.equal(status.externallyVerified,false);
      if (!config.configured) assert.ok(status.missingConfiguration.length);
      assert.ok(!JSON.stringify(status).includes('untrusted-gateway.test'));
    }
  }
});
