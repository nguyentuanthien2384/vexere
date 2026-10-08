'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {lcov, junit} = require('node:test/reporters');

async function writeLcov(event) {
  const directory = process.env.TICKET4T_TEST_REPORT_DIRECTORY;
  if (!directory) return;
  // Reuse Node's formatters without additional pipes on TestsStream. Multiple
  // CLI reporter pipelines exceed its default listener count on Node24.
  const reporter = new lcov();
  let output = '';
  reporter.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    reporter.once('end', resolve); reporter.once('error', reject); reporter.end(event);
  });
  fs.writeFileSync(path.join(directory, 'lcov.info'), output);
}

// Consume structured node:test events; never scrape human-readable spec output.
module.exports = async function* summaryReporter(source) {
  const cases = [], events = [];
  let summary, coverage;
  for await (const event of source) {
    events.push(event);
    const data = event.data;
    if (event.type === 'test:summary') summary = data;
    if (event.type === 'test:coverage') {
      await writeLcov(event);
      coverage = {totals: data.summary.totals, files: data.summary.files.map(file => ({
        path: path.relative(process.cwd(), file.path).split(path.sep).join('/'),
        lines: file.coveredLinePercent, branches: file.coveredBranchPercent, functions: file.coveredFunctionPercent,
      }))};
    }
    if (!['test:pass', 'test:fail'].includes(event.type) || data.details?.type === 'suite') continue;
    const file = data.file && path.relative(process.cwd(), data.file).split(path.sep).join('/');
    // File-level failures also remain visible in reports, including setup errors.
    const id = data.name.match(/\[((?:UT|IT)-[A-Z0-9-]+)\]/)?.[1]
      || 'AUTO-' + crypto.createHash('sha256').update((file || '') + ':' + data.name).digest('hex').slice(0, 12);
    cases.push({id, name: data.name, file, line: data.line, column: data.column,
      status: data.skip ? 'skipped' : data.todo ? 'todo' : data.details?.error?.failureType === 'cancelledByParent' ? 'cancelled' : event.type === 'test:pass' ? 'passed' : 'failed',
      durationMs: data.details?.duration_ms, error: data.details?.error?.message});
  }
  if (process.env.TICKET4T_TEST_REPORT_DIRECTORY) {
    let xml = '';
    for await (const chunk of junit(events)) xml += chunk;
    fs.writeFileSync(path.join(process.env.TICKET4T_TEST_REPORT_DIRECTORY, 'junit.xml'), xml);
  }
  yield JSON.stringify({generatedAt: new Date().toISOString(), node: process.version, summary, coverage, cases}, null, 2) + '\n';
};
