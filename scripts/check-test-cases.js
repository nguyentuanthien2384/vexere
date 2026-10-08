'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'docs/test-cases.json'), 'utf8'));
const errors = [], ids = new Set();
for (const item of catalogue.cases) {
  if (!/^TC-[A-Z0-9-]+$/.test(item.id) || ids.has(item.id)) errors.push('Invalid/duplicate case ID: ' + item.id);
  ids.add(item.id);
  for (const field of ['feature', 'preconditions', 'input', 'expected']) if (!item[field]?.trim()) errors.push(item.id + ' missing ' + field);
  if (!['P0', 'P1', 'P2'].includes(item.priority) || !item.steps?.length || !item.automation?.length) errors.push(item.id + ' missing priority/steps/automation');
  for (const reference of item.automation || []) {
    const file = path.resolve(root, reference.file);
    if (!file.startsWith(root + path.sep) || !/^(tests\/.*\.test\.js|scripts\/browser-[\w-]+\.js)$/.test(reference.file) || !fs.existsSync(file)) {
      errors.push(item.id + ' invalid automation file: ' + reference.file); continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    // Node test titles embed [ID]; browser check helpers receive a quoted ID.
    for (const id of reference.ids || []) if (!['[' + id,"'" + id,'"' + id].some(token=>source.includes(token))) errors.push(item.id + ' missing automated ID: ' + id);
  }
}
for (const item of catalogue.pendingExternalCases) {
  if (!item.id || ids.has(item.id) || item.status !== 'not-run' || !item.requirement || !item.expected) errors.push('Invalid pending external case: ' + item.id);
  ids.add(item.id);
}
if (errors.length) { errors.forEach(error => console.error(error)); process.exitCode = 1; }
else console.log('Test catalogue checked: ' + catalogue.cases.length + ' feature scenarios, ' + catalogue.pendingExternalCases.length + ' pending external scenarios.');
