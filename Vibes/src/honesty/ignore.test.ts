import { describe, expect, test } from 'vitest';

import {
  EMPTY_IGNORE,
  compileRule,
  daysExpired,
  evaluateIgnore,
  isExpired,
  matchingRule,
  parseIgnoreFile,
  utcDay,
} from './ignore.js';

const at = (iso: string): Date => new Date(`${iso}T12:00:00.000Z`);

describe('parseIgnoreFile', () => {
  test('parses the three-field grammar', () => {
    const f = parseIgnoreFile('docs/** :: docs are not behaviour :: until=2026-12-31\n');
    expect(f.errors).toEqual([]);
    expect(f.rules).toHaveLength(1);
    expect(f.rules[0]).toMatchObject({
      glob: 'docs/**',
      reason: 'docs are not behaviour',
      until: '2026-12-31',
      line: 1,
    });
  });

  test('blank lines and # comments are skipped, and line numbers stay 1-based', () => {
    const f = parseIgnoreFile('# a comment\n\nsrc/** :: why :: until=2030-01-01\n');
    expect(f.rules[0]?.line).toBe(3);
    expect(f.errors).toEqual([]);
  });

  test('a missing reason is an error, not a silently dropped line', () => {
    const f = parseIgnoreFile('docs/** ::  :: until=2030-01-01\n');
    expect(f.rules).toEqual([]);
    expect(f.errors[0]?.message).toMatch(/no stated reason/);
  });

  test('a missing until= is an error — a suppression that never expires is permanent', () => {
    const f = parseIgnoreFile('docs/** :: because :: forever\n');
    expect(f.rules).toEqual([]);
    expect(f.errors[0]?.message).toMatch(/missing `until=`/);
  });

  test('a non-calendar until= is rejected', () => {
    const f = parseIgnoreFile('docs/** :: because :: until=next-tuesday\n');
    expect(f.errors[0]?.message).toMatch(/not a YYYY-MM-DD/);
  });

  test('a glob containing # survives — which is why `::` is the separator', () => {
    const f = parseIgnoreFile('src/c#sharp/** :: legacy dir :: until=2030-01-01\n');
    expect(f.rules[0]?.glob).toBe('src/c#sharp/**');
  });

  test('braces are rejected, matching every other glob surface in the tool', () => {
    const f = parseIgnoreFile('src/**/*.{ts,tsx} :: because :: until=2030-01-01\n');
    expect(f.rules).toEqual([]);
    expect(f.errors[0]?.message).toMatch(/brace expansion/);
  });

  test('a reason containing :: is reported as a field-count error, not truncated', () => {
    const f = parseIgnoreFile('src/** :: see PR :: 12 :: until=2030-01-01\n');
    expect(f.rules).toEqual([]);
    expect(f.errors[0]?.message).toMatch(/found 4/);
  });

  test('a UTF-8 BOM does not become part of the first glob', () => {
    const f = parseIgnoreFile('﻿docs/** :: because :: until=2030-01-01\n');
    expect(f.rules[0]?.glob).toBe('docs/**');
  });

  test('CRLF line endings parse', () => {
    const f = parseIgnoreFile('docs/** :: because :: until=2030-01-01\r\nsrc/** :: also :: until=2030-01-01\r\n');
    expect(f.rules).toHaveLength(2);
    expect(f.rules[1]?.until).toBe('2030-01-01');
  });

  test('one bad line does not take the good ones with it', () => {
    const f = parseIgnoreFile('good/** :: r :: until=2030-01-01\nbad-line\nalso/** :: r :: until=2030-01-01\n');
    expect(f.rules.map((r) => r.glob)).toEqual(['good/**', 'also/**']);
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]?.line).toBe(2);
  });
});

describe('expiry', () => {
  const rule = parseIgnoreFile('docs/** :: r :: until=2026-08-22\n').rules[0];

  test('a suppression is in force THROUGH the named day', () => {
    expect(rule).toBeDefined();
    if (rule === undefined) return;
    expect(isExpired(rule, at('2026-08-22'))).toBe(false);
    expect(isExpired(rule, at('2026-08-23'))).toBe(true);
  });

  test('expiry is computed in UTC, so a machine west of Greenwich agrees', () => {
    expect(rule).toBeDefined();
    if (rule === undefined) return;
    // 2026-08-23T02:00Z is still 2026-08-22 in UTC-8. The rule must be expired
    // for both, because the comparison is on the UTC day, not the local one.
    expect(utcDay(new Date('2026-08-23T02:00:00.000Z'))).toBe('2026-08-23');
    expect(isExpired(rule, new Date('2026-08-23T02:00:00.000Z'))).toBe(true);
  });

  test('daysExpired counts whole days and never goes negative', () => {
    expect(rule).toBeDefined();
    if (rule === undefined) return;
    expect(daysExpired(rule, at('2026-08-25'))).toBe(3);
    expect(daysExpired(rule, at('2026-01-01'))).toBe(0);
  });
});

describe('evaluateIgnore', () => {
  const file = parseIgnoreFile(
    [
      'docs/** :: docs are not behaviour :: until=2030-01-01',
      'gone/** :: matches nothing :: until=2030-01-01',
      'old/** :: lapsed :: until=2020-01-01',
    ].join('\n'),
  );

  test('splits active from expired and names the rules that matched nothing', () => {
    const e = evaluateIgnore(file, at('2026-08-22'), ['docs/a.md', 'src/x.ts', 'src/y.ts']);
    expect(e.active.map((r) => r.glob)).toEqual(['docs/**', 'gone/**']);
    expect(e.expired.map((r) => r.glob)).toEqual(['old/**']);
    expect(e.stale.map((r) => r.glob)).toEqual(['gone/**']);
  });

  test('a universal glob is reported as matching all', () => {
    const e = evaluateIgnore(
      parseIgnoreFile('** :: quiet please :: until=2030-01-01'),
      at('2026-08-22'),
      ['a', 'b', 'c'],
    );
    expect(e.matchesAll).toHaveLength(1);
  });

  test('rules that between them cover every candidate path are caught too', () => {
    const e = evaluateIgnore(
      parseIgnoreFile(
        ['a/** :: r :: until=2030-01-01', 'b/** :: r :: until=2030-01-01', 'c/** :: r :: until=2030-01-01'].join('\n'),
      ),
      at('2026-08-22'),
      ['a/1', 'b/1', 'c/1'],
    );
    expect(e.matchesAll).toEqual([]);
    expect(e.suppressesEverything).toBe(true);
  });

  test('covering the one file you are working on is not "suppresses everything"', () => {
    const e = evaluateIgnore(
      parseIgnoreFile('a/** :: r :: until=2030-01-01'),
      at('2026-08-22'),
      ['a/1', 'a/2'],
    );
    expect(e.suppressesEverything).toBe(false);
  });

  test('an empty file suppresses nothing and reports nothing', () => {
    const e = evaluateIgnore(EMPTY_IGNORE, at('2026-08-22'), ['a', 'b']);
    expect(e.active).toEqual([]);
    expect(e.suppressesEverything).toBe(false);
  });
});

describe('matchingRule', () => {
  const rules = parseIgnoreFile('docs/** :: r :: until=2030-01-01').rules;

  test('a rule must match EVERY path of a finding, not just one', () => {
    expect(matchingRule(['docs/a.md', 'docs/b.md'], rules)?.glob).toBe('docs/**');
    // Nine unsuppressed problems must not be hidden by one suppressed path.
    expect(matchingRule(['docs/a.md', 'src/x.ts'], rules)).toBeNull();
  });

  test('a finding with no paths can never be suppressed by a path glob', () => {
    expect(matchingRule(undefined, rules)).toBeNull();
    expect(matchingRule([], rules)).toBeNull();
  });

  test('compiled rules do not expand braces even if one slipped through', () => {
    const match = compileRule({
      glob: 'src/*.{ts}',
      reason: 'r',
      until: '2030-01-01',
      line: 1,
      source: 'vibes.ignore',
      raw: '',
    });
    expect(match('src/a.ts')).toBe(false);
  });
});
