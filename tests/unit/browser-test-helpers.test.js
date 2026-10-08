'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {cleanupBrowserTest}=require('../../scripts/browser-test-helpers');

const prefix='ticket4t-helper-unit-',dataDir=path.join(os.tmpdir(),prefix+'virtual');
function fixtures(events){
  return {
    browser:{async close(){events.push('browser');}},
    server:{close(callback){events.push('stop-listening');queueMicrotask(()=>{events.push('server-closed');callback();});},closeAllConnections(){events.push('force-connections');},closeIdleConnections(){events.push('idle-connections');}},
    runtime:{async close(){events.push('database');}},
    dataDir,prefix,
  };
}

test('[UT-HARNESS-001] cleanup stops HTTP connections before closing the database and removes only its temporary fixture',async t=>{
  const events=[],removed=[];t.mock.method(fs,'rm',async(...args)=>removed.push(args));
  await cleanupBrowserTest(fixtures(events));
  assert.ok(events.indexOf('stop-listening')<events.indexOf('force-connections'));assert.ok(events.indexOf('server-closed')<events.indexOf('database'));assert.ok(events.includes('browser'));assert.ok(events.includes('idle-connections'));
  assert.deepEqual(removed,[[path.resolve(dataDir),{recursive:true,force:true}]]);
});

test('[UT-HARNESS-002] a rejected browser close still closes HTTP/database and reports both test and cleanup failures',async t=>{
  const events=[],removed=[];t.mock.method(fs,'rm',async(...args)=>removed.push(args));
  const fixture=fixtures(events),browserFailure=new Error('Browser connection lost'),testFailure=new Error('Original failed assertion');fixture.browser.close=async()=>{events.push('browser');throw browserFailure;};
  await assert.rejects(()=>cleanupBrowserTest(fixture,testFailure),error=>{assert.ok(error instanceof AggregateError);assert.equal(error.errors[0],testFailure);assert.ok(error.errors.some(item=>item.cause===browserFailure));return true;});
  assert.ok(events.includes('server-closed'));assert.ok(events.includes('database'));assert.equal(removed.length,1);
});

test('[UT-HARNESS-003] unsafe cleanup paths are rejected after resource teardown without invoking recursive removal',async t=>{
  const events=[],removed=[];t.mock.method(fs,'rm',async(...args)=>removed.push(args));
  await assert.rejects(()=>cleanupBrowserTest({...fixtures(events),dataDir:path.dirname(path.resolve(os.tmpdir()))}),error=>{assert.ok(error instanceof AggregateError);assert.ok(error.errors.some(item=>item.cause?.message==='Invalid temporary cleanup path.'));return true;});
  assert.ok(events.includes('database'));assert.equal(removed.length,0);
});
