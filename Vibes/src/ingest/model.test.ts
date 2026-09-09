import { describe, expect, it } from 'vitest';

import type { CoverageSummary, IngestSpec, TestSummary } from '../types.js';
import { coverageLabel, testsLabel } from './labels.js';
import {
  componentInputFromSpec,
  coverageTotals,
  formatPercent,
  globList,
  mergeCoverageSummaries,
  mergeTestSummaries,
  mergedSourceLabel,
  type ComponentIngest,
} from './model.js';

describe('formatPercent — the only sanctioned way to print a rate', () => {
  it('returns n/a for 0/0 — not 0%, and not 100%', () => {
    // A component with no instrumented lines has not achieved anything and has
    // not failed at anything. Both roundings are lies.
    expect(formatPercent(0, 0)).toBe('n/a');
  });

  it('prints 100% only when nothing is missing', () => {
    expect(formatPercent(10, 10)).toBe('100%');
    expect(formatPercent(9999, 10_000)).toBe('99.9%');
  });

  it('never rounds a nonzero numerator down to 0.0%', () => {
    expect(formatPercent(1, 10_000)).toBe('<0.1%');
    expect(formatPercent(0, 10_000)).toBe('0.0%');
  });

  it('is n/a for nonsense rather than NaN%', () => {
    expect(formatPercent(1, -1)).toBe('n/a');
    expect(formatPercent(Number.NaN, 10)).toBe('n/a');
  });
});

describe('globList', () => {
  it('accepts the single-string and array forms the manifest allows', () => {
    expect(globList(undefined)).toEqual([]);
    expect(globList('a/*.xml')).toEqual(['a/*.xml']);
    expect(globList(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('componentInputFromSpec', () => {
  const resolve = (p: string): string => `/repo/Software/Control/${p}`.replace(/\/\.$/, '');

  it('handles the three-way lcov union, including a mixed array', () => {
    const spec: IngestSpec = {
      junit: 'vibes/artifacts/junit.xml',
      lcov: [{ path: 'cov/a.info', sourceRoot: 'src' }, 'cov/b.info'] as IngestSpec['lcov'],
    };
    const input = componentInputFromSpec('control', '/repo/Software/Control', spec, resolve);
    expect(input.junit).toEqual(['vibes/artifacts/junit.xml']);
    expect(input.lcov).toEqual([
      { glob: 'cov/a.info', sourceRootAbs: '/repo/Software/Control/src' },
      { glob: 'cov/b.info', sourceRootAbs: '/repo/Software/Control' },
    ]);
  });

  it('defaults required to true (R-I3)', () => {
    expect(componentInputFromSpec('c', '/repo/c', {}, resolve).required).toBe(true);
    expect(componentInputFromSpec('c', '/repo/c', { required: false }, resolve).required).toBe(false);
  });

  it('produces empty glob lists for an absent spec', () => {
    const input = componentInputFromSpec('sil', '/repo/SIL', null, resolve);
    expect([input.junit, input.vitestJson, input.pioJson, input.lcov]).toEqual([[], [], [], []]);
  });
});

const summary = (over: Partial<TestSummary> = {}): TestSummary => ({
  total: 2,
  passed: 1,
  failed: 1,
  skipped: 0,
  durationMs: 100,
  cases: [],
  source: 'junit-xml:a.xml',
  stale: false,
  ...over,
});

describe('merging', () => {
  it('sums test counts and concatenates cases', () => {
    const merged = mergeTestSummaries([summary(), summary({ source: 'junit-xml:b.xml', durationMs: 50 })]);
    expect(merged).toMatchObject({ total: 4, passed: 2, failed: 2, durationMs: 150 });
    expect(merged?.source).toBe('junit-xml:a.xml + junit-xml:b.xml');
  });

  it('keeps durationMs null when no part measured one', () => {
    const merged = mergeTestSummaries([summary({ durationMs: null }), summary({ durationMs: null })]);
    expect(merged?.durationMs).toBeNull();
  });

  it('marks the merge stale if ANY part is stale', () => {
    const merged = mergeTestSummaries([summary(), summary({ stale: true })]);
    expect(merged?.stale).toBe(true);
  });

  it('returns null for nothing, rather than a zeroed summary', () => {
    // A zeroed summary would render as "0 tests, all passing".
    expect(mergeTestSummaries([])).toBeNull();
    expect(mergeCoverageSummaries([])).toBeNull();
  });

  it('unions coverage files across tracefiles', () => {
    const a: CoverageSummary = {
      files: [{ file: 'src/a.ts', lines: new Map([[1, 1]]), branchesTaken: 1, branchesTotal: 2 }],
      source: 'lcov:a',
      stale: false,
    };
    const b: CoverageSummary = {
      files: [{ file: 'src/b.ts', lines: new Map([[9, 0]]), branchesTaken: 0, branchesTotal: 1 }],
      source: 'lcov:b',
      stale: false,
    };
    const merged = mergeCoverageSummaries([a, b]);
    expect(merged?.files.map((f) => f.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(coverageTotals(merged as CoverageSummary)).toEqual({
      linesFound: 2,
      linesHit: 1,
      branchesTotal: 3,
      branchesTaken: 1,
      files: 2,
    });
  });

  it('labels a multi-artifact merge with its count', () => {
    expect(mergedSourceLabel([{ adapter: 'junit-xml', path: 'a' }])).toBe('junit-xml:a');
    expect(
      mergedSourceLabel([
        { adapter: 'junit-xml', path: 'a' },
        { adapter: 'pio-json', path: 'b' },
      ]),
    ).toBe('junit-xml+pio-json:2 files');
  });
});

describe('labels', () => {
  const base: ComponentIngest = {
    component: 'control',
    tests: null,
    coverage: null,
    testsState: 'not-configured',
    coverageState: 'not-configured',
    artifacts: [],
    unmappedCoverage: [],
    gaps: [],
  };

  it('says "not configured" — never 0% — when no tool is declared', () => {
    expect(coverageLabel(base)).toBe('not configured');
    expect(testsLabel(base)).toBe('not configured');
  });

  it('never quotes a number for a state that is not `ingested`', () => {
    const stale: ComponentIngest = {
      ...base,
      testsState: 'error',
      tests: summary({ stale: true, passed: 244 }),
    };
    expect(testsLabel(stale)).not.toContain('244');
  });

  it('formats an ingested result', () => {
    const ok: ComponentIngest = {
      ...base,
      testsState: 'ingested',
      tests: summary({ total: 5, passed: 3, failed: 1, skipped: 1 }),
      coverageState: 'ingested',
      coverage: {
        files: [{ file: 'src/a.ts', lines: new Map([[1, 1], [2, 0]]), branchesTaken: 1, branchesTotal: 4 }],
        source: 'lcov:a',
        stale: false,
      },
    };
    expect(testsLabel(ok)).toBe('3 passed · 1 failed · 1 skipped');
    expect(coverageLabel(ok)).toBe('50.0% lines · 25.0% branches (1 file)');
  });
});
