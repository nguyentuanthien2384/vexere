'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('fflate');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts');
fs.mkdirSync(out, { recursive: true });
const target = path.join(out, 'Ticket4T-project.zip');
// Package an explicit allow-list. Secrets, databases, dependencies and legacy vendor files stay outside.
const items = ['index.js', 'package.json', 'package-lock.json', '.env.example', '.gitignore', '.dockerignore',
  'Dockerfile', 'docker-compose.yml', 'README.md', 'start.bat', 'server', 'scripts', 'tests', 'docs',
  'models', 'migrations', 'config', 'public/app', 'public/admin', 'public/images', 'public/fonts'];
const list = items.filter(item => fs.existsSync(path.join(root, item)));
const entries = {};
function add(relative) {
  const absolute = path.join(root, relative);
  if (fs.lstatSync(absolute).isSymbolicLink()) return;
  if (fs.statSync(absolute).isDirectory()) {
    for (const child of fs.readdirSync(absolute)) add(path.join(relative, child));
  } else {
    const key = 'Ticket4T/' + relative.replaceAll('\\', '/');
    entries[key] = new Uint8Array(fs.readFileSync(absolute));
  }
}
list.forEach(add);
fs.writeFileSync(target, zipSync(entries, { level: 6 }));
console.log(target);
