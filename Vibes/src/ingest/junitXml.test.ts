import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseJUnitXml } from './adapters/junitXml.js';
import { AdapterParseError, type TestParseOptions } from './adapters/shared.js';

const REPO = '/Users/ci/work/repo';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

function opts(rootAbs: string, extra: Partial<TestParseOptions> = {}): TestParseOptions {
  return { repoRoot: REPO, rootAbs, sourceLabel: 'junit-xml:test.xml', stale: false, ...extra };
}

describe('parseJUnitXml — vitest 2.1.9 dialect (captured from a real run)', () => {
  const xml = fixture('vitest-2.1.9-junit.xml');

  it('reads every case, including the suite that holds exactly ONE testcase', () => {
    // The isArray regression: without an isArray predicate covering
    // `testcase`, a single-case suite parses as an object and beta.test.ts's
    // only test disappears — silently, with a green report.
    const { summary } = parseJUnitXml(xml, opts(`${REPO}/Software/Control`));
    expect(summary.total).toBe(4);
    expect(summary.cases.map((c) => `${c.suite} :: ${c.name}`)).toEqual([
      'test/alpha.test.ts :: outer > inner > passes',
      'test/alpha.test.ts :: outer > inner > fails',
      'test/alpha.test.ts :: outer > is skipped',
      'test/beta.test.ts :: lonely case',
    ]);
  });

  it('keeps the attributes — counts, names and times all live in them', () => {
    // The ignoreAttributes regression: fast-xml-parser DROPS attributes by
    // default, which would leave every case unnamed, untimed and unstatused.
    const { summary } = parseJUnitXml(xml, opts(`${REPO}/Software/Control`));
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.durationMs).toBe(700); // <testsuites time="0.7">
    expect(summary.cases[0]?.durationMs).toBeCloseTo(0.637333, 5);
  });

  it('decodes XML entities in case names', () => {
    const { summary } = parseJUnitXml(xml, opts(`${REPO}/Software/Control`));
    expect(summary.cases[1]?.name).toBe('outer > inner > fails');
  });

  it('carries the failure type and message', () => {
    const { summary } = parseJUnitXml(xml, opts(`${REPO}/Software/Control`));
    const failing = summary.cases[1];
    expect(failing?.status).toBe('failed');
    expect(failing?.message).toContain('AssertionError: expected 1 to be 2');
  });

  it('does not treat `classname` as a path (R-I5)', () => {
    // vitest writes a path there and maven writes an FQCN; there is no way to
    // tell, so no case gets a `file` from it.
    const { summary } = parseJUnitXml(xml, opts(`${REPO}/Software/Control`));
    expect(summary.cases.every((c) => c.file === undefined)).toBe(true);
  });
});

describe('parseJUnitXml — PlatformIO dialect', () => {
  const xml = fixture('pio-junit.xml');
  const root = `${REPO}/Firmware/MaDCore`;

  it('reads status from the `status` attribute when there is no child element', () => {
    const { summary } = parseJUnitXml(xml, opts(root));
    expect(summary.cases.map((c) => [c.name, c.status])).toEqual([
      ['test_parse_g1', 'passed'],
      ['test_parse_g122', 'failed'],
      ['test_parse_crash', 'failed'],
      ['test_skipme', 'skipped'],
    ]);
  });

  it('maps the `file` attribute — the only attribute that is a path', () => {
    const { summary } = parseJUnitXml(xml, opts(root));
    expect(summary.cases[0]?.file).toBe('Firmware/MaDCore/test/test_gcode/main.c');
  });

  it('names suites with the env:test label PlatformIO writes', () => {
    const { summary } = parseJUnitXml(xml, opts(root));
    expect(new Set(summary.cases.map((c) => c.suite))).toEqual(
      new Set(['native_test:test_gcode', 'native_test:test_queue']),
    );
  });

  it('treats <error> like <failure> — an errored case is not a pass', () => {
    const { summary } = parseJUnitXml(xml, opts(root));
    const errored = summary.cases.find((c) => c.name === 'test_parse_crash');
    expect(errored?.status).toBe('failed');
    expect(errored?.message).toContain('SIGSEGV');
  });
});

describe('parseJUnitXml — dialect coverage', () => {
  it('accepts a bare <testsuite> root with no <testsuites> wrapper', () => {
    const xml = '<testsuite name="s" tests="1" time="1.5"><testcase name="a" time="1.5"/></testsuite>';
    const { summary } = parseJUnitXml(xml, opts(REPO));
    expect(summary.total).toBe(1);
    expect(summary.durationMs).toBe(1500);
  });

  it('walks nested <testsuite> elements and keeps the ancestry in the label', () => {
    const xml = [
      '<testsuites>',
      '<testsuite name="outer">',
      '<testsuite name="inner"><testcase name="a"/></testsuite>',
      '</testsuite>',
      '</testsuites>',
    ].join('');
    const { summary } = parseJUnitXml(xml, opts(REPO));
    expect(summary.cases[0]?.suite).toBe('outer > inner');
  });

  it('reports a missing time attribute as null, never as 0', () => {
    const xml = '<testsuites><testsuite name="s"><testcase name="a"/></testsuite></testsuites>';
    const { summary } = parseJUnitXml(xml, opts(REPO));
    expect(summary.cases[0]?.durationMs).toBeNull();
    expect(summary.durationMs).toBeNull();
  });

  it('flags a header count that disagrees with the case list', () => {
    const xml = '<testsuites tests="9"><testsuite name="s"><testcase name="a"/></testsuite></testsuites>';
    const { notes } = parseJUnitXml(xml, opts(REPO));
    expect(notes.some((n) => n.reason === 'count-mismatch' && n.detail.includes('tests="9"'))).toBe(true);
  });

  it('throws on XML that is not a JUnit report at all', () => {
    expect(() => parseJUnitXml('<coverage lines="4"/>', opts(REPO))).toThrow(AdapterParseError);
  });

  it('drops an unmappable file attribute rather than inventing a path', () => {
    const xml = '<testsuite name="s"><testcase name="a" file="/opt/elsewhere/x.c"/></testsuite>';
    const { summary, notes } = parseJUnitXml(xml, opts(REPO));
    expect(summary.cases[0]?.file).toBeUndefined();
    expect(notes.some((n) => n.reason === 'unmapped-paths')).toBe(true);
  });
});
