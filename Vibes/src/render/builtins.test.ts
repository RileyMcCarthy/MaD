import { describe, expect, it } from 'vitest';
import type { CompareMode, Verdict } from '../types.js';
import type { RenderBlock } from './blocks.js';
import { BUILTIN_RENDERERS, sniffRenderer } from './builtins/index.js';
import { canonicalJson } from './builtins/json.js';
import { columnStat, parseDelimited } from './builtins/series.js';
import { firstDifferingOffset, hexDump } from './builtins/binary.js';
import { renderTextDiff } from './builtins/text.js';
import { DEFAULT_RENDER_LIMITS } from './index.js';
import type { RenderContext, RenderInput, SnapshotFileRef } from './registry.js';

function ctx(): RenderContext & { notes: string[] } {
  const notes: string[] = [];
  return { limits: DEFAULT_RENDER_LIMITS, log: (n) => notes.push(n), notes };
}

function input(
  baseline: string | null,
  received: string | null,
  mode: CompareMode['kind'] = 'exact',
): RenderInput {
  const verdict: Verdict = { kind: 'different', mode };
  const ref: SnapshotFileRef = {
    component: 'control',
    producer: 'domain',
    file: 'a.txt',
    repoPath: 'x/a.txt',
    state: 'changed',
    verdict,
    bytes: 0,
  };
  return {
    ref,
    baseline: baseline === null ? null : Buffer.from(baseline),
    received: received === null ? null : Buffer.from(received),
  };
}

function kinds(blocks: readonly RenderBlock[]): string[] {
  return blocks.map((b) => b.kind);
}

describe('text builtin (the default)', () => {
  it('renders a diff block for a changed file', () => {
    const blocks = renderTextDiff(input('a\nb\n', 'a\nB\n'), ctx());
    expect(kinds(blocks)).toContain('diff');
  });

  it('renders an added file as a whole-file diff, not as silence', () => {
    const blocks = renderTextDiff(input(null, 'new\ncontent\n'), ctx());
    const diff = blocks.find((b) => b.kind === 'diff');
    expect(diff).toBeDefined();
    if (diff?.kind === 'diff') {
      expect(diff.patch.hunks[0]?.lines.every((l) => l.startsWith('+'))).toBe(true);
    }
  });

  it('renders a deleted file too', () => {
    const blocks = renderTextDiff(input('gone\n', null), ctx());
    const diff = blocks.find((b) => b.kind === 'diff');
    if (diff?.kind === 'diff') {
      expect(diff.patch.hunks[0]?.lines.some((l) => l.startsWith('-'))).toBe(true);
    }
  });

  it('shows a missing trailing newline rather than hiding it', () => {
    // jsdiff emits the "\\ No newline at end of file" marker, and the emitters
    // keep it: an EOL-only change is a real change to a committed baseline.
    const blocks = renderTextDiff(input('a\n', 'a'), ctx());
    const diff = blocks.find((b) => b.kind === 'diff');
    expect(diff?.kind === 'diff' && diff.patch.hunks[0]?.lines.some((l) => l.startsWith('\\'))).toBe(
      true,
    );
  });

  it('says so when the two sides are line-identical, instead of showing an empty diff', () => {
    const blocks = renderTextDiff(input('a\nb\n', 'a\nb\n'), ctx());
    expect(kinds(blocks)).toContain('note');
    const note = blocks.find((b) => b.kind === 'note');
    if (note?.kind === 'note') expect(note.text).toMatch(/line-level/i);
  });

  it('flags non-UTF-8 content rather than pretending it decoded', () => {
    const bad = Buffer.from([0x61, 0xff, 0x0a]);
    const blocks = renderTextDiff(
      { ...input('a\n', 'a\n'), received: bad },
      ctx(),
    );
    const note = blocks.find((b) => b.kind === 'note');
    expect(note?.kind === 'note' && note.text).toMatch(/not valid UTF-8/);
  });
});

describe('json builtin', () => {
  it('sorts object keys so key order alone never shows as a change', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('never sorts arrays: order is a real property a producer can lose', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('keeps NaN and Infinity distinguishable from null', () => {
    const text = canonicalJson({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: null });
    expect(text).toContain('"NaN"');
    expect(text).toContain('"Infinity"');
    expect(text).toContain('null');
  });

  it('reports "no differences" for a key-order-only change', () => {
    const mod = BUILTIN_RENDERERS['json'];
    const blocks = mod?.render(input('{"b":1,"a":2}', '{"a":2,"b":1}'), ctx()) as RenderBlock[];
    expect(kinds(blocks)).not.toContain('diff');
  });

  it('vetoes when a side does not parse, instead of rendering garbage', () => {
    const mod = BUILTIN_RENDERERS['json'];
    expect(mod?.canRender?.(input('{"a":1}', 'not json'))).toBe(false);
  });
});

describe('series builtin', () => {
  const csvA = 'phase,pos_um,force_mN\n0,0,0\n1,100,10\n2,200,20\n';
  const csvB = 'phase,pos_um,force_mN\n0,0,0\n1,105,10\n2,201,25\n';

  it('parses a delimited table and skips comment preamble', () => {
    const table = parseDelimited(`# vibes-volatile: time\n${csvA}`);
    expect(table?.columns).toEqual(['phase', 'pos_um', 'force_mN']);
    expect(table?.rows).toBe(3);
  });

  it('computes worst-delta stats a reviewer can act on', () => {
    const stat = columnStat('pos_um', [0, 100, 200], [0, 105, 201]);
    expect(stat.maxAbsDelta).toBe(5);
    expect(stat.maxAbsDeltaRow).toBe(1);
    expect(stat.changedRows).toBe(2);
  });

  it('renders a stats table plus one series per changed column', () => {
    const mod = BUILTIN_RENDERERS['series'];
    const blocks = mod?.render(input(csvA, csvB, 'tolerance'), ctx()) as RenderBlock[];
    expect(kinds(blocks)).toContain('table');
    expect(kinds(blocks).filter((k) => k === 'series').length).toBe(2);
  });

  it('calls a column-set change structural rather than showing it as drift', () => {
    const mod = BUILTIN_RENDERERS['series'];
    const blocks = mod?.render(
      input(csvA, 'phase,pos_um\n0,0\n1,100\n2,200\n', 'tolerance'),
      ctx(),
    ) as RenderBlock[];
    const note = blocks.find((b) => b.kind === 'note');
    expect(note?.kind === 'note' && note.level).toBe('error');
  });
});

describe('binary builtin', () => {
  it('locates the first differing byte', () => {
    expect(firstDifferingOffset(Buffer.from([1, 2, 3]), Buffer.from([1, 9, 3]))).toBe(1);
    expect(firstDifferingOffset(Buffer.from([1, 2]), Buffer.from([1, 2]))).toBe(-1);
    expect(firstDifferingOffset(Buffer.from([1, 2]), Buffer.from([1, 2, 3]))).toBe(2);
  });

  it('dumps small files only', () => {
    const dump = hexDump(Buffer.from('AB'));
    expect(dump).toContain('41 42');
    expect(dump).toContain('AB');
  });

  it('refuses to invent a view of the content', () => {
    const mod = BUILTIN_RENDERERS['binary'];
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    const blocks = mod?.render({ ...input(null, null), baseline: buf, received: buf }, ctx()) as RenderBlock[];
    const note = blocks.find((b) => b.kind === 'note');
    expect(note?.kind === 'note' && note.text).toMatch(/not rendered/);
  });
});

describe('sniffRenderer', () => {
  it('picks binary on a NUL byte, before anything else', () => {
    const withNul = { ...input('{"a":1}', null), received: Buffer.from([0x7b, 0x00]) };
    expect(sniffRenderer(withNul)).toBe('binary');
  });

  it('picks series from the COMPARATOR mode, not the file extension', () => {
    expect(sniffRenderer(input('a,b\n1,2\n', 'a,b\n1,3\n', 'tolerance'))).toBe('series');
    // Same content compared exactly wants a line diff: the reviewer needs the row.
    expect(sniffRenderer(input('a,b\n1,2\n', 'a,b\n1,3\n', 'exact'))).toBeNull();
  });

  it('picks json when both sides parse', () => {
    expect(sniffRenderer(input('{"a":1}', '{"a":2}'))).toBe('json');
    expect(sniffRenderer(input('{"a":1}', 'nope'))).toBeNull();
  });
});
