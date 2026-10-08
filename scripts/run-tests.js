'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');

const root = path.resolve(__dirname, '..');
const thresholds = Object.freeze({lines: 95, branches: 85, functions: 90});
const modes = new Set(['all', 'unit', 'integration', 'coverage', 'postgres']);

function discoverTestFiles(directory, mode = 'all') {
  if (!modes.has(mode)) throw new Error('Unknown test mode: ' + mode);
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        const relative = path.relative(directory, filename).split(path.sep);
        const unit = relative[0] === 'unit', postgres = relative[0] === 'postgres';
        if (mode === 'postgres' ? postgres : !postgres && (mode === 'unit' ? unit : mode === 'integration' ? !unit : true)) files.push(filename);
      }
    }
  }
  visit(directory);
  return files.sort();
}

function postgresTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL test database.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/(^|[_-])test([_-]|$)/i.test(decodeURIComponent(url.pathname.slice(1)))) {
    throw new Error('PostgreSQL tests require a database name containing a separate test segment, for example ticket4t_test.');
  }
  if (url.searchParams.has('options')) throw new Error('Remove options from TEST_DATABASE_URL; the runner sets an isolated search_path.');
  return url;
}

function testEnvironment(source = process.env) {
  const env = {...source, NODE_ENV: 'test'};
  // Ordinary test commands always use fixture-owned SQLite databases, even when
  // the developer shell contains credentials for a running application.
  for (const key of ['TEST_DATABASE_URL', 'DATABASE_URL', 'SQLITE_FILE', 'DATA_DIR', 'NODE_V8_COVERAGE']) delete env[key];
  return env;
}

function testArguments(files, reportDirectory, coverage = false) {
  const args = ['--test', '--test-timeout=60000', '--test-concurrency=4',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=' + pathToFileURL(path.join(__dirname, 'test-summary-reporter.js')).href,
    '--test-reporter-destination=' + path.join(reportDirectory, 'results.json')];
  if (coverage) args.push('--experimental-test-coverage', '--test-coverage-include=index.js', '--test-coverage-include=server/**/*.js',
    ...Object.entries(thresholds).map(([metric, value]) => '--test-coverage-' + metric + '=' + value));
  return [...args, ...files];
}

function execute(files, label, env, coverage = false) {
  if (!files.length) throw new Error('No test files found for ' + label);
  const reportDirectory = path.join(root, 'artifacts', 'tests', label);
  fs.mkdirSync(reportDirectory, {recursive: true});
  for (const file of ['results.json', 'junit.xml', 'lcov.info']) fs.rmSync(path.join(reportDirectory, file), {force: true});
  console.log('Running ' + label + ': ' + files.length + ' files. Reports: ' + path.relative(root, reportDirectory));
  const result = spawnSync(process.execPath, testArguments(files, reportDirectory, coverage), {
    cwd: root, env: {...env, TICKET4T_TEST_REPORT_DIRECTORY: reportDirectory}, stdio: 'inherit'});
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function runPostgres() {
  const url = postgresTarget(process.env.TEST_DATABASE_URL);
  const {Client} = require('pg');
  const control = new Client({connectionString: url.href,
    ssl: process.env.PG_SSL === 'true' ? {rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false'} : undefined});
  await control.connect();
  let exitCode = 0;
  try {
    // These suites opt in to TEST_DATABASE_URL. Other API suites deliberately
    // keep their per-case SQLite fixtures and are not reported as PostgreSQL.
    const files = ['backend', 'advanced', 'admin', 'search-contracts', 'hold-recovery', 'reschedule-recovery', 'admin-reschedule-contracts'].map(name => path.join(root, 'tests', name + '.test.js'))
      .concat(discoverTestFiles(path.join(root, 'tests'), 'postgres'));
    for (const file of files) {
      const schema = 'ticket4t_test_' + crypto.randomBytes(12).toString('hex');
      await control.query('CREATE SCHEMA "' + schema + '"');
      try {
        const isolated = new URL(url.href);
        isolated.searchParams.set('options', '-c search_path=' + schema);
        const env = {...testEnvironment(), TEST_DATABASE_URL: isolated.href};
        exitCode = Math.max(exitCode, execute([file], 'postgres/' + path.basename(file, '.test.js'), env));
      } finally {
        // schema is generated above, never a user-supplied identifier.
        await control.query('DROP SCHEMA "' + schema + '" CASCADE');
      }
    }
  } finally { await control.end(); }
  return exitCode;
}

async function main() {
  const mode = process.argv[2] || 'all';
  if (process.argv.length > 3 || !modes.has(mode)) throw new Error('Usage: node scripts/run-tests.js [all|unit|integration|coverage|postgres]');
  if (mode === 'postgres') return runPostgres();
  return execute(discoverTestFiles(path.join(root, 'tests'), mode), mode, testEnvironment(), mode === 'coverage');
}

if (require.main === module) main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
module.exports = {discoverTestFiles, postgresTarget, testEnvironment, testArguments, thresholds};
