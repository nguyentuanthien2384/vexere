'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {discoverTestFiles, postgresTarget, testEnvironment} = require('../../scripts/run-tests');

test('[UT-RUNNER-001] recursive discovery includes nested units and excludes PostgreSQL opt-in files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket4t-discovery-'));
  try {
    for (const file of ['api.test.js', 'unit/nested/pure.test.js', 'unit/helper.js', 'postgres/db.test.js']) {
      const filename = path.join(directory, file);
      fs.mkdirSync(path.dirname(filename), {recursive: true}); fs.writeFileSync(filename, '');
    }
    const names = mode => discoverTestFiles(directory, mode).map(file => path.relative(directory, file).split(path.sep).join('/'));
    assert.deepEqual(names('all'), ['api.test.js', 'unit/nested/pure.test.js']);
    assert.deepEqual(names('coverage'), names('all'));
    assert.deepEqual(names('unit'), ['unit/nested/pure.test.js']);
    assert.deepEqual(names('integration'), ['api.test.js']);
    assert.deepEqual(names('postgres'), ['postgres/db.test.js']);
    assert.throws(() => names('unknown'), /Unknown test mode/);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('[UT-RUNNER-002] PostgreSQL opt-in rejects missing, ordinary and preconfigured search paths', () => {
  for (const url of [undefined, '', 'sqlite://local/test', 'postgres://localhost/ticket4t', 'postgres://localhost/latest', 'postgres://localhost/testimonial', 'postgres://localhost/ticket4t_test?options=-csearch_path=public']) {
    assert.throws(() => postgresTarget(url), Error);
  }
  for (const name of ['test', 'ticket4t_test', 'ticket4t-test-ci']) assert.equal(postgresTarget('postgresql://localhost/' + name).pathname, '/' + name);
});

test('[UT-RUNNER-003] ordinary runs remove application database destinations without mutating the shell', () => {
  const source = {PATH: 'runtime', NODE_ENV: 'production', DATABASE_URL: 'private', TEST_DATABASE_URL: 'private-test', SQLITE_FILE: 'live.sqlite', DATA_DIR: 'live', NODE_V8_COVERAGE: 'external'};
  assert.deepEqual(testEnvironment(source), {PATH: 'runtime', NODE_ENV: 'test'});
  assert.equal(source.DATABASE_URL, 'private');
});
