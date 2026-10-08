'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {getOperatorFeedStatus}=require('../../server/operator-feed');

const configuration=(extra={})=>({NODE_ENV:'test',OPERATOR_FEED_URL:'https://partner.example.test/schedule',OPERATOR_FEED_TOKEN:'private-unit-feed-token',OPERATOR_FEED_OPERATOR_ID:'operator_unit_1',...extra});
function prohibitNetwork(t){return t.mock.method(globalThis,'fetch',()=>{throw new Error('Configuration inspection must not contact a provider');});}

test('[UT-CONFIG-001] local IPv6 HTTP is limited to development and test environments',t=>{
  const network=prohibitNetwork(t);
  for(const NODE_ENV of [undefined,'development','test']){
    const status=getOperatorFeedStatus(configuration({NODE_ENV,OPERATOR_FEED_URL:'http://[::1]:3001/feed'}));assert.equal(status.configured,true,String(NODE_ENV));assert.equal(status.mode,'operator_feed');assert.equal(status.externallyVerified,false);
  }
  for(const NODE_ENV of ['staging','production']){
    const status=getOperatorFeedStatus(configuration({NODE_ENV,OPERATOR_FEED_URL:'http://[::1]:3001/feed'}));assert.equal(status.configured,false,NODE_ENV);assert.ok(status.missingConfiguration.some(message=>message.includes('HTTPS')));
  }
  assert.equal(network.mock.callCount(),0);
});

test('[UT-CONFIG-002] timeout configuration accepts both limits and rejects values outside the supported range',t=>{
  const network=prohibitNetwork(t);
  for(const value of [undefined,'','100','30000'])assert.equal(getOperatorFeedStatus(configuration({OPERATOR_FEED_TIMEOUT_MS:value})).configured,true,String(value));
  for(const value of ['99','30001','100.5','invalid','Infinity',' ']){
    const status=getOperatorFeedStatus(configuration({OPERATOR_FEED_TIMEOUT_MS:value}));assert.equal(status.configured,false,value);assert.ok(status.missingConfiguration.some(message=>message.includes('OPERATOR_FEED_TIMEOUT_MS')));
  }
  assert.equal(network.mock.callCount(),0);
});

test('[UT-CONFIG-003] operator identifiers enforce maximum length and permitted characters',t=>{
  prohibitNetwork(t);
  for(const value of ['A','operator_01-TEST','a'.repeat(160)])assert.equal(getOperatorFeedStatus(configuration({OPERATOR_FEED_OPERATOR_ID:value})).configured,true,value);
  for(const value of ['a'.repeat(161),'operator/name','operator.name','operator%20id','operator\nid']){
    const status=getOperatorFeedStatus(configuration({OPERATOR_FEED_OPERATOR_ID:value}));assert.equal(status.configured,false,value);assert.ok(status.missingConfiguration.some(message=>message.includes('OPERATOR_FEED_OPERATOR_ID')));
  }
});

test('[UT-CONFIG-004] blank credentials and header control characters are rejected without exposing their values',t=>{
  const network=prohibitNetwork(t);
  for(const key of ['OPERATOR_FEED_URL','OPERATOR_FEED_TOKEN','OPERATOR_FEED_OPERATOR_ID']){
    for(const value of ['', ' \t ']){
      const status=getOperatorFeedStatus(configuration({[key]:value}));assert.equal(status.configured,false,key);assert.ok(status.missingConfiguration.some(message=>message.includes(key)));
    }
  }
  for(const value of ['private-token\rheader','private-token\nheader','private-token\0header']){
    const status=getOperatorFeedStatus(configuration({OPERATOR_FEED_TOKEN:value}));assert.equal(status.configured,false);assert.ok(status.missingConfiguration.some(message=>message.includes('ký tự điều khiển')));assert.ok(!JSON.stringify(status).includes('private-token'));
  }
  assert.equal(network.mock.callCount(),0);
});

test('[UT-CONFIG-005] localhost lookalikes cannot use the development HTTP exception',t=>{
  const network=prohibitNetwork(t);
  for(const url of ['http://localhost.example.test/feed','http://127.0.0.1.example.test/feed','http://192.168.1.10/feed','http://[::2]/feed']){
    const status=getOperatorFeedStatus(configuration({OPERATOR_FEED_URL:url}));assert.equal(status.configured,false,url);assert.equal(status.mode,'unavailable');assert.ok(!JSON.stringify(status).includes(url));
  }
  assert.equal(network.mock.callCount(),0);
});
