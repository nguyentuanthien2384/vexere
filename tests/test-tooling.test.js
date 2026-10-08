'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {testArguments, testEnvironment} = require('../scripts/run-tests');
const root = path.resolve(__dirname, '..');

function fixture(t, source, coverage = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket4t-report-it-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('ticket4t-report-it-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const file = path.join(directory, 'contract.test.js');
  fs.writeFileSync(file, source);
  const env = {...testEnvironment(), TICKET4T_TEST_REPORT_DIRECTORY: directory};
  // This intentionally starts a second standalone runner, rather than asking
  // the outer runner to execute its own test child recursively.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, testArguments([file], directory, coverage), {
    cwd: root, encoding: 'utf8', timeout: 20000,
    env, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.ok(fs.existsSync(path.join(directory, 'results.json')), result.stdout + result.stderr);
  return {result, directory, report: JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8')),
    junit: fs.readFileSync(path.join(directory, 'junit.xml'), 'utf8')};
}

test('[IT-TOOL-001] real runner propagates failing assertions and reports leaf failed/skipped/todo cases without counting the suite', t => {
  const {result, report, junit} = fixture(t, `
    const {test,describe}=require('node:test');const assert=require('node:assert/strict');
    describe('fixture suite',()=>{
      test('[IT-FIXTURE-FAIL] intentional assertion',()=>assert.fail('Expected fixture assertion'));
      test('fixture skipped',{skip:true},()=>{});
      test('fixture todo',{todo:'Pending fixture'},()=>{});
    });`);
  assert.equal(result.status, 1);
  assert.equal(report.summary.success, false);
  assert.equal(report.summary.counts.tests, 3);
  assert.equal(report.summary.counts.failed, 1);
  assert.equal(report.summary.counts.skipped, 1);
  assert.equal(report.summary.counts.todo, 1);
  assert.deepEqual(report.cases.map(item => item.status).sort(), ['failed', 'skipped', 'todo']);
  assert.equal(report.cases.find(item => item.status === 'failed').id, 'IT-FIXTURE-FAIL');
  assert.match(junit, /<failure/);
  assert.match(junit, /Expected fixture assertion/);
  assert.match(junit, /<skipped/);
});

test('[IT-TOOL-002] coverage below the project floor fails the process despite passing assertions and produces usable LCOV', t => {
  const modulePath = JSON.stringify(path.join(root, 'server/payments.js'));
  const {result, directory, report} = fixture(t, `
    const {test}=require('node:test');const assert=require('node:assert/strict');
    const {canonical}=require(${modulePath});
    test('minimal payment fixture',()=>assert.equal(canonical({a:'b'}),'a=b'));`, true);
  assert.equal(result.status, 1);
  assert.equal(report.summary.counts.failed, 0);
  assert.equal(report.summary.counts.passed, 1);
  assert.equal(report.summary.success, false);
  assert.ok(report.coverage.files.some(file => file.path === 'server/payments.js'));
  assert.ok(report.coverage.totals.coveredFunctionPercent < 90);
  const lcov = fs.readFileSync(path.join(directory, 'lcov.info'), 'utf8');
  assert.match(lcov, /SF:server[\\/]payments\.js/);
  assert.match(lcov, /end_of_record/);
});
