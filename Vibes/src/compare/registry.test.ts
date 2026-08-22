import { describe, expect, it } from 'vitest';
import type { CompareMode, CompareSpec } from '../types.js';
import {
  compareSnapshotFile,
  isChange,
  isNonChange,
  isUnevaluated,
  resolveCompareMode,
} from './registry.js';
import { collectPixelErrors, PIXEL_UNSUPPORTED_CODE, PixelComparisonUnsupportedError } from './pixel.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

const TOLERANCE: CompareMode = {
  kind: 'tolerance',
  abs: 0.5,
  reason: 'f64 physics integration differs in the last place across targets',
};

describe('resolveCompareMode', () => {
  it('applies a bare mode to every file', () => {
    const r = resolveCompareMode({ kind: 'exact' }, 'anything/at/all.txt');
    expect(r.mode.kind).toBe('exact');
    expect(r.ruleIndex).toBeNull();
    expect(r.fellBack).toBe(false);
  });

  it('is first-match-wins across a rule array', () => {
    const spec: CompareSpec = [
      { match: '**/*.csv', use: TOLERANCE },
      { match: '**/*', use: { kind: 'exact' } },
    ];
    expect(resolveCompareMode(spec, 'trace/run.csv').ruleIndex).toBe(0);
    expect(resolveCompareMode(spec, 'trace/run.csv').mode.kind).toBe('tolerance');
    expect(resolveCompareMode(spec, 'trace/log.txt').ruleIndex).toBe(1);
  });

  it('falls back to exact — the STRICT direction — when nothing matches', () => {
    // A rule list that forgets its catch-all must not loosen anything by
    // omission.
    const spec: CompareSpec = [{ match: '**/*.csv', use: TOLERANCE }];
    const r = resolveCompareMode(spec, 'trace/notes.txt');
    expect(r.mode.kind).toBe('exact');
    expect(r.fellBack).toBe(true);
  });

  it('matches dotfiles, which snapshot dirs really contain', () => {
    const spec: CompareSpec = [{ match: '**/.vibes-*', use: { kind: 'exact' } }];
    expect(resolveCompareMode(spec, '.vibes-selected').ruleIndex).toBe(0);
  });
});

describe('compareSnapshotFile — existence', () => {
  it('a missing baseline is added, never a comparison', () => {
    const r = compareSnapshotFile({ file: 'new.txt', baseline: null, received: buf('hi') });
    expect(r.verdict.kind).toBe('added');
    expect(r.verdict.summary).toContain('2 bytes');
  });

  it('a missing received file is deleted', () => {
    const r = compareSnapshotFile({ file: 'gone.txt', baseline: buf('hi'), received: null });
    expect(r.verdict.kind).toBe('deleted');
  });

  it('refuses to invent a verdict when both sides are absent', () => {
    expect(() =>
      compareSnapshotFile({ file: 'x', baseline: null, received: null }),
    ).toThrow(/existence must be decided by the caller/);
  });
});

describe('compareSnapshotFile — dispatch', () => {
  it('routes a csv to tolerance and everything else to exact', () => {
    const spec: CompareSpec = [
      { match: '**/*.csv', use: TOLERANCE },
      { match: '**/*', use: { kind: 'exact' } },
    ];
    const csv = compareSnapshotFile({
      file: 'physics/run.csv',
      baseline: buf('t,f\n0,1.0\n'),
      received: buf('t,f\n0,1.2\n'),
      spec,
    });
    expect(csv.mode).toBe('tolerance');
    expect(csv.verdict.kind).toBe('equivalent');
    expect(csv.tolerance?.rows).toBe(1);

    const txt = compareSnapshotFile({
      file: 'physics/notes.txt',
      baseline: buf('a\n'),
      received: buf('b\n'),
      spec,
    });
    expect(txt.mode).toBe('exact');
    expect(txt.verdict.kind).toBe('different');
    expect(txt.patch).not.toBeNull();
  });

  it('short-circuits identical bytes in tolerance mode without parsing', () => {
    const text = buf('t,f\nnot,a,parseable,row\n');
    const r = compareSnapshotFile({
      file: 'run.csv',
      baseline: text,
      received: text,
      spec: TOLERANCE,
    });
    // The file would fail the series scan, but identical bytes are identical.
    expect(r.verdict.kind).toBe('identical');
  });

  it('reports an undecodable tolerance input as structural, never a pass', () => {
    const r = compareSnapshotFile({
      file: 'run.csv',
      baseline: buf('t,f\n0,1\n'),
      received: Buffer.from([0xff, 0xfe, 0x00]),
      spec: TOLERANCE,
    });
    expect(r.verdict.kind).toBe('structural');
    expect(r.notes.join(' ')).toContain('UTF-8');
  });

  it('defaults to exact when no spec is declared', () => {
    const r = compareSnapshotFile({ file: 'x.txt', baseline: buf('a'), received: buf('a') });
    expect(r.mode).toBe('exact');
    expect(r.verdict.kind).toBe('identical');
  });
});

describe('pixel mode is a named config error, never a silent pass', () => {
  const pixel: CompareMode = { kind: 'pixel', reason: 'screenshots' };

  it('throws with the code and the reason rather than comparing', () => {
    expect(() =>
      compareSnapshotFile({
        file: 'shot.png',
        baseline: buf('a'),
        received: buf('b'),
        spec: pixel,
        where: 'docs/screens: **/*.png',
      }),
    ).toThrow(PixelComparisonUnsupportedError);

    try {
      compareSnapshotFile({ file: 'shot.png', baseline: buf('a'), received: buf('a'), spec: pixel });
    } catch (err) {
      const e = err as PixelComparisonUnsupportedError;
      expect(e.code).toBe(PIXEL_UNSUPPORTED_CODE);
      expect(e.message).toContain('not available in v1');
      expect(e.fix).toContain('Remove the `pixel` compare mode');
    }
  });

  it('throws even when the bytes are identical — no accidental green', () => {
    expect(() =>
      compareSnapshotFile({ file: 'shot.png', baseline: buf('a'), received: buf('a'), spec: pixel }),
    ).toThrow(PixelComparisonUnsupportedError);
  });

  it('collects every declaration site for a single diagnostic pass', () => {
    const errors = collectPixelErrors([
      { mode: pixel, where: 'docs/screens: **/*.png' },
      { mode: { kind: 'exact' }, where: 'docs/screens: **/*.txt' },
      { mode: pixel, where: 'ui/shots: **/*.png' },
    ]);
    expect(errors.map((e) => e.where)).toEqual(['docs/screens: **/*.png', 'ui/shots: **/*.png']);
    expect(errors[0]?.code).toBe(PIXEL_UNSUPPORTED_CODE);
  });
});

describe('verdict classification', () => {
  it('keeps identical and equivalent distinct while both are non-changes', () => {
    expect(isNonChange('identical')).toBe(true);
    expect(isNonChange('equivalent')).toBe(true);
    expect(isChange('identical')).toBe(false);
    expect(isChange('equivalent')).toBe(false);
  });

  it('keeps different and structural distinct while both are changes', () => {
    expect(isChange('different')).toBe(true);
    expect(isChange('structural')).toBe(true);
    expect(isNonChange('different')).toBe(false);
    expect(isNonChange('structural')).toBe(false);
  });

  it('never lets not-run or not-selected read as either', () => {
    for (const kind of ['not-run', 'not-selected'] as const) {
      expect(isChange(kind)).toBe(false);
      expect(isNonChange(kind)).toBe(false);
      expect(isUnevaluated(kind)).toBe(true);
    }
  });

  it('counts added and deleted as changes', () => {
    expect(isChange('added')).toBe(true);
    expect(isChange('deleted')).toBe(true);
  });
});
