'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = ['index.js'];
function visit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) visit(file);
    else if (file.endsWith('.js')) files.push(file);
  }
}
['server', 'public/app', 'public/admin', 'scripts', 'tests', 'models', 'migrations', 'config'].forEach(visit);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(file, result.stderr); failed = true; }
}
console.log(`${files.length} JavaScript files checked.`);
process.exitCode = failed ? 1 : 0;
