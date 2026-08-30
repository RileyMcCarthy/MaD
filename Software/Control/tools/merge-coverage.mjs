/**
 * Report coverage for the whole flashing feature, across both test suites.
 *
 * The loader is exercised in-process by vitest; the screen is exercised in a
 * real Chrome by the Playwright suite. Neither can see the other, which is why
 * `src/ui/screens/Firmware.tsx` reads 0% in the unit report while nine
 * scenarios drive it.
 *
 * These are COMBINED BY FILE, not merged per-file. That is deliberate. The two
 * runs use different instrumenters (vitest's v8 provider vs
 * vite-plugin-istanbul in the browser), which produce different statement maps
 * for the same source. istanbul merges those by concatenation rather than
 * union: merging one file measured 71/71 by unit and 49/71 by e2e produced
 * "120/142" — a plausible-looking number describing a file that has 71
 * statements. So each file is attributed to exactly one suite, and any file
 * present in both is reported from the unit run with the e2e sample discarded.
 *
 *   npm run coverage         # unit  -> coverage/unit/coverage-final.json
 *   npm run e2e:coverage     # e2e   -> coverage/e2e/*.json
 *   npm run coverage:report  # this  -> combined table + thresholds
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const libCoverage = require('istanbul-lib-coverage');

const ROOT = process.cwd();
const UNIT_FILE = 'coverage/unit/coverage-final.json';
const E2E_DIR = 'coverage/e2e';

/** The feature: the loader, and the screen that drives it. */
const SCOPE = [/^src\/firmware\//, /^src\/ui\/screens\/Firmware\.tsx$/];
const EXCLUDE = [/\.test\.[cm]?tsx?$/, /^src\/firmware\/golden\//];
const THRESHOLDS = { statements: 85, branches: 70, functions: 90, lines: 85 };

const readJson = async (p) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
};

const rel = (abs) => relative(ROOT, abs).split('\\').join('/');
const inScope = (r) => SCOPE.some((x) => x.test(r)) && !EXCLUDE.some((x) => x.test(r));

const unitRaw = await readJson(UNIT_FILE);
const unit = libCoverage.createCoverageMap(unitRaw ?? {});

const e2e = libCoverage.createCoverageMap({});
let samples = 0;
try {
  for (const f of (await readdir(E2E_DIR)).filter((f) => f.endsWith('.json'))) {
    const data = await readJson(join(E2E_DIR, f));
    if (!data) continue;
    e2e.merge(data); // same instrumenter throughout, so this merge IS sound
    samples++;
  }
} catch {
  /* no e2e coverage recorded */
}

if (!unitRaw && !samples) {
  console.error('No coverage found. Run `npm run coverage` and `npm run e2e:coverage` first.');
  process.exit(2);
}

const unitFiles = new Set(unit.files().map(rel));
const rows = [];
const discarded = [];

for (const abs of unit.files()) {
  const r = rel(abs);
  if (inScope(r)) rows.push({ file: r, from: 'unit', summary: unit.fileCoverageFor(abs).toSummary() });
}
for (const abs of e2e.files()) {
  const r = rel(abs);
  if (!inScope(r)) continue;
  if (unitFiles.has(r)) {
    discarded.push(r); // measured by both; keep the unit figure, never blend
    continue;
  }
  rows.push({ file: r, from: 'e2e', summary: e2e.fileCoverageFor(abs).toSummary() });
}

rows.sort((a, b) => a.file.localeCompare(b.file));

const totals = { statements: [0, 0], branches: [0, 0], functions: [0, 0], lines: [0, 0] };
for (const { summary } of rows) {
  for (const k of Object.keys(totals)) {
    totals[k][0] += summary[k].covered;
    totals[k][1] += summary[k].total;
  }
}
const pct = ([c, t]) => (t === 0 ? 100 : (c / t) * 100);
const col = (n) => `${n.toFixed(1)}%`.padStart(8);

console.log(`unit report: ${unitRaw ? 'yes' : 'MISSING'}    e2e samples: ${samples}\n`);
console.log('file'.padEnd(38) + 'from'.padEnd(7) + '   stmts  branch   funcs   lines');
console.log('-'.repeat(78));
for (const { file, from, summary } of rows) {
  console.log(
    file.padEnd(38) +
      from.padEnd(7) +
      col(summary.statements.pct) +
      col(summary.branches.pct) +
      col(summary.functions.pct) +
      col(summary.lines.pct),
  );
}
console.log('-'.repeat(78));
console.log(
  'TOTAL'.padEnd(45) +
    col(pct(totals.statements)) +
    col(pct(totals.branches)) +
    col(pct(totals.functions)) +
    col(pct(totals.lines)),
);

if (discarded.length) {
  console.log(
    `\nnote: ${discarded.length} file(s) measured by both suites; reported from the unit run ` +
      `(cross-instrumenter merge is unsound):\n  ${discarded.join('\n  ')}`,
  );
}

const missing = rows.length === 0;
const failures = Object.entries(THRESHOLDS)
  .map(([k, min]) => [k, pct(totals[k]), min])
  .filter(([, actual, min]) => actual < min);

if (missing || failures.length) {
  console.error('');
  if (missing) console.error('FAIL: no files in scope were measured');
  for (const [k, actual, min] of failures) {
    console.error(`FAIL ${k}: ${actual.toFixed(1)}% < ${min}%`);
  }
  process.exit(1);
}
console.log('\nthresholds met');
