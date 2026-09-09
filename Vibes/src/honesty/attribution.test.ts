import { describe, expect, test } from 'vitest';

import {
  attribute,
  compileClaims,
  coverage,
  movedSnapshots,
  underRoot,
  witnessBreadth,
} from './attribution.js';
import { changed, component, producer, snap } from './fixtures.test.js';

const verdictFor = (r: ReturnType<typeof attribute>, path: string): string | undefined =>
  r.paths.find((p) => p.path === path)?.attribution;

describe('the evidence rule', () => {
  test('a claiming producer that moved a PRE-EXISTING snapshot marks its paths exercised', () => {
    const r = attribute({
      changed: [changed('c/src/gcode.ts')],
      components: [
        component({ producers: [producer({ snapshots: [snap('g.txt', 'changed')] })] }),
      ],
    });
    expect(verdictFor(r, 'c/src/gcode.ts')).toBe('exercised');
  });

  test('an ADDED snapshot is not evidence — a corpus that grew proves only that', () => {
    // This is the hole the adversarial review found: one unrelated new corpus
    // row would otherwise mark every file under the producer as exercised.
    const r = attribute({
      changed: [changed('c/src/gcode.ts')],
      components: [component({ producers: [producer({ snapshots: [snap('new.txt', 'added')] })] })],
    });
    expect(verdictFor(r, 'c/src/gcode.ts')).toBe('unexercised');
  });

  test('a deleted snapshot IS evidence — the producer stopped emitting something', () => {
    const r = attribute({
      changed: [changed('c/src/gcode.ts')],
      components: [component({ producers: [producer({ snapshots: [snap('g.txt', 'deleted')] })] })],
    });
    expect(verdictFor(r, 'c/src/gcode.ts')).toBe('exercised');
  });

  test('a within-tolerance snapshot is evidence even though its state is verified-unchanged', () => {
    const equivalent = snap('g.txt', 'verified-unchanged', {
      verdict: { kind: 'equivalent', mode: 'tolerance' },
    });
    const r = attribute({
      changed: [changed('c/src/gcode.ts')],
      components: [component({ producers: [producer({ snapshots: [equivalent] })] })],
    });
    expect(verdictFor(r, 'c/src/gcode.ts')).toBe('exercised');
  });

  test('a byte-identical snapshot is not evidence', () => {
    const r = attribute({
      changed: [changed('c/src/gcode.ts')],
      components: [
        component({ producers: [producer({ snapshots: [snap('g.txt', 'verified-unchanged')] })] }),
      ],
    });
    expect(verdictFor(r, 'c/src/gcode.ts')).toBe('unexercised');
  });

  test('movedSnapshots ignores a producer that did not run ok', () => {
    const c = component({
      producers: [producer({ outcome: 'failed', snapshots: [snap('g.txt', 'changed')] })],
    });
    expect(movedSnapshots(c)).toEqual([]);
  });
});

describe('the ceiling, stated explicitly', () => {
  test('ten changed files under one producer all read exercised from one moved snapshot', () => {
    // Not a bug to fix later by tightening a threshold — it is what the
    // measurement can support, and the naming and the disclosure say so.
    const files = Array.from({ length: 10 }, (_, i) => `c/src/f${String(i)}.ts`);
    const r = attribute({
      changed: files.map((f) => changed(f)),
      components: [component({ producers: [producer({ snapshots: [snap('one.txt', 'changed')] })] })],
    });
    expect(r.counts.exercised).toBe(10);
  });
});

describe('covering (R-W7, R-W8)', () => {
  test('one crashed producer makes the whole component non-covering', () => {
    const c = component({
      producers: [
        producer({ name: 'a', snapshots: [snap('g.txt', 'changed')] }),
        producer({ name: 'b', outcome: 'timedOut', snapshots: [snap('h.txt', 'not-run')] }),
      ],
    });
    expect(coverage(c).covering).toBe(false);
    expect(coverage(c).reason).toMatch(/b \(timedOut\)/);
  });

  test('a disabled component is never covering', () => {
    expect(coverage(component({ status: 'disabled' })).covering).toBe(false);
  });

  test('a component with no producers is never covering', () => {
    expect(coverage(component({ producers: [] })).covering).toBe(false);
  });

  // R-W8's other half. A cross-root multi-claim is a config ERROR (V057), so
  // this shape should not reach a real run — but if it does, every claimant and
  // its status is named, which is what makes a healthy neighbour's coverage
  // visible instead of silent.
  test('every claimant and its status is named, failed ones included', () => {
    const failed = component({
      id: 'protocol',
      root: 'proto',
      witnesses: ['shared/**'],
      producers: [producer({ name: 'codec', outcome: 'failed', snapshots: [snap('x', 'not-run')] })],
    });
    const healthy = component({
      id: 'control',
      root: 'ctrl',
      witnesses: ['shared/**'],
      producers: [producer({ name: 'domain', snapshots: [snap('y', 'changed')] })],
    });
    const r = attribute({ changed: [changed('shared/codec.ts')], components: [failed, healthy] });
    const row = r.paths[0];
    // The healthy component IS a covering claimant, so the path reads
    // `exercised` — but every claimant and its status is named, which is what
    // makes the laundering visible rather than silent.
    expect(row?.attribution).toBe('exercised');
    expect(row?.claimants).toEqual([
      { component: 'protocol', covering: false, reason: expect.stringMatching(/codec \(failed\)/) as unknown as string },
      { component: 'control', covering: true, reason: 'every producer ran ok' },
    ]);
  });

  test('when EVERY claimant is non-covering the path is not-run, never unchanged', () => {
    const r = attribute({
      changed: [changed('c/src/a.ts')],
      components: [
        component({ producers: [producer({ outcome: 'failed', snapshots: [snap('x', 'not-run')] })] }),
      ],
    });
    expect(verdictFor(r, 'c/src/a.ts')).toBe('not-run');
  });
});

describe('witness matching', () => {
  test('negated globs subtract from the positives', () => {
    const claims = compileClaims(
      component({ witnesses: ['c/src/**', '!c/src/generated/**'] }),
    );
    expect(claims('c/src/a.ts')).toBe(true);
    expect(claims('c/src/generated/b.ts')).toBe(false);
  });

  test('a witness list of only negations claims nothing', () => {
    expect(compileClaims(component({ witnesses: ['!c/src/**'] }))('c/src/a.ts')).toBe(false);
  });

  test('a rename is matched on BOTH ends, so a file moving OUT of a glob is seen', () => {
    const r = attribute({
      changed: [
        changed('other/moved.ts', { oldPath: 'c/src/moved.ts', status: 'renamed', similarity: 80 }),
      ],
      components: [component({ producers: [producer({ snapshots: [snap('g', 'changed')] })] })],
    });
    expect(r.paths[0]?.claimants.map((x) => x.component)).toEqual(['c']);
    expect(r.unclaimed).toEqual([]);
  });

  test('a 100% rename is cosmetic and does not raise a behaviour question', () => {
    const r = attribute({
      changed: [changed('c/src/b.ts', { oldPath: 'c/src/a.ts', status: 'renamed', similarity: 100 })],
      components: [component()],
    });
    expect(r.paths[0]?.attribution).toBe('cosmetic');
    expect(r.paths[0]?.cosmeticReason).toMatch(/pure rename/);
  });

  test('renameIsCosmetic:false makes a 100% rename an ordinary change again', () => {
    const r = attribute({
      changed: [changed('c/src/b.ts', { oldPath: 'c/src/a.ts', status: 'renamed', similarity: 100 })],
      components: [component({ producers: [producer({ snapshots: [snap('g', 'changed')] })] })],
      renameIsCosmetic: false,
    });
    expect(r.paths[0]?.attribution).toBe('exercised');
  });

  test('a mode-only change is cosmetic', () => {
    const r = attribute({
      changed: [changed('c/src/a.ts', { status: 'mode-only' })],
      components: [component()],
    });
    expect(r.paths[0]?.attribution).toBe('cosmetic');
  });
});

describe('the other attributions', () => {
  test('a governance edit is neither unclaimed nor exercised', () => {
    // Folding it into `unclaimed` would fire on every legitimate manifest edit,
    // which is how a check gets disabled; folding it into `exercised` is a lie.
    const r = attribute({
      changed: [changed('c/vibes/vibes.manifest.mjs', { kind: 'vibes-manifest' })],
      components: [component({ witnesses: ['c/**'] })],
    });
    expect(r.paths[0]?.attribution).toBe('governance');
    expect(r.unclaimed).toEqual([]);
  });

  test('generated output is attributed to its generator, not to a human edit', () => {
    const r = attribute({
      changed: [changed('c/src/generated/codec.ts')],
      components: [
        component({ generates: ['c/src/generated/**'], producers: [producer({ snapshots: [] })] }),
      ],
    });
    expect(r.paths[0]?.attribution).toBe('derived');
    expect(r.paths[0]?.generatedBy).toBe('c');
  });

  test('a path no component claims is unclaimed and listed once', () => {
    const r = attribute({
      changed: [changed('docs/index.md'), changed('docs/other.md')],
      components: [component()],
    });
    expect(r.unclaimed).toEqual(['docs/index.md', 'docs/other.md']);
    expect(r.counts.unclaimed).toBe(2);
  });

  test('an undeclared gitlink bump is flagged and never counted as an unclaimed file', () => {
    const r = attribute({
      changed: [changed('SIL/embsim', { kind: 'gitlink', submodule: { base: 'a'.repeat(40), head: 'b'.repeat(40) } })],
      components: [component()],
    });
    expect(r.undeclaredGitlinks).toEqual(['SIL/embsim']);
    expect(r.unclaimed).toEqual([]);
  });

  test('a declared gitlink is not flagged', () => {
    const r = attribute({
      changed: [changed('SIL/embsim', { kind: 'gitlink' })],
      components: [component({ submodules: ['SIL/embsim'] })],
    });
    expect(r.undeclaredGitlinks).toEqual([]);
  });

  test('suppression replaces the verdict but keeps the natural one readable', () => {
    const ref = { glob: 'c/src/**', reason: 'r', until: '2030-01-01', source: 'vibes.ignore', line: 1 };
    const r = attribute({
      changed: [changed('c/src/a.ts')],
      components: [component({ producers: [producer({ snapshots: [snap('g', 'verified-unchanged')] })] })],
      suppressionFor: () => ref,
    });
    expect(r.paths[0]?.attribution).toBe('suppressed');
    expect(r.paths[0]?.natural).toBe('unexercised');
    expect(r.paths[0]?.suppressedBy).toEqual(ref);
  });

  test('suppression cannot quiet a verdict that is not a complaint', () => {
    const ref = { glob: '**/*', reason: 'r', until: '2030-01-01', source: 'vibes.ignore', line: 1 };
    const r = attribute({
      changed: [changed('c/src/a.ts')],
      components: [component({ producers: [producer({ snapshots: [snap('g', 'changed')] })] })],
      suppressionFor: () => ref,
    });
    expect(r.paths[0]?.attribution).toBe('exercised');
  });
});

describe('per-component roll-up fields', () => {
  test('claimedPaths and unclaimedPaths are scoped as the contract describes', () => {
    const r = attribute({
      changed: [changed('c/src/a.ts'), changed('c/README.md'), changed('elsewhere/x.ts')],
      components: [component({ witnesses: ['c/src/**'], producers: [producer({ snapshots: [snap('g', 'changed')] })] })],
    });
    const c = r.components[0];
    expect(c?.claimedPaths).toEqual(['c/src/a.ts']);
    // Under the root, not claimed by its witnesses.
    expect(c?.unclaimedPaths).toEqual(['c/README.md']);
    expect(c?.verdict).toBe('exercised');
  });

  test('a component with no changed claimed paths has a null verdict, not a green one', () => {
    const r = attribute({
      changed: [changed('docs/x.md')],
      components: [component({ producers: [producer({ snapshots: [snap('g', 'verified-unchanged')] })] })],
    });
    expect(r.components[0]?.verdict).toBeNull();
  });
});

describe('advisory checks', () => {
  test('witnessBreadth reports the fraction of the tracked repo a component claims', () => {
    const b = witnessBreadth([component({ witnesses: ['**'] })], ['a.ts', 'b.ts', 'c.ts']);
    expect(b[0]?.fraction).toBe(1);
  });

  test('underRoot treats an empty root as the whole repo and requires a segment boundary', () => {
    expect(underRoot('a/b', '')).toBe(true);
    expect(underRoot('ab/c', 'a')).toBe(false);
    expect(underRoot('a/c', 'a')).toBe(true);
    expect(underRoot('a', 'a')).toBe(true);
  });
});
