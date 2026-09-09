import { describe, expect, test } from 'vitest';

import {
  FindingBag,
  applySuppressions,
  describePaths,
  sortFindings,
  toContractFinding,
  toRef,
} from './findings.js';
import { parseIgnoreFile, type IgnoreRule } from './ignore.js';
import {
  ALWAYS_EXPANDED,
  DEFAULT_SEVERITY,
  DEFAULT_SEVERITY_POLICY,
  NON_SUPPRESSIBLE,
  findingId,
  makeFinding,
  severityOf,
  type FindingCode,
} from './model.js';

const rules = (text: string): readonly IgnoreRule[] => parseIgnoreFile(text).rules;

describe('the false-positive budget', () => {
  test('a 300-file refactor produces ONE finding carrying 300 paths, not 300 findings', () => {
    const bag = new FindingBag();
    for (let i = 0; i < 300; i += 1) {
      bag.add({
        code: 'unexercised-change',
        severity: 'warn',
        component: 'control',
        title: 'unexercised',
        detail: 'd',
        paths: [`src/f${String(i)}.ts`],
      });
    }
    const items = bag.items;
    expect(items).toHaveLength(1);
    expect(items[0]?.paths).toHaveLength(300);
  });

  test('the key is (code, component, producer) — different producers stay separate', () => {
    const bag = new FindingBag();
    bag.add({ code: 'producer-failed', severity: 'error', component: 'c', producer: 'a', title: 't', detail: 'd' });
    bag.add({ code: 'producer-failed', severity: 'error', component: 'c', producer: 'b', title: 't', detail: 'd' });
    expect(bag.items.map((f) => f.id)).toEqual(['producer-failed:c/a', 'producer-failed:c/b']);
  });

  test('merging never quiets an existing row: the louder severity wins', () => {
    const bag = new FindingBag();
    bag.add({ code: 'policy-changed', severity: 'error', component: 'c', title: 't', detail: 'd' });
    bag.add({ code: 'policy-changed', severity: 'info', component: 'c', title: 't', detail: 'd' });
    expect(bag.items[0]?.severity).toBe('error');
  });

  test('merged paths and evidence are deduplicated', () => {
    const bag = new FindingBag();
    bag.add({ code: 'not-run', severity: 'warn', component: 'c', title: 't', detail: 'd', paths: ['a'], evidence: ['e'] });
    bag.add({ code: 'not-run', severity: 'warn', component: 'c', title: 't', detail: 'd', paths: ['a', 'b'], evidence: ['e'] });
    expect(bag.items[0]?.paths).toEqual(['a', 'b']);
    expect(bag.items[0]?.evidence).toEqual(['e']);
  });

  test('describePaths names a few and counts the rest', () => {
    expect(describePaths(['a', 'b', 'c', 'd', 'e'])).toBe('`a`, `b`, `c` and 2 more');
    expect(describePaths(['a'])).toBe('`a`');
    expect(describePaths([])).toBe('no paths');
  });
});

describe('ordering is stable across runs', () => {
  test('sorted() is by severity, then code, then id — never insertion order', () => {
    // Two runs on the same tree must produce byte-identical reports.
    const bag = new FindingBag();
    bag.add({ code: 'suppression-stale', severity: 'info', title: 't', detail: 'd' });
    bag.add({ code: 'unreceipted-baseline', severity: 'error', component: 'z', title: 't', detail: 'd' });
    bag.add({ code: 'unexercised-change', severity: 'warn', component: 'a', title: 't', detail: 'd' });
    bag.add({ code: 'corpus-shrank', severity: 'error', component: 'a', title: 't', detail: 'd' });
    expect(bag.sorted().map((f) => f.id)).toEqual([
      'corpus-shrank:a',
      'unreceipted-baseline:z',
      'unexercised-change:a',
      'suppression-stale',
    ]);
  });

  test('sortFindings is idempotent', () => {
    const made = [
      makeFinding({ code: 'not-run', severity: 'warn', component: 'b', title: 't', detail: 'd' }),
      makeFinding({ code: 'not-run', severity: 'warn', component: 'a', title: 't', detail: 'd' }),
    ];
    expect(sortFindings(sortFindings(made))).toEqual(sortFindings(made));
  });

  test('the id is prefixed by the code, which is how the emitter routes governance rows', () => {
    expect(findingId('policy-weakened', 'control')).toBe('policy-weakened:control');
    expect(findingId('unreceipted-baseline', 'control', 'domain')).toBe('unreceipted-baseline:control/domain');
    expect(findingId('partial-run')).toBe('partial-run');
    for (const code of ['policy-weakened', 'unreceipted-baseline', 'corpus-shrank'] as FindingCode[]) {
      expect(findingId(code, 'c')).toMatch(/^(governance|policy|weaken|corpus-shr|unreceipted)/);
    }
  });
});

describe('suppression is never invisible', () => {
  const active = rules('docs/** :: docs are not behaviour :: until=2030-01-01');

  test('a suppressed finding is still LISTED, with the rule that governs it', () => {
    const f = makeFinding({ code: 'unclaimed-change', severity: 'info', title: 't', detail: 'd', paths: ['docs/a.md'] });
    const out = applySuppressions([f], active);
    expect(out.all).toHaveLength(1);
    expect(out.effective).toHaveLength(0);
    expect(out.suppressed[0]?.suppressedBy).toEqual(toRef(active[0] as IgnoreRule));
    expect(out.usedRules).toHaveLength(1);
  });

  test('the governing rule, its reason and its expiry reach the rendered detail', () => {
    const f = makeFinding({ code: 'unclaimed-change', severity: 'info', title: 't', detail: 'base', paths: ['docs/a.md'] });
    const [suppressed] = applySuppressions([f], active).suppressed;
    expect(suppressed).toBeDefined();
    if (suppressed === undefined) return;
    const contract = toContractFinding(suppressed);
    expect(contract.detail).toContain('docs are not behaviour');
    expect(contract.detail).toContain('until 2030-01-01');
    expect(contract.detail).toContain('vibes.ignore:1');
  });

  test('the guardrail codes cannot be suppressed at all', () => {
    const all = rules('** :: quiet :: until=2030-01-01');
    for (const code of NON_SUPPRESSIBLE) {
      const f = makeFinding({ code, severity: 'error', title: 't', detail: 'd', paths: ['anything'] });
      expect(applySuppressions([f], all).suppressed).toEqual([]);
    }
  });

  test('a finding whose paths are only PARTLY covered is not suppressed', () => {
    const f = makeFinding({
      code: 'unclaimed-change',
      severity: 'info',
      title: 't',
      detail: 'd',
      paths: ['docs/a.md', 'src/x.ts'],
    });
    expect(applySuppressions([f], active).effective).toHaveLength(1);
  });
});

describe('severity policy', () => {
  test('unexercised-change is a WARNING, deliberately', () => {
    // It is the headline capability and it still must not error: a pure
    // refactor legitimately moves nothing, and a check that fires on correct
    // work gets disabled — at which point the capability is gone for good.
    expect(DEFAULT_SEVERITY['unexercised-change']).toBe('warn');
  });

  test('the two moves that make a snapshot tool lie are errors with no lax mode', () => {
    expect(DEFAULT_SEVERITY['unreceipted-baseline']).toBe('error');
    expect(DEFAULT_SEVERITY['corpus-shrank']).toBe('error');
    expect(severityOf('unreceipted-baseline', { ...DEFAULT_SEVERITY_POLICY, failOnHonestyViolation: false })).toBe('error');
  });

  test('strict escalates accept-without-source-change to an error', () => {
    expect(severityOf('accept-without-source-change', DEFAULT_SEVERITY_POLICY)).toBe('warn');
    expect(severityOf('accept-without-source-change', { ...DEFAULT_SEVERITY_POLICY, strict: true })).toBe('error');
  });

  test('a Vibes-Weakening-Ack trailer demotes policy-weakened to a warning — visible, not impossible', () => {
    expect(severityOf('policy-weakened', DEFAULT_SEVERITY_POLICY)).toBe('error');
    expect(severityOf('policy-weakened', { ...DEFAULT_SEVERITY_POLICY, weakeningAck: 'raised for the new load cell' })).toBe('warn');
    // Whitespace is not an acknowledgement.
    expect(severityOf('policy-weakened', { ...DEFAULT_SEVERITY_POLICY, weakeningAck: '   ' })).toBe('error');
  });

  test('failOn.governanceWeakened:false demotes but never hides', () => {
    expect(severityOf('policy-weakened', { ...DEFAULT_SEVERITY_POLICY, failOnGovernanceWeakened: false })).toBe('warn');
  });

  test('failOn.honestyViolation:false demotes attribution findings to info only', () => {
    const policy = { ...DEFAULT_SEVERITY_POLICY, failOnHonestyViolation: false };
    expect(severityOf('unexercised-change', policy)).toBe('info');
    expect(severityOf('not-run', policy)).toBe('info');
    expect(severityOf('policy-weakened', policy)).toBe('error');
  });

  test('an explicit override beats everything, including strict', () => {
    expect(
      severityOf('unexercised-change', {
        ...DEFAULT_SEVERITY_POLICY,
        strict: true,
        overrides: { 'unexercised-change': 'error' },
      }),
    ).toBe('error');
  });

  test('every declared code has a default severity', () => {
    for (const code of Object.keys(DEFAULT_SEVERITY) as FindingCode[]) {
      expect(severityOf(code, DEFAULT_SEVERITY_POLICY)).toMatch(/^(error|warn|info)$/);
    }
  });

  test('the always-expanded set maps onto Finding.alwaysExpanded', () => {
    for (const code of ALWAYS_EXPANDED) {
      expect(makeFinding({ code, severity: 'error', title: 't', detail: 'd' }).alwaysExpanded).toBe(true);
    }
    expect(makeFinding({ code: 'suppression-stale', severity: 'info', title: 't', detail: 'd' }).alwaysExpanded).toBeUndefined();
  });
});

describe('toContractFinding', () => {
  test('projects onto the shared shape and drops absent optionals', () => {
    const f = makeFinding({ code: 'partial-run', severity: 'warn', title: 't', detail: 'd' });
    expect(toContractFinding(f)).toEqual({ id: 'partial-run', severity: 'warn', title: 't', detail: 'd' });
  });

  test('keeps component, paths and alwaysExpanded when present', () => {
    const f = makeFinding({
      code: 'corpus-shrank',
      severity: 'error',
      component: 'c',
      title: 't',
      detail: 'd',
      paths: ['a'],
    });
    expect(toContractFinding(f)).toMatchObject({ component: 'c', paths: ['a'], alwaysExpanded: true });
  });
});
