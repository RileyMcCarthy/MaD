import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AdapterParseError, type TestParseOptions } from './adapters/shared.js';
import { parseVitestJson } from './adapters/vitestJson.js';

const REPO = '/Users/ci/work/repo';
const ROOT = `${REPO}/Software/Control`;

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/vitest-2.1.9.json', import.meta.url)),
  'utf8',
);

function opts(extra: Partial<TestParseOptions> = {}): TestParseOptions {
  return { repoRoot: REPO, rootAbs: ROOT, sourceLabel: 'vitest-json:x.json', stale: false, ...extra };
}

describe('parseVitestJson — captured from a real vitest 2.1.9 run', () => {
  it('flattens assertionResults into cases with the describe chain as the suite', () => {
    const { summary } = parseVitestJson(fixture, opts());
    expect(summary.cases.map((c) => `${c.suite} :: ${c.name}`)).toEqual([
      'outer > inner :: passes',
      'outer > inner :: fails',
      'outer :: is skipped',
      'Software/Control/test/beta.test.ts :: lonely case',
    ]);
  });

  it('relativises the ABSOLUTE `name` path against the repo root', () => {
    const { summary } = parseVitestJson(fixture, opts());
    expect(summary.cases[0]?.file).toBe('Software/Control/test/alpha.test.ts');
  });

  it('reports a skipped case with durationMs null, never 0', () => {
    // vitest omits `duration` entirely for skipped tests. Coercing the missing
    // key to 0 would report a measurement that was never taken.
    const { summary } = parseVitestJson(fixture, opts());
    const skipped = summary.cases[2];
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.durationMs).toBeNull();
  });

  it('tallies passed/failed/skipped from the case list', () => {
    const { summary } = parseVitestJson(fixture, opts());
    expect({ total: summary.total, passed: summary.passed, failed: summary.failed, skipped: summary.skipped }).toEqual({
      total: 4,
      passed: 2,
      failed: 1,
      skipped: 1,
    });
  });

  it('derives wall-clock duration from startTime and the latest endTime', () => {
    const { summary } = parseVitestJson(fixture, opts());
    expect(summary.durationMs).toBeCloseTo(690.52, 1);
  });

  it('keeps the failure message', () => {
    const { summary } = parseVitestJson(fixture, opts());
    expect(summary.cases[1]?.message).toContain('expected 1 to be 2');
  });

  it('carries the source label and staleness stamp through unchanged', () => {
    const { summary } = parseVitestJson(fixture, opts({ stale: true, sourceLabel: 'vitest-json:old.json' }));
    expect(summary.stale).toBe(true);
    expect(summary.source).toBe('vitest-json:old.json');
  });

  it('drops file attribution when the run happened outside this repo', () => {
    const { summary, notes } = parseVitestJson(fixture, opts({ repoRoot: '/somewhere/else' }));
    expect(summary.cases.every((c) => c.file === undefined)).toBe(true);
    expect(notes.some((n) => n.reason === 'unmapped-paths')).toBe(true);
    // The cases themselves survive: losing attribution must not lose evidence.
    expect(summary.total).toBe(4);
  });
});

describe('parseVitestJson — shapes the real world produces', () => {
  it('folds todo and pending into skipped', () => {
    const doc = {
      numTotalTests: 2,
      startTime: 0,
      testResults: [
        {
          name: `${ROOT}/a.test.ts`,
          assertionResults: [
            { ancestorTitles: [], title: 'todo one', status: 'todo', failureMessages: [] },
            { ancestorTitles: [], title: 'pending one', status: 'pending', failureMessages: [] },
          ],
        },
      ],
    };
    const { summary } = parseVitestJson(JSON.stringify(doc), opts());
    expect(summary.skipped).toBe(2);
    expect(summary.passed).toBe(0);
  });

  it('turns a file that failed to COLLECT into one failed case instead of silence', () => {
    const doc = {
      numTotalTests: 0,
      startTime: 0,
      testResults: [
        {
          name: `${ROOT}/broken.test.ts`,
          status: 'failed',
          message: 'Error: Cannot find module "./missing"',
          assertionResults: [],
        },
      ],
    };
    const { summary } = parseVitestJson(JSON.stringify(doc), opts());
    expect(summary.total).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.cases[0]?.message).toContain('Cannot find module');
  });

  it('flags a header total that disagrees with the assertion list', () => {
    const doc = { numTotalTests: 99, startTime: 0, testResults: [] };
    const { notes } = parseVitestJson(JSON.stringify(doc), opts());
    expect(notes.some((n) => n.reason === 'count-mismatch' && n.detail.includes('numTotalTests=99'))).toBe(true);
  });

  it('treats an unknown status as not-passed', () => {
    const doc = {
      startTime: 0,
      testResults: [
        { name: `${ROOT}/a.test.ts`, assertionResults: [{ ancestorTitles: [], title: 'x', status: 'weird' }] },
      ],
    };
    const { summary } = parseVitestJson(JSON.stringify(doc), opts());
    expect(summary.passed).toBe(0);
  });

  it('rejects a JSON document that is not a vitest report', () => {
    expect(() => parseVitestJson('{"test_suites":[]}', opts())).toThrow(AdapterParseError);
    expect(() => parseVitestJson('not json', opts())).toThrow(AdapterParseError);
  });
});
