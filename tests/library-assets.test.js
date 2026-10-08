'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {createFeatureFixture} = require('./helpers/feature-fixture');

function securityHeaders(response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /(?:^|;)script-src 'self'(?:;|$)/);
  assert.match(policy, /(?:^|;)connect-src 'self'(?:;|$)/);
  assert.doesNotMatch(policy, /(?:cdnjs|jsdelivr|unpkg|unsafe-eval)/);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0');
}

test('[IT-LIBRARY-001] pinned browser bundles are delivered unchanged from the same origin with the existing security policy', async t => {
  const f = await createFeatureFixture(t);
  for (const [url, file, version] of [
    ['/admin/vendor/chart.umd.js', 'chart.js/dist/chart.umd.js', /Chart\.js v4\.5\.1/],
    ['/admin/vendor/papaparse.min.js', 'papaparse/papaparse.min.js', /Papa Parse\s+v5\.7\.0/],
  ]) {
    const response = await fetch(f.base + url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), /^application\/javascript\b/);
    securityHeaders(response);
    const source = await response.text();
    assert.match(source, version);
    assert.equal(source, await fs.readFile(path.join(__dirname, '../node_modules', file), 'utf8'));
    const head = await fetch(f.base + url, {method: 'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
  }
});

test('[IT-LIBRARY-002] both bundled MIT licenses remain readable as plain text', async t => {
  const f = await createFeatureFixture(t);
  for (const [url, file] of [
    ['/admin/vendor/chart.LICENSE.md', 'chart.js/LICENSE.md'],
    ['/admin/vendor/papaparse.LICENSE', 'papaparse/LICENSE'],
  ]) {
    const response = await fetch(f.base + url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), /^text\/plain\b/);
    securityHeaders(response);
    const source = await response.text();
    assert.match(source, /MIT License/);
    assert.equal(source, await fs.readFile(path.join(__dirname, '../node_modules', file), 'utf8'));
  }
});

// Node's raw HTTP path avoids browser URL normalization hiding traversal probes.
function rawRequest(base, requestedPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(base, {path: requestedPath, method}, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {body += chunk;});
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body}));
    });
    request.on('error', reject);
    request.end();
  });
}

test('[IT-LIBRARY-003] unknown files, directory probes, encoded traversal and unsupported methods cannot fall through to the admin SPA', async t => {
  const f = await createFeatureFixture(t);
  const paths = [
    '/admin/vendor', '/admin/vendor/', '/admin/vendor/package.json',
    '/admin/vendor/chart.umd.js.map', '/admin/vendor/papaparse.js',
    '/admin/vendor/../index.html', '/admin/vendor/%2e%2e/index.html',
    '/admin/vendor/%2e%2e%2fpackage.json', '/admin/vendor/%2f..%2f..%2fpackage.json',
    '/admin/%76endor/package.json', '/ADMIN/VENDOR/chart.umd.js',
    '/admin/vendor/%63hart.umd.js',
  ];
  for (const requestedPath of paths) {
    const response = await rawRequest(f.base, requestedPath);
    assert.equal(response.status, 404, requestedPath);
    assert.match(response.headers['content-type'], /^text\/plain\b/, requestedPath);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.doesNotMatch(response.body, /<html|<script|"dependencies"|sourceMappingURL/i);
  }
  const response = await rawRequest(f.base, '/admin/vendor/chart.umd.js', 'POST');
  assert.equal(response.status, 404);
  assert.match(response.headers['content-type'], /^text\/plain\b/);
  const admin = await fetch(f.base + '/admin/bookings');
  assert.equal(admin.status, 200, 'ordinary admin deep links still open the SPA');
  assert.match(admin.headers.get('content-type'), /^text\/html\b/);
});
