#!/usr/bin/env node
// Runs the local database test suites and prints a summary.
//   node tests/db/run.mjs                 all suites
//   node tests/db/run.mjs rules           one suite (migrations | rules | schema-drift | api-wiring)
//   node tests/db/run.mjs --verbose       also list passing checks
// Exit code 0 = everything passed, 1 = at least one FAIL or ERROR.
import { Report } from './lib/harness.mjs';

const SUITES = {
  migrations: () => import('./suites/migrations.mjs'),
  rules: () => import('./suites/rules.mjs'),
  'schema-drift': () => import('./suites/schema-drift.mjs'),
  'api-wiring': () => import('./suites/api-wiring.mjs'),
};

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const wanted = args.filter((a) => !a.startsWith('-'));
const unknown = wanted.filter((w) => !SUITES[w]);
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(', ')}. Available: ${Object.keys(SUITES).join(', ')}`);
  process.exit(2);
}

const started = Date.now();
const reports = [];
for (const key of wanted.length ? wanted : Object.keys(SUITES)) {
  let suite;
  const report = new Report(key);
  try {
    suite = await SUITES[key]();
    report.suite = suite.name || key;
    await suite.run(report);
  } catch (e) {
    // A suite that cannot run (missing dependency, syntax error...) is reported, not thrown
    report.record('SUITE', `Suite "${key}" could not run`, 'ERROR', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  }
  report.print({ verbose });
  reports.push(report);
}

console.log('\n================ SUMMARY ================');
let failed = false;
for (const r of reports) {
  const c = r.counts;
  failed ||= !r.ok;
  console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.suite.padEnd(44)} ${String(c.PASS).padStart(3)} passed  ${String(c.FAIL).padStart(2)} failed  ${String(c.ERROR).padStart(2)} errors`);
}
console.log(`Finished in ${((Date.now() - started) / 1000).toFixed(1)} s. ${failed ? 'Some checks FAILED.' : 'All checks passed.'}`);
process.exit(failed ? 1 : 0);
