import { describe, expect, test } from 'vitest';

import type { ComponentPlan, ProducerPlan } from '../config/index.js';
import type { CompareSpec, FailPolicy } from '../types.js';
import {
  POLICY_LOCK_SCHEMA,
  canonicalJson,
  compareLockToLive,
  diffPolicy,
  fingerprintComponent,
  lockRoster,
  lostPaths,
  normalizeCompare,
  parseLock,
  parseWeakeningAck,
  serializeLock,
  type PolicyComponent,
  type PolicyLock,
  type PolicyProducer,
} from './policyLock.js';

/* ────────────────────────────── builders ─────────────────────────────── */

const FAIL_ON: Required<FailPolicy> = {
  producerError: true,
  ingestMissing: true,
  honestyViolation: true,
  governanceWeakened: true,
  snapshotDrift: true,
};

function prod(over: Partial<PolicyProducer> = {}): PolicyProducer {
  return {
    name: 'p',
    out: 'c/vibes/snapshots/p',
    tier: 'pr',
    ciJob: 'ci-gate',
    runWhen: 'always',
    minCases: null,
    clean: true,
    renderer: null,
    resources: [],
    compare: [{ match: '**', kind: 'exact', abs: null, rel: null, columns: null, maxDiffRatio: null, threshold: null }],
    ...over,
  };
}

function comp(over: Partial<PolicyComponent> = {}): PolicyComponent {
  return {
    id: 'c',
    root: 'c',
    enabled: true,
    disabledUntil: null,
    dependsOn: [],
    generates: [],
    submodules: [],
    witnesses: ['c/src/**'],
    ingestRequired: true,
    producers: [prod()],
    ...over,
  };
}

function lock(components: readonly PolicyComponent[] = [comp()]): PolicyLock {
  return { schema: POLICY_LOCK_SCHEMA, version: 1, baseRef: 'origin/main', failOn: FAIL_ON, components };
}

const kinds = (base: PolicyLock, head: PolicyLock, tracked?: readonly string[]): string[] =>
  diffPolicy(base, head, tracked === undefined ? {} : { tracked }).deltas.map((d) => d.kind);

const weakenedKinds = (base: PolicyLock, head: PolicyLock, tracked?: readonly string[]): string[] =>
  diffPolicy(base, head, tracked === undefined ? {} : { tracked }).weakened.map((d) => d.kind);

/* ──────────────────────────── serialisation ──────────────────────────── */

describe('the lock is a file-format contract', () => {
  test('canonical JSON sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe(
      '{\n  "a": {\n    "c": [\n      {\n        "e": 2,\n        "f": 1\n      }\n    ],\n    "d": 2\n  },\n  "b": 1\n}',
    );
  });

  test('serialise → parse → serialise is a fixed point', () => {
    const text = serializeLock(lock());
    const parsed = parseLock(text);
    expect(parsed.error).toBeNull();
    expect(parsed.lock === null ? '' : serializeLock(parsed.lock)).toBe(text);
    expect(text.endsWith('\n')).toBe(true);
  });

  test('key order in the input does not change the bytes', () => {
    const a = serializeLock(lock([comp({ producers: [prod({ name: 'x' }), prod({ name: 'a' })] })]));
    const b = serializeLock(lock([comp({ producers: [prod({ name: 'a' }), prod({ name: 'x' })] })]));
    // Producers sort by name in the fingerprint, so the two must agree only if
    // they were already sorted — here they are not, which is exactly why
    // `fingerprintComponent` sorts and `serializeLock` does not.
    expect(a).not.toBe(b);
  });

  test('a wrong schema is rejected rather than half-read', () => {
    expect(parseLock(JSON.stringify({ schema: 'other/1', components: [] })).error).toMatch(/unexpected schema/);
    expect(parseLock('nope').error).toMatch(/not valid JSON/);
    expect(parseLock(JSON.stringify({ schema: POLICY_LOCK_SCHEMA })).error).toMatch(/missing `components`/);
  });

  test('lockRoster flattens to (component, producer) pairs', () => {
    expect(lockRoster(lock([comp({ producers: [prod({ name: 'a' }), prod({ name: 'b' })] })]))).toEqual([
      { component: 'c', producer: 'a' },
      { component: 'c', producer: 'b' },
    ]);
  });
});

describe('normalizeCompare', () => {
  test('a bare mode becomes a rule matching everything — one shape to diff', () => {
    expect(normalizeCompare({ kind: 'exact' })).toEqual([
      { match: '**', kind: 'exact', abs: null, rel: null, columns: null, maxDiffRatio: null, threshold: null },
    ]);
  });

  test('an undefined spec is exact, matching the resolver default', () => {
    expect(normalizeCompare(undefined)[0]?.kind).toBe('exact');
  });

  test('every tolerance bound survives the fingerprint', () => {
    const spec: CompareSpec = [
      { match: '*.csv', use: { kind: 'tolerance', abs: 0.01, rel: 1e-4, columns: ['force'], reason: 'sensor noise' } },
    ];
    expect(normalizeCompare(spec)[0]).toEqual({
      match: '*.csv',
      kind: 'tolerance',
      abs: 0.01,
      rel: 1e-4,
      columns: ['force'],
      maxDiffRatio: null,
      threshold: null,
    });
  });
});

/* ──────────────────────── drift classification ───────────────────────── */

describe('weakening classification', () => {
  test('a removed component is weakening and stops the diff there', () => {
    expect(weakenedKinds(lock(), lock([]))).toEqual(['component-removed']);
  });

  test('an added component is NOT weakening', () => {
    expect(diffPolicy(lock([]), lock()).weakened).toEqual([]);
    expect(kinds(lock([]), lock())).toEqual(['component-added']);
  });

  test('disabling a component is weakening; re-enabling it is not', () => {
    expect(weakenedKinds(lock(), lock([comp({ enabled: false })]))).toEqual(['component-disabled']);
    expect(weakenedKinds(lock([comp({ enabled: false })]), lock())).toEqual([]);
  });

  test('a witness removed is weakening; one added is not', () => {
    expect(weakenedKinds(lock(), lock([comp({ witnesses: [] })]))).toEqual(['witness-removed']);
    expect(weakenedKinds(lock([comp({ witnesses: [] })]), lock())).toEqual([]);
  });

  test('a narrowed witness is computed set-theoretically over tracked files', () => {
    const tracked = ['c/src/a.ts', 'c/src/deep/b.ts', 'other/x.ts'];
    const d = diffPolicy(lock(), lock([comp({ witnesses: ['c/src/*.ts'] })]), { tracked });
    const narrowed = d.deltas.find((x) => x.kind === 'witness-narrowed');
    expect(narrowed?.weakening).toBe(true);
    expect(narrowed?.lost).toEqual(['c/src/deep/b.ts']);
  });

  test('a root narrowed into a subdirectory is weakening; a lateral move is reported without the flag', () => {
    expect(weakenedKinds(lock(), lock([comp({ root: 'c/inner' })]))).toEqual(['root-narrowed']);
    const lateral = diffPolicy(lock(), lock([comp({ root: 'elsewhere' })]));
    expect(lateral.deltas.map((x) => x.kind)).toEqual(['root-changed']);
    expect(lateral.weakened).toEqual([]);
  });

  test('exact → tolerance is weakening: a tolerant compare cannot report a change below its bound', () => {
    const head = lock([
      comp({ producers: [prod({ compare: normalizeCompare({ kind: 'tolerance', rel: 1e-4, reason: 'noise' }) })] }),
    ]);
    // The `**` rule existed on both sides and got looser, so it is a loosening
    // of an existing rule rather than a newly introduced tolerance.
    expect(weakenedKinds(lock(), head)).toEqual(['compare-loosened']);
  });

  test('a NEW tolerant rule for a glob that had none is `tolerance-added`', () => {
    const head = lock([
      comp({
        producers: [
          prod({
            compare: [
              { match: '*.csv', kind: 'tolerance', abs: 0.01, rel: null, columns: null, maxDiffRatio: null, threshold: null },
              { match: '**', kind: 'exact', abs: null, rel: null, columns: null, maxDiffRatio: null, threshold: null },
            ],
          }),
        ],
      }),
    ]);
    expect(weakenedKinds(lock(), head)).toEqual(['tolerance-added']);
  });

  test('tolerance → exact is a tightening', () => {
    const base = lock([
      comp({ producers: [prod({ compare: normalizeCompare({ kind: 'tolerance', rel: 1e-4, reason: 'noise' }) })] }),
    ]);
    expect(kinds(base, lock())).toEqual(['compare-tightened']);
    expect(diffPolicy(base, lock()).weakened).toEqual([]);
  });

  test('a raised epsilon is weakening and a lowered one is not', () => {
    const at = (rel: number): PolicyLock =>
      lock([comp({ producers: [prod({ compare: normalizeCompare({ kind: 'tolerance', rel, reason: 'r' }) })] })]);
    expect(weakenedKinds(at(1e-5), at(1e-4))).toEqual(['tolerance-raised']);
    expect(weakenedKinds(at(1e-4), at(1e-5))).toEqual([]);
    expect(kinds(at(1e-4), at(1e-5))).toEqual(['tolerance-lowered']);
  });

  test('naming a column subset stops comparing the rest, so it is weakening', () => {
    const withCols = (columns: readonly string[] | undefined): PolicyLock =>
      lock([
        comp({
          producers: [
            prod({
              compare: normalizeCompare(
                columns === undefined
                  ? { kind: 'tolerance', abs: 1, reason: 'r' }
                  : { kind: 'tolerance', abs: 1, columns, reason: 'r' },
              ),
            }),
          ],
        }),
      ]);
    expect(weakenedKinds(withCols(undefined), withCols(['force']))).toEqual(['tolerance-columns-narrowed']);
    expect(weakenedKinds(withCols(['force', 'position']), withCols(['force']))).toEqual(['tolerance-columns-narrowed']);
  });

  test('a deleted compare rule falls back to the other side, not to nothing', () => {
    // Deleting a rule does not delete the file; it moves it under whatever else
    // applies. Here `**` stays exact, so dropping the tolerant rule TIGHTENS.
    const base = lock([
      comp({
        producers: [
          prod({
            compare: [
              { match: '*.csv', kind: 'tolerance', abs: 1, rel: null, columns: null, maxDiffRatio: null, threshold: null },
              { match: '**', kind: 'exact', abs: null, rel: null, columns: null, maxDiffRatio: null, threshold: null },
            ],
          }),
        ],
      }),
    ]);
    const head = lock([
      comp({
        producers: [
          prod({
            compare: [{ match: '**', kind: 'exact', abs: null, rel: null, columns: null, maxDiffRatio: null, threshold: null }],
          }),
        ],
      }),
    ]);
    expect(kinds(base, head)).toEqual(['compare-tightened']);
  });

  test('a producer removed, or its out moved, is weakening', () => {
    expect(weakenedKinds(lock(), lock([comp({ producers: [] })]))).toEqual(['producer-removed']);
    expect(weakenedKinds(lock(), lock([comp({ producers: [prod({ out: 'c/vibes/snapshots/elsewhere' })] })]))).toEqual([
      'producer-out-changed',
    ]);
  });

  test('leaving the PR gate — tier demoted or ciJob removed — is weakening', () => {
    expect(weakenedKinds(lock(), lock([comp({ producers: [prod({ tier: 'nightly' })] })]))).toEqual(['tier-demoted']);
    expect(weakenedKinds(lock(), lock([comp({ producers: [prod({ ciJob: null })] })]))).toEqual(['cijob-removed']);
  });

  test('runWhen always → changed and a lowered minCases are weakening', () => {
    expect(weakenedKinds(lock(), lock([comp({ producers: [prod({ runWhen: 'changed' })] })]))).toEqual(['runwhen-lowered']);
    const base = lock([comp({ producers: [prod({ minCases: 400 })] })]);
    expect(weakenedKinds(base, lock([comp({ producers: [prod({ minCases: 10 })] })]))).toEqual(['mincases-lowered']);
    expect(weakenedKinds(base, lock([comp({ producers: [prod({ minCases: null })] })]))).toEqual(['mincases-lowered']);
  });

  test('turning off `clean` is weakening — stale output hides a deleted corpus entry', () => {
    expect(weakenedKinds(lock(), lock([comp({ producers: [prod({ clean: false })] })]))).toEqual(['clean-disabled']);
  });

  test('relaxing a failOn flag is weakening', () => {
    const head: PolicyLock = { ...lock(), failOn: { ...FAIL_ON, governanceWeakened: false } };
    expect(weakenedKinds(lock(), head)).toEqual(['failon-relaxed']);
  });

  test('dropped dependsOn / generates / submodules edges are weakening', () => {
    const base = lock([comp({ dependsOn: ['proto'], generates: ['c/gen/**'], submodules: ['c/sub'] })]);
    expect(weakenedKinds(base, lock()).sort()).toEqual([
      'dependson-removed',
      'generates-removed',
      'submodule-removed',
    ]);
  });

  test('relaxing ingest.required is weakening', () => {
    expect(weakenedKinds(lock(), lock([comp({ ingestRequired: false })]))).toEqual(['ingest-required-relaxed']);
  });

  test('an identical lock produces no deltas at all', () => {
    expect(diffPolicy(lock(), lock()).deltas).toEqual([]);
  });

  test('a missing base lock is reported as such, not as "nothing changed"', () => {
    const d = diffPolicy(null, lock());
    expect(d.baseMissing).toBe(true);
    expect(d.deltas).toEqual([]);
  });

  test('weakening rows sort first, so a reader meets them before the neutral ones', () => {
    const base = lock([comp({ producers: [prod({ name: 'a' })] })]);
    const head = lock([comp({ producers: [prod({ name: 'a', clean: false, renderer: 'json' })] })]);
    expect(kinds(base, head)).toEqual(['clean-disabled', 'renderer-changed']);
  });
});

describe('lostPaths', () => {
  test('lost = matched(base) \\ matched(head), over the tracked set', () => {
    expect(lostPaths(['a/**'], ['a/keep/**'], ['a/keep/x.ts', 'a/drop/y.ts', 'b/z.ts'])).toEqual(['a/drop/y.ts']);
  });

  test('a negation in the head globs subtracts', () => {
    expect(lostPaths(['a/**'], ['a/**', '!a/gen/**'], ['a/x.ts', 'a/gen/y.ts'])).toEqual(['a/gen/y.ts']);
  });
});

describe('compareLockToLive', () => {
  test('a component in the lock and not in the live config is missing', () => {
    const live = lock([]);
    const r = compareLockToLive(lock(), live);
    expect(r.missingComponents).toEqual(['c']);
    expect(r.stale).toBe(true);
  });

  test('a producer in the lock and not in the live config is missing', () => {
    const r = compareLockToLive(lock([comp({ producers: [prod({ name: 'p' }), prod({ name: 'q' })] })]), lock());
    expect(r.missingProducers).toEqual([{ component: 'c', producer: 'q' }]);
  });

  test('identical locks are not stale', () => {
    expect(compareLockToLive(lock(), lock()).stale).toBe(false);
  });

  test('a live-only component is `added`, and the lock is stale', () => {
    const r = compareLockToLive(lock(), lock([comp(), comp({ id: 'd', root: 'd' })]));
    expect(r.addedComponents).toEqual(['d']);
    expect(r.missingComponents).toEqual([]);
    expect(r.stale).toBe(true);
  });
});

describe('parseWeakeningAck', () => {
  test('accepts the trailer at the start of a line, case-insensitively', () => {
    expect(parseWeakeningAck('Some body\nVibes-Weakening-Ack: epsilon raised for the new load cell\n')).toBe(
      'epsilon raised for the new load cell',
    );
    expect(parseWeakeningAck('vibes-weakening-ack:  because  ')).toBe('because');
  });

  test('rejects an empty reason, a missing trailer and a null body', () => {
    expect(parseWeakeningAck('Vibes-Weakening-Ack:   ')).toBeNull();
    expect(parseWeakeningAck('nothing here')).toBeNull();
    expect(parseWeakeningAck(null)).toBeNull();
    expect(parseWeakeningAck(undefined)).toBeNull();
  });

  test('does not match mid-line prose that merely mentions the trailer', () => {
    expect(parseWeakeningAck('we should add a Vibes-Weakening-Ack: later')).toBeNull();
  });
});

/* ──────────────────── fingerprinting a resolved plan ─────────────────── */

describe('fingerprintComponent', () => {
  function plan(): ComponentPlan {
    const producerPlan: ProducerPlan = {
      resolved: {
        name: 'domain',
        cmd: 'npx vitest run vibes/producers/domain.producer.ts',
        out: 'snapshots/domain',
        ciJob: 'control-tests',
        component: 'control',
        baselineDir: '/abs/Software/Control/vibes/snapshots/domain',
        receivedDir: '/abs/.vibes/received/control/domain',
        absCwd: '/abs/Software/Control',
        compareSpec: { kind: 'exact' },
        effectiveTimeoutMs: 120_000,
        effectiveClean: true,
        effectiveRunWhen: 'always',
      },
      outRepo: 'Software/Control/vibes/snapshots/domain',
      receivedRepo: '.vibes/received/control/domain',
      hasBaseline: true,
      forcedAlways: true,
    };
    return {
      resolved: {
        entry: { id: 'control', root: 'Software/Control', dependsOn: ['protocol'] },
        manifest: null,
        producers: [producerPlan.resolved],
        absRoot: '/abs/Software/Control',
        absVibesDir: '/abs/Software/Control/vibes',
        witnesses: ['src/domain/**'],
      },
      id: 'control',
      title: 'Control',
      rootRepo: 'Software/Control',
      manifestRepo: 'Software/Control/vibes/vibes.manifest.mjs',
      status: 'active',
      statusReason: null,
      producers: [producerPlan],
      closure: ['protocol'],
      forcedAlways: true,
      forcedAlwaysReason: 'consumes generated protocol output',
      implicitWitness: 'Software/Control/vibes/**',
      witnessesAuthored: ['src/domain/**'],
      witnessMatches: [
        { glob: 'src/domain/**', repoGlob: 'Software/Control/src/domain/**', matched: [], matchedAtBase: [], negated: false },
      ],
      ingest: null,
      effective: null,
    };
  }

  test('witnesses are recorded REPO-ANCHORED, so a root move cannot compare equal', () => {
    // An author-relative glob would be byte-identical before and after a move
    // that genuinely changed what is claimed.
    expect(fingerprintComponent(plan()).witnesses).toEqual(['Software/Control/src/domain/**']);
  });

  test('the fingerprint carries no absolute paths', () => {
    const text = serializeLock(lock([fingerprintComponent(plan())]));
    expect(text).not.toContain('/abs/');
  });

  test('producer `cmd` is deliberately NOT fingerprinted — it churns benignly', () => {
    expect(serializeLock(lock([fingerprintComponent(plan())]))).not.toContain('vitest');
  });

  test('a null ingest reads as null, not as "required: false"', () => {
    expect(fingerprintComponent(plan()).ingestRequired).toBeNull();
  });
});
