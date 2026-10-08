'use strict';

const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const suites = ['smoke', 'advanced-smoke', 'regression-smoke', 'admin-smoke', 'api-smoke', 'integrations-smoke'];
const timeoutMs = 180000;
let activeChild, interrupted = false;

function stopChild(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; stopChild(activeChild); });

function runSuite(suite) {
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, 'browser-' + suite + '.js')], {
      cwd: root, stdio: 'inherit', detached: process.platform !== 'win32'});
    activeChild = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child);
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      activeChild = undefined;
      resolve({suite, passed: false, error: error.message, durationMs: Date.now() - start});
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      activeChild = undefined;
      resolve({suite, passed: code === 0 && !timedOut && !interrupted, code, signal, timedOut, interrupted, durationMs: Date.now() - start});
    });
  });
}

(async () => {
  const results = [];
  for (const suite of suites) {
    if (interrupted) break;
    console.log('\nBrowser suite: ' + suite);
    results.push(await runSuite(suite));
  }
  const directory = path.join(root, 'artifacts', 'tests', 'ui');
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({generatedAt: new Date().toISOString(), results}, null, 2) + '\n');
  const passed = results.filter(result => result.passed).length;
  console.log('Browser suites: ' + passed + '/' + results.length + ' passed.');
  if (passed !== results.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
