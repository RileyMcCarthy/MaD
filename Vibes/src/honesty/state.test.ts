import { describe, expect, test } from 'vitest';

import { component, producer, snap } from './fixtures.test.js';
import {
  componentTally,
  countSnapStates,
  producerState,
  runCoverage,
  stateOfOutcome,
  unrunSnapshotViolations,
  verificationCoverage,
} from './state.js';

describe('producerState', () => {
  test('ran ok with nothing moved is verified-unchanged', () => {
    const p = producerState('c', producer({ snapshots: [snap('a', 'verified-unchanged')] }));
    expect(p.state).toBe('verified-unchanged');
    expect(p.reason).toMatch(/compared byte-for-byte/);
  });

  test('ran ok with any file added, changed or deleted is changed', () => {
    for (const s of ['changed', 'added', 'deleted'] as const) {
      expect(producerState('c', producer({ snapshots: [snap('a', s)] })).state).toBe('changed');
    }
  });

  test('a failed producer is `unknown` and never `verified-unchanged`', () => {
    const p = producerState('c', producer({ outcome: 'failed', snapshots: [snap('a', 'not-run')] }));
    expect(p.state).toBe('unknown');
    expect(p.unknownReason).toBe('failed');
    expect(p.reason).toBe('producer exited non-zero');
  });

  test('`not-run` always carries a reason (V3)', () => {
    const p = producerState('c', { ...producer({ outcome: 'not-selected' }), notRunReason: 'component-disabled' });
    expect(p.state).toBe('not-run');
    expect(p.notRunReason).toBe('component-disabled');
    expect(p.reason).toBe('component disabled in the registry');
  });

  test('an unnarrowed not-run still carries a reason, and it reads worse than the truth', () => {
    // Deliberately self-correcting: the generic wording is visibly less useful
    // than the narrow one, so a runner that forgets to narrow it sees that.
    const p = producerState('c', producer({ outcome: 'not-selected' }));
    expect(p.notRunReason).toBe('not-selected');
    expect(p.reason).toMatch(/reason not narrowed/);
  });

  test('blocked never started, so it is not-run; cancelled may have died mid-write, so it is unknown', () => {
    expect(stateOfOutcome('blocked')).toBe('not-run');
    expect(stateOfOutcome('cancelled')).toBe('unknown');
    expect(producerState('c', producer({ outcome: 'blocked' })).notRunReason).toBe('blocked');
    expect(producerState('c', producer({ outcome: 'cancelled' })).unknownReason).toBe('cancelled');
  });

  test('a post-exit discovery beats a green exit code', () => {
    // Exit 0 but the output landed somewhere gitignored: the exit code is
    // exactly what hides that, so the discovery wins.
    const p = producerState('c', {
      ...producer({ snapshots: [snap('a', 'verified-unchanged')] }),
      unknownReason: 'output-ignored',
    });
    expect(p.state).toBe('unknown');
    expect(p.reason).toMatch(/gitignored/);
  });

  test('bootstrap is derived from having no committed baseline', () => {
    expect(producerState('c', producer({ hasBaseline: false })).bootstrap).toBe(true);
  });

  test('countSnapStates covers all six states', () => {
    const counts = countSnapStates([
      snap('a', 'verified-unchanged'),
      snap('b', 'changed'),
      snap('c', 'added'),
      snap('d', 'deleted'),
      snap('e', 'not-selected'),
      snap('f', 'not-run'),
    ]);
    expect(counts).toEqual({
      'verified-unchanged': 1,
      changed: 1,
      added: 1,
      deleted: 1,
      'not-selected': 1,
      'not-run': 1,
    });
  });
});

describe('the V2 assertion', () => {
  test('a producer that did not run ok whose files are stamped not-run is clean', () => {
    const c = component({ producers: [producer({ outcome: 'failed', snapshots: [snap('a', 'not-run')] })] });
    expect(unrunSnapshotViolations([c])).toEqual([]);
  });

  test('a `verified-unchanged` file under a producer that never ran is caught', () => {
    // The only way to produce this is to have compared the committed baseline
    // to itself, which is the exact lie the tool exists to prevent.
    const c = component({ producers: [producer({ outcome: 'timedOut', snapshots: [snap('a', 'verified-unchanged')] })] });
    expect(unrunSnapshotViolations([c])).toEqual([
      { component: 'c', producer: 'p', file: 'a', state: 'verified-unchanged' },
    ]);
  });
});

describe('componentTally', () => {
  test('no producers reads not-configured, never green', () => {
    const t = componentTally(component({ producers: [] }));
    expect(t.state).toBe('not-configured');
  });

  test('a disabled component is not-run whatever its producers say', () => {
    const t = componentTally(
      component({ status: 'disabled', producers: [producer({ snapshots: [snap('a', 'verified-unchanged')] })] }),
    );
    expect(t.state).toBe('not-run');
    expect(t.reason).toBe('component is disabled');
  });

  test('all producers ok and nothing moved is verified-unchanged', () => {
    const t = componentTally(
      component({
        producers: [
          producer({ name: 'a', snapshots: [snap('x', 'verified-unchanged')] }),
          producer({ name: 'b', snapshots: [snap('y', 'verified-unchanged')] }),
        ],
      }),
    );
    expect(t.state).toBe('verified-unchanged');
    expect(t.counts['verified-unchanged']).toBe(2);
  });

  test('one changed producer makes the component changed', () => {
    const t = componentTally(
      component({
        producers: [
          producer({ name: 'a', snapshots: [snap('x', 'verified-unchanged')] }),
          producer({ name: 'b', snapshots: [snap('y', 'changed')] }),
        ],
      }),
    );
    expect(t.state).toBe('changed');
  });

  test('one failed producer beside a healthy one is PARTIAL — never unchanged', () => {
    const t = componentTally(
      component({
        producers: [
          producer({ name: 'a', snapshots: [snap('x', 'verified-unchanged')] }),
          producer({ name: 'b', outcome: 'failed', snapshots: [snap('y', 'not-run')] }),
        ],
      }),
    );
    expect(t.state).toBe('partial');
    expect(t.reason).toMatch(/1 of 2 producers evaluated/);
  });

  test('every producer missing is not-run, not partial', () => {
    const t = componentTally(
      component({ producers: [producer({ outcome: 'failed', snapshots: [snap('y', 'not-run')] })] }),
    );
    expect(t.state).toBe('not-run');
  });

  test('every producer bootstrapping is bootstrap', () => {
    const t = componentTally(
      component({ producers: [producer({ hasBaseline: false, snapshots: [snap('x', 'added')] })] }),
    );
    expect(t.state).toBe('bootstrap');
  });

  test('a bootstrap beside a broken producer is partial — the broken half is the story', () => {
    const t = componentTally(
      component({
        producers: [
          producer({ name: 'a', hasBaseline: false, snapshots: [snap('x', 'added')] }),
          producer({ name: 'b', hasBaseline: false, outcome: 'spawnError', snapshots: [snap('y', 'not-run')] }),
        ],
      }),
    );
    expect(t.state).toBe('partial');
  });

  test('snapshot counts sum across producers', () => {
    const t = componentTally(
      component({
        producers: [
          producer({ name: 'a', snapshots: [snap('x', 'changed'), snap('z', 'verified-unchanged')] }),
          producer({ name: 'b', snapshots: [snap('y', 'changed')] }),
        ],
      }),
    );
    expect(t.snapshots.changed).toBe(2);
    expect(t.snapshots['verified-unchanged']).toBe(1);
  });
});

describe('verificationCoverage', () => {
  const roster = [
    { component: 'c', producer: 'p' },
    { component: 'c', producer: 'q' },
  ];

  test('every rostered producer ok is fullyVerified', () => {
    const c = component({ producers: [producer({ name: 'p' }), producer({ name: 'q' })] });
    const v = verificationCoverage(roster, [c]);
    expect(v.fullyVerified).toBe(true);
    expect(v.evaluated).toBe(2);
  });

  test('a producer that VANISHED from discovery cannot make the run look complete', () => {
    // The whole reason the roster comes from the committed lock: with a live
    // roster, deleting a component makes the run MORE complete.
    const c = component({ producers: [producer({ name: 'p' })] });
    const v = verificationCoverage(roster, [c]);
    expect(v.fullyVerified).toBe(false);
    expect(v.missing).toEqual([
      { component: 'c', producer: 'q', outcome: null, detail: expect.stringMatching(/absent from this run/) as unknown as string },
    ]);
  });

  test('a rostered producer that ran and failed is notOk, with its outcome named', () => {
    const c = component({ producers: [producer({ name: 'p' }), producer({ name: 'q', outcome: 'timedOut' })] });
    const v = verificationCoverage(roster, [c]);
    expect(v.fullyVerified).toBe(false);
    expect(v.notOk[0]?.outcome).toBe('timedOut');
  });

  test('a producer that ran but is not in the lock is `extra` — the lock is stale', () => {
    const c = component({ producers: [producer({ name: 'p' }), producer({ name: 'q' }), producer({ name: 'r' })] });
    expect(verificationCoverage(roster, [c]).extra).toEqual([{ component: 'c', producer: 'r' }]);
  });

  test('no committed lock means completeness is UNASSERTABLE, not assumed', () => {
    const c = component({ producers: [producer({ name: 'p' })] });
    const v = verificationCoverage([], [c]);
    expect(v.fullyVerified).toBe(false);
    expect(v.rosterSource).toBe('none');
    expect(v.reason).toMatch(/no committed .vibes\/policy.lock.json/);
  });
});

describe('runCoverage', () => {
  test('the headline is a fraction and forbids "all unchanged" while anything is missing', () => {
    const c = component({
      producers: [producer({ name: 'p' }), producer({ name: 'q', outcome: 'failed', snapshots: [snap('y', 'not-run')] })],
    });
    const cov = verificationCoverage([{ component: 'c', producer: 'p' }, { component: 'c', producer: 'q' }], [c]);
    const line = runCoverage([componentTally(c)], cov);
    expect(line.mayClaimAllUnchanged).toBe(false);
    expect(line.text).toMatch(/1 of 2 producers evaluated; 0 changed; 0 not run; 1 unknown/);
  });

  test('a fully verified, unchanged, unsuppressed run may claim it', () => {
    const c = component({ producers: [producer({ name: 'p', snapshots: [snap('x', 'verified-unchanged')] })] });
    const cov = verificationCoverage([{ component: 'c', producer: 'p' }], [c]);
    expect(runCoverage([componentTally(c)], cov).mayClaimAllUnchanged).toBe(true);
  });

  test('a suppressed component blocks the claim even when everything else is green', () => {
    const ok = component({ id: 'a', producers: [producer({ name: 'p', snapshots: [snap('x', 'verified-unchanged')] })] });
    const off = component({ id: 'b', status: 'disabled', producers: [] });
    const cov = verificationCoverage([{ component: 'a', producer: 'p' }], [ok, off]);
    expect(runCoverage([componentTally(ok), componentTally(off)], cov).mayClaimAllUnchanged).toBe(false);
  });
});
