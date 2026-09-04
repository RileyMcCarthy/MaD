import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestAll } from './index.js';
import { coverageLabel, testsLabel } from './labels.js';
import type { IngestComponentInput } from './model.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

let repo: string;
let component: string;
let artifacts: string;
const NOW = Date.now();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'vibes-ingest-'));
  component = join(repo, 'Software', 'Control');
  artifacts = join(component, 'vibes', 'artifacts');
  mkdirSync(artifacts, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function put(name: string, fixtureName: string, ageMs = 0): string {
  const dest = join(artifacts, name);
  copyFileSync(join(FIXTURES, fixtureName), dest);
  const when = new Date(NOW - ageMs);
  utimesSync(dest, when, when);
  return dest;
}

function control(over: Partial<IngestComponentInput> = {}): IngestComponentInput {
  return { component: 'control', rootAbs: component, ...over };
}

const run = (components: readonly IngestComponentInput[], startedAtMs = NOW - 1000) =>
  ingestAll({ repoRoot: repo, runStartedAtMs: startedAtMs, components });

describe('ingestAll — tests', () => {
  it('ingests a fresh JUnit artifact and reports it as this run\'s evidence', async () => {
    put('junit.xml', 'vitest-2.1.9-junit.xml');
    const report = await run([control({ junit: ['vibes/artifacts/junit.xml'] })]);
    const c = report.components[0];
    expect(c?.testsState).toBe('ingested');
    expect(c?.tests?.total).toBe(4);
    expect(c?.tests?.stale).toBe(false);
    expect(c?.artifacts[0]).toMatchObject({
      kind: 'tests',
      adapter: 'junit-xml',
      path: 'Software/Control/vibes/artifacts/junit.xml',
      used: true,
      stale: false,
    });
    expect(testsLabel(c!)).toBe('2 passed · 1 failed · 1 skipped');
  });

  it('merges several artifacts matched by one glob, deterministically', async () => {
    put('a-junit.xml', 'vitest-2.1.9-junit.xml');
    put('b-junit.xml', 'pio-junit.xml');
    const report = await run([control({ junit: ['vibes/artifacts/*-junit.xml'] })]);
    const c = report.components[0];
    expect(c?.tests?.total).toBe(8);
    expect(c?.tests?.source).toBe(
      'junit-xml:Software/Control/vibes/artifacts/a-junit.xml + junit-xml:Software/Control/vibes/artifacts/b-junit.xml',
    );
  });

  it('ingests a file matched by two globs exactly once', async () => {
    put('junit.xml', 'vitest-2.1.9-junit.xml');
    const report = await run([
      control({ junit: ['vibes/artifacts/junit.xml', 'vibes/artifacts/*.xml'] }),
    ]);
    expect(report.components[0]?.tests?.total).toBe(4);
  });
});

describe('ingestAll — staleness is the first bug you would ship', () => {
  it('excludes a stale artifact and files an error gap naming it', async () => {
    // The file parses perfectly and reports four passing tests that nobody ran
    // during this run. That is the exact lie this check exists to stop.
    put('junit.xml', 'vitest-2.1.9-junit.xml', 60 * 60 * 1000);
    const report = await run([control({ junit: ['vibes/artifacts/junit.xml'] })]);
    const c = report.components[0];
    expect(c?.testsState).toBe('error');
    expect(c?.tests?.stale).toBe(true);
    const gap = c?.gaps.find((g) => g.reason === 'stale');
    expect(gap?.severity).toBe('error');
    expect(gap?.file).toBe('Software/Control/vibes/artifacts/junit.xml');
    // …and no caller can quote a number from it.
    expect(testsLabel(c!)).not.toContain('2 passed');
  });

  it('drops the stale file entirely when a fresh one exists', async () => {
    put('fresh-junit.xml', 'vitest-2.1.9-junit.xml');
    put('old-junit.xml', 'pio-junit.xml', 60 * 60 * 1000);
    const report = await run([control({ junit: ['vibes/artifacts/*-junit.xml'] })]);
    const c = report.components[0];
    expect(c?.testsState).toBe('ingested');
    expect(c?.tests?.total).toBe(4); // only the fresh one
    expect(c?.artifacts.find((a) => a.path.endsWith('old-junit.xml'))).toMatchObject({ used: false, stale: true });
    expect(c?.gaps.some((g) => g.reason === 'stale' && g.detail.includes('excluded'))).toBe(true);
  });

  it('allows a small grace window for filesystem timestamp coarseness', async () => {
    put('junit.xml', 'vitest-2.1.9-junit.xml', 1500);
    const report = await run([control({ junit: ['vibes/artifacts/junit.xml'] })], NOW);
    expect(report.components[0]?.testsState).toBe('ingested');
  });

  it('softens the stale severity when the producing step is known not to have run ok', async () => {
    put('junit.xml', 'vitest-2.1.9-junit.xml', 60 * 60 * 1000);
    const report = await run([control({ junit: ['vibes/artifacts/junit.xml'], outcome: 'failed' })]);
    expect(report.components[0]?.gaps.find((g) => g.reason === 'stale')?.severity).toBe('warn');
  });
});

describe('ingestAll — degrading honestly', () => {
  it('says "coverage not configured" BY NAME instead of returning zeros', async () => {
    put('junit.xml', 'vitest-2.1.9-junit.xml');
    const report = await run([control({ junit: ['vibes/artifacts/junit.xml'] })]);
    const c = report.components[0];
    expect(c?.coverage).toBeNull();
    expect(c?.coverageState).toBe('not-configured');
    const gap = c?.gaps.find((g) => g.kind === 'coverage');
    expect(gap?.reason).toBe('not-configured');
    expect(gap?.severity).toBe('info');
    expect(gap?.detail).toContain('coverage not configured');
    expect(gap?.detail).toContain('this is not 0% coverage');
    expect(coverageLabel(c!)).toBe('not configured');
  });

  it('renders a component with no ingest at all as not-configured, by name', async () => {
    // SIL today: no cargo-nextest, so no JUnit source. An omitted component
    // would render as silence, and silence reads as "fine".
    const report = await run([{ component: 'sil', rootAbs: repo }]);
    const c = report.components[0];
    expect([c?.testsState, c?.coverageState]).toEqual(['not-configured', 'not-configured']);
    expect(c?.gaps.map((g) => g.kind)).toEqual(['tests', 'coverage']);
    expect(c?.gaps[0]?.detail).toContain('sil');
  });

  it('errors when a required glob matches nothing, warns when required:false', async () => {
    const strict = await run([control({ junit: ['vibes/artifacts/missing.xml'] })]);
    expect(strict.components[0]?.gaps[0]).toMatchObject({ reason: 'no-files-matched', severity: 'error' });
    expect(strict.components[0]?.testsState).toBe('error');

    const lax = await run([control({ junit: ['vibes/artifacts/missing.xml'], required: false })]);
    expect(lax.components[0]?.gaps[0]).toMatchObject({ reason: 'no-files-matched', severity: 'warn' });
    expect(lax.components[0]?.testsState).toBe('not-run');
  });

  it('marks a declared-but-not-run component `not-run`, never `not-configured`', async () => {
    put('junit.xml', 'vitest-2.1.9-junit.xml');
    const report = await run([control({ junit: ['vibes/artifacts/junit.xml'], outcome: 'not-run' })]);
    expect(report.components[0]?.testsState).toBe('not-run');
    expect(report.components[0]?.gaps[0]?.reason).toBe('component-not-run');
  });

  it('refuses to call a result clean when the producing step failed', async () => {
    put('junit.xml', 'vitest-2.1.9-junit.xml');
    const report = await run([control({ junit: ['vibes/artifacts/junit.xml'], outcome: 'failed' })]);
    const c = report.components[0];
    expect(c?.testsState).toBe('error');
    expect(c?.tests?.total).toBe(4); // the evidence is still shown
    expect(c?.gaps.some((g) => g.reason === 'producer-failed')).toBe(true);
  });

  it('files a parse-failed gap instead of throwing the whole run away', async () => {
    writeFileSync(join(artifacts, 'broken.xml'), '<testsuites><testsuite');
    put('good.xml', 'vitest-2.1.9-junit.xml');
    const report = await run([control({ junit: ['vibes/artifacts/*.xml'] })]);
    const c = report.components[0];
    expect(c?.gaps.some((g) => g.reason === 'parse-failed')).toBe(true);
    expect(c?.tests?.total).toBe(4); // the good file still counts
  });

  it('treats an empty-but-valid report as unusable, not as "0 tests, all fine"', async () => {
    writeFileSync(join(artifacts, 'empty.xml'), '<testsuites tests="0"/>');
    const report = await run([control({ junit: ['vibes/artifacts/empty.xml'] })]);
    const c = report.components[0];
    expect(c?.testsState).toBe('error');
    expect(c?.gaps.some((g) => g.reason === 'empty' && g.severity === 'error')).toBe(true);
  });
});

describe('ingestAll — a wrong declaration is caught, not obeyed', () => {
  it('parses a mis-declared test artifact with the sniffed adapter and warns', async () => {
    // `junit:` pointed at vitest's JSON reporter. Parsing it as XML would
    // yield zero cases, which renders as "tests ran, nothing there".
    put('junit.xml', 'vitest-2.1.9.json');
    const report = await run([control({ junit: ['vibes/artifacts/junit.xml'] })]);
    const c = report.components[0];
    expect(c?.tests?.total).toBe(4);
    expect(c?.gaps.find((g) => g.reason === 'format-mismatch')).toMatchObject({ severity: 'warn' });
    expect(c?.artifacts[0]?.adapter).toBe('vitest-json');
  });

  it('refuses to ingest a tracefile through a test glob', async () => {
    put('junit.xml', 'lcov-geninfo.info');
    const report = await run([control({ junit: ['vibes/artifacts/junit.xml'] })]);
    const c = report.components[0];
    expect(c?.tests).toBeNull();
    expect(c?.testsState).toBe('error');
    expect(c?.gaps.find((g) => g.reason === 'format-mismatch')).toMatchObject({ severity: 'error' });
  });
});

describe('ingestAll — coverage', () => {
  it('ingests a tracefile and anchors its SF paths at the declared sourceRoot', async () => {
    put('cov.info', 'lcov-geninfo.info');
    const report = await run([
      control({ lcov: [{ glob: 'vibes/artifacts/cov.info', sourceRootAbs: component }] }),
    ]);
    const c = report.components[0];
    expect(c?.coverageState).toBe('ingested');
    expect(c?.coverage?.files.map((f) => f.file)).toEqual([
      'Software/Control/src/domain/csv.ts',
      'Software/Control/src/domain/gcode.ts',
    ]);
    expect(coverageLabel(c!)).toBe('50.0% lines · 25.0% branches (2 files)');
  });

  it('surfaces unmapped SF paths with counts rather than dropping them', async () => {
    writeFileSync(join(artifacts, 'cov.info'), 'SF:/opt/vendor/x.ts\nDA:1,1\nDA:2,0\nend_of_record\n');
    const report = await run([
      control({ lcov: [{ glob: 'vibes/artifacts/cov.info', sourceRootAbs: component }] }),
    ]);
    const c = report.components[0];
    expect(c?.unmappedCoverage).toEqual([
      expect.objectContaining({ raw: '/opt/vendor/x.ts', lines: 2, reason: 'outside-repo' }),
    ]);
    // Nothing mapped, so there is no coverage to report — and it says so.
    expect(c?.coverageState).toBe('error');
  });
});

describe('ingestAll — multiple components', () => {
  it('keeps components independent and flattens their gaps in order', async () => {
    put('junit.xml', 'vitest-2.1.9-junit.xml');
    const firmware = join(repo, 'Firmware', 'MaDCore');
    mkdirSync(join(firmware, 'vibes', 'artifacts'), { recursive: true });
    copyFileSync(join(FIXTURES, 'pio-test-report.json'), join(firmware, 'vibes', 'artifacts', 'pio.json'));

    const report = await run([
      control({ junit: ['vibes/artifacts/junit.xml'] }),
      { component: 'firmware', rootAbs: firmware, pioJson: ['vibes/artifacts/pio.json'] },
    ]);
    expect(report.components.map((c) => c.component)).toEqual(['control', 'firmware']);
    expect(report.components[1]?.tests?.total).toBe(5);
    expect(report.gaps).toEqual([...(report.components[0]?.gaps ?? []), ...(report.components[1]?.gaps ?? [])]);
  });
});
