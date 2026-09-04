import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parsePioJson } from './adapters/pioJson.js';
import { AdapterParseError, type TestParseOptions } from './adapters/shared.js';

const REPO = '/Users/ci/work/repo';
const ROOT = `${REPO}/Firmware/MaDCore`;

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/pio-test-report.json', import.meta.url)),
  'utf8',
);

function opts(extra: Partial<TestParseOptions> = {}): TestParseOptions {
  return { repoRoot: REPO, rootAbs: ROOT, sourceLabel: 'pio-json:x.json', stale: false, ...extra };
}

describe('parsePioJson', () => {
  it('drops the zero-case env × test-dir cross product', () => {
    // PlatformIO emits one suite per (env, test dir) combination it did not
    // run, each with status SKIPPED. Counting them adds ~100 phantom skips to
    // a real firmware run and makes the skip column meaningless.
    const { summary, notes } = parsePioJson(fixture, opts());
    expect(summary.total).toBe(5);
    expect(summary.cases.every((c) => c.suite.startsWith('native_test:'))).toBe(true);
    expect(notes.some((n) => n.detail.includes('zero-case suite'))).toBe(true);
  });

  it('maps the uppercase enum statuses, counting ERRORED as failed', () => {
    const { summary } = parsePioJson(fixture, opts());
    expect(summary.cases.map((c) => [c.name, c.status])).toEqual([
      ['test_parse_g1', 'passed'],
      ['test_parse_g122', 'failed'],
      ['test_parse_crash', 'failed'],
      ['test_parse_g5', 'skipped'],
      ['test_push_pop', 'passed'],
    ]);
    expect({ passed: summary.passed, failed: summary.failed, skipped: summary.skipped }).toEqual({
      passed: 2,
      failed: 2,
      skipped: 1,
    });
  });

  it('reports Unity\'s missing per-test timing as null, not 0 ms', () => {
    const { summary } = parsePioJson(fixture, opts());
    expect(summary.cases[0]?.durationMs).toBeNull();
    // …but a real measurement survives.
    expect(summary.cases[4]?.durationMs).toBe(125);
  });

  it('maps source.file (the JSON writer renames `filename` to `file`)', () => {
    const { summary } = parsePioJson(fixture, opts());
    expect(summary.cases[0]?.file).toBe('Firmware/MaDCore/test/test_gcode/main.c');
    // A case with source: null keeps no file at all.
    expect(summary.cases[2]?.file).toBeUndefined();
  });

  it('anchors relative source paths at project_dir, not at the component root', () => {
    // The manifest may sit above the pio project; project_dir is what the
    // paths in the file are actually relative to.
    const { summary } = parsePioJson(fixture, opts({ rootAbs: REPO }));
    expect(summary.cases[0]?.file).toBe('Firmware/MaDCore/test/test_gcode/main.c');
  });

  it('keeps the failure message and the exception text', () => {
    const { summary } = parsePioJson(fixture, opts());
    expect(summary.cases[1]?.message).toBe('Expected 122 Was 0');
    expect(summary.cases[2]?.message).toContain('SIGSEGV');
  });

  it('converts the run duration from seconds to ms', () => {
    const { summary } = parsePioJson(fixture, opts());
    expect(summary.durationMs).toBe(12_500);
  });

  it('treats WARNED as passed and keeps the warning text', () => {
    const doc = {
      testcase_nums: 1,
      test_suites: [
        {
          env_name: 'native_test',
          test_name: 't',
          testcase_nums: 1,
          test_cases: [{ name: 'w', status: 'WARNED', message: 'WARNING: deprecated', duration: 0 }],
        },
      ],
    };
    const { summary } = parsePioJson(JSON.stringify(doc), opts());
    expect(summary.passed).toBe(1);
    expect(summary.cases[0]?.message).toBe('WARNING: deprecated');
  });

  it('flags a header total that disagrees with the case list', () => {
    const doc = { testcase_nums: 42, test_suites: [] };
    const { notes } = parsePioJson(JSON.stringify(doc), opts());
    expect(notes.some((n) => n.reason === 'count-mismatch')).toBe(true);
  });

  it('rejects JSON that is not a PlatformIO report', () => {
    expect(() => parsePioJson('{"testResults":[]}', opts())).toThrow(AdapterParseError);
  });
});
