import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_ACCEPT_OPTIONS } from './model.js';
import { buildPlan, planTarget, selectTargets } from './plan.js';
import { makeFixture, snap, target, type AcceptFixture } from './fixtures.test.js';

const live: AcceptFixture[] = [];
async function fixture(): Promise<AcceptFixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

describe('planTarget — what accept writes (§5.5)', () => {
  test('identical and equivalent are SKIPPED and counted, never candidates', async () => {
    // The rule that stops a nondeterministic tolerance producer committing a
    // fresh sample of noise on every accept.
    const f = await fixture();
    const p = planTarget(
      target(f, {
        files: [
          snap({ file: 'a.csv', verdict: 'identical' }),
          snap({ file: 'b.csv', verdict: 'equivalent' }),
          snap({ file: 'c.csv', verdict: 'different' }),
        ],
      }),
    );
    expect(p.candidates.map((c) => c.file)).toEqual(['c.csv']);
    expect(p.skippedEquivalent).toEqual(['a.csv', 'b.csv']);
  });

  test('different, structural and added become write candidates', async () => {
    const f = await fixture();
    const p = planTarget(
      target(f, {
        files: [
          snap({ file: 'd.txt', verdict: 'different' }),
          snap({ file: 's.txt', verdict: 'structural' }),
          snap({ file: 'n.txt', verdict: 'added' }),
        ],
      }),
    );
    expect(p.candidates.every((c) => c.action === 'write')).toBe(true);
    expect(p.candidates.map((c) => c.file)).toEqual(['d.txt', 'n.txt', 's.txt']);
  });

  test('deleted becomes a delete candidate with no received source', async () => {
    const f = await fixture();
    const p = planTarget(
      target(f, { files: [snap({ file: 'gone.txt', verdict: 'deleted' })] }),
    );
    expect(p.candidates[0]?.action).toBe('delete');
    expect(p.candidates[0]?.absReceived).toBeNull();
    expect(p.candidates[0]?.repoPath).toBe(`${f.outRepo}/gone.txt`);
  });

  test('not-selected is NEVER a deletion — the smoke-subset trap', async () => {
    // MaD's smoke subset emits 18 of 32 cases by design. Treating the other 14
    // as deletions would delete two thirds of the corpus on the first --all.
    const f = await fixture();
    const p = planTarget(
      target(f, {
        files: [
          snap({ file: 'case-19.gcode', state: 'not-selected', verdict: 'not-selected' }),
          snap({ file: 'case-20.gcode', state: 'not-selected', verdict: 'not-selected' }),
        ],
      }),
    );
    expect(p.candidates).toEqual([]);
    expect(p.untouched).toEqual(['case-19.gcode', 'case-20.gcode']);
  });

  test('not-run is untouched even when the verdict claims otherwise', async () => {
    const f = await fixture();
    const p = planTarget(
      target(f, { files: [snap({ file: 'x.txt', state: 'not-run', verdict: 'different' })] }),
    );
    expect(p.candidates).toEqual([]);
    expect(p.untouched).toEqual(['x.txt']);
  });

  test('a receipt in the snapshot roster is reserved, never deleted', async () => {
    // A mis-categorising runner that lists .vibes-accept.json as a snapshot
    // would otherwise have accept delete this producer's own audit trail.
    const f = await fixture();
    const p = planTarget(
      target(f, {
        files: [
          snap({ file: '.vibes-accept.json', verdict: 'deleted' }),
          snap({ file: '.vibes-accept.r0123abcd.json', verdict: 'deleted' }),
          snap({ file: '.gitattributes', verdict: 'deleted' }),
          snap({ file: 'real.txt', verdict: 'different' }),
        ],
      }),
    );
    expect(p.reserved).toEqual([
      '.gitattributes',
      '.vibes-accept.json',
      '.vibes-accept.r0123abcd.json',
    ]);
    expect(p.candidates.map((c) => c.file)).toEqual(['real.txt']);
  });

  test('a reserved NAME below the top level is an ordinary snapshot', async () => {
    const f = await fixture();
    const p = planTarget(
      target(f, { files: [snap({ file: 'cases/.gitattributes', verdict: 'different' })] }),
    );
    expect(p.reserved).toEqual([]);
    expect(p.candidates.map((c) => c.file)).toEqual(['cases/.gitattributes']);
  });

  test('a path escaping the out dir is quarantined, not written', async () => {
    const f = await fixture();
    const p = planTarget(
      target(f, {
        files: [
          snap({ file: '../../../etc/passwd', verdict: 'different' }),
          snap({ file: '/abs.txt', verdict: 'different' }),
          snap({ file: 'win\\path.txt', verdict: 'different' }),
        ],
      }),
    );
    expect(p.candidates).toEqual([]);
    expect(p.unsafe).toHaveLength(3);
  });

  test('candidates are ordered bytewise, so two runs offer the same sequence', async () => {
    const f = await fixture();
    const p = planTarget(
      target(f, {
        files: [
          snap({ file: 'b.txt' }),
          snap({ file: 'A.txt' }),
          snap({ file: 'a/b.txt' }),
        ],
      }),
    );
    expect(p.candidates.map((c) => c.file)).toEqual(['A.txt', 'a/b.txt', 'b.txt']);
  });
});

describe('selectTargets', () => {
  test('the default keeps FAILED producers so refusal 2 can fire', async () => {
    const f = await fixture();
    const ok = target(f, { producer: 'domain' });
    const bad = target(f, { producer: 'trace', outcome: 'failed' });
    const r = selectTargets([ok, bad], DEFAULT_ACCEPT_OPTIONS);
    expect(r.selected.map((t) => t.producer)).toEqual(['domain', 'trace']);
    expect(r.explicit).toBe(false);
  });

  test('the default drops not-selected producers, which are absent by design', async () => {
    const f = await fixture();
    const skipped = target(f, { producer: 'nightly', outcome: 'not-selected' });
    const r = selectTargets([target(f), skipped], DEFAULT_ACCEPT_OPTIONS);
    expect(r.selected.map((t) => t.producer)).toEqual(['domain']);
  });

  test('a selector that matches nothing is reported, not silently empty', async () => {
    const f = await fixture();
    const r = selectTargets([target(f)], {
      ...DEFAULT_ACCEPT_OPTIONS,
      producers: ['control/domian'],
    });
    expect(r.selected).toEqual([]);
    expect(r.unmatched).toEqual(['control/domian']);
  });

  test('a bare producer name and a component/producer id both match', async () => {
    const f = await fixture();
    const t = target(f);
    expect(selectTargets([t], { ...DEFAULT_ACCEPT_OPTIONS, producers: ['domain'] }).selected)
      .toHaveLength(1);
    expect(
      selectTargets([t], { ...DEFAULT_ACCEPT_OPTIONS, producers: ['control/domain'] }).selected,
    ).toHaveLength(1);
  });

  test('--component selects every producer under it', async () => {
    const f = await fixture();
    const a = target(f, { producer: 'domain' });
    const b = target(f, { producer: 'trace' });
    const c = target(f, { component: 'sil', producer: 'gantry' });
    const r = selectTargets([a, b, c], { ...DEFAULT_ACCEPT_OPTIONS, components: ['control'] });
    expect(r.selected.map((t) => t.producer)).toEqual(['domain', 'trace']);
  });
});

describe('buildPlan', () => {
  test('rolls writes, deletions and the skip count up across targets', async () => {
    const f = await fixture();
    const plan = buildPlan([
      target(f, {
        producer: 'domain',
        files: [snap({ file: 'a' }), snap({ file: 'b', verdict: 'identical' })],
      }),
      target(f, {
        producer: 'trace',
        files: [snap({ file: 'c', verdict: 'deleted' })],
      }),
    ]);
    expect(plan.writes.map((c) => c.file)).toEqual(['a']);
    expect(plan.deletions.map((c) => c.file)).toEqual(['c']);
    expect(plan.skippedEquivalent).toBe(1);
    expect(plan.candidates).toHaveLength(2);
  });
});
