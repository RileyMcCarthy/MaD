import { describe, expect, test } from 'vitest';

import {
  parseRawDiffZ,
  parseLsTreeZ,
  parseCheckIgnoreVerboseZ,
  parseCatFileBatch,
  parseStatusZ,
  looksBinary,
  GITLINK_MODE,
} from './rawParse.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

describe('parseRawDiffZ', () => {
  test('parses a modification', () => {
    const buf = Buffer.from(`:100644 100644 ${A} ${B} M\0src/x.ts\0`, 'utf8');
    const { entries } = parseRawDiffZ(buf);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'M', path: 'src/x.ts', score: null });
    expect(entries[0]?.submodule).toBeUndefined();
  });

  test('a rename consumes TWO path fields, dst last', () => {
    // Getting this backwards is how a rename becomes a delete plus an add.
    const buf = Buffer.from(
      `:100644 100644 ${A} ${B} R099\0Software/MaDWasmControl/x.ts\0Software/Control/x.ts\0` +
        `:100644 100644 ${A} ${B} M\0after.ts\0`,
      'utf8',
    );
    const { entries } = parseRawDiffZ(buf);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      status: 'R',
      from: 'Software/MaDWasmControl/x.ts',
      path: 'Software/Control/x.ts',
      score: 99,
    });
    // The record after a two-path row must still be read as a meta record.
    expect(entries[1]?.path).toBe('after.ts');
  });

  test('a gitlink row carries the pinned commit pair (verified shape)', () => {
    const oldSha = '7c3db495528972c7b02e07b73f4aedb4239a26ab';
    const newSha = '25782af83c6ee0b3351e785aced5aed8895208f6';
    const buf = Buffer.from(
      `:${GITLINK_MODE} ${GITLINK_MODE} ${oldSha} ${newSha} M\0SIL/embsim\0`,
      'utf8',
    );
    const { entries } = parseRawDiffZ(buf);
    expect(entries[0]?.submodule).toEqual({ base: oldSha, head: newSha });
  });

  test('unmerged and unknown rows are surfaced, never silently dropped', () => {
    const buf = Buffer.from(
      `:100644 100644 ${A} ${ZERO} U\0conflict.ts\0:100644 100644 ${A} ${B} X\0weird.ts\0`,
      'utf8',
    );
    const r = parseRawDiffZ(buf);
    expect(r.entries).toHaveLength(0);
    expect(r.unmerged).toEqual(['conflict.ts']);
    expect(r.unknown).toEqual(['weird.ts']);
  });

  test('a truncated record throws rather than reporting fewer changes', () => {
    const buf = Buffer.from(`:100644 100644 ${A} ${B} R100\0only-one-path\0`, 'utf8');
    expect(() => parseRawDiffZ(buf)).toThrow(/truncated/);
  });

  test('combined (merge) diff output is refused', () => {
    const buf = Buffer.from(`::100644 100644 100644 ${A} ${B} ${A} MM\0x.ts\0`, 'utf8');
    expect(() => parseRawDiffZ(buf)).toThrow(/combined diff/);
  });

  test('empty input is empty output', () => {
    expect(parseRawDiffZ(Buffer.alloc(0)).entries).toEqual([]);
  });
});

describe('parseLsTreeZ', () => {
  test('parses the default (mode type oid TAB path) framing', () => {
    const buf = Buffer.from(
      `100644 blob ${A}\tsnaps/a.txt\0${GITLINK_MODE} commit ${B}\tSIL/embsim\0`,
      'utf8',
    );
    expect(parseLsTreeZ(buf)).toEqual([
      { mode: '100644', type: 'blob', oid: A, path: 'snaps/a.txt' },
      { mode: GITLINK_MODE, type: 'commit', oid: B, path: 'SIL/embsim' },
    ]);
  });

  test('a path containing a tab survives (only the FIRST tab separates)', () => {
    const buf = Buffer.from(`100644 blob ${A}\tweird\tname.txt\0`, 'utf8');
    expect(parseLsTreeZ(buf)[0]?.path).toBe('weird\tname.txt');
  });
});

describe('parseCheckIgnoreVerboseZ', () => {
  test('parses source/line/pattern/path quads and flags negations', () => {
    const buf = Buffer.from(
      '.gitignore\x001\x00*.log\x00snaps/run.log\x00' +
        '.gitignore\x003\x00!.vibes/policy.lock.json\x00.vibes/policy.lock.json\x00',
      'utf8',
    );
    const rules = parseCheckIgnoreVerboseZ(buf);
    expect(rules[0]).toMatchObject({ pattern: '*.log', negated: false, line: 1 });
    // A negation matches and reports — which is exactly why `-v`'s exit code
    // cannot be the decision.
    expect(rules[1]).toMatchObject({ negated: true, path: '.vibes/policy.lock.json' });
  });

  test('a field count that is not a multiple of four throws', () => {
    expect(() => parseCheckIgnoreVerboseZ(Buffer.from('a\0b\0c\0', 'utf8'))).toThrow(
      /multiple of 4/,
    );
  });
});

describe('parseCatFileBatch', () => {
  test('slices bodies by declared size, not by newline scanning', () => {
    // A blob whose CONTENT contains newlines and NULs must survive intact.
    const body = Buffer.from('line1\nline2\n\0binary\n', 'utf8');
    const buf = Buffer.concat([
      Buffer.from(`${A} blob ${String(body.length)}\n`, 'utf8'),
      body,
      Buffer.from('\n', 'utf8'),
      Buffer.from(`${B} missing\n`, 'utf8'),
    ]);
    const got = parseCatFileBatch(buf);
    expect(got.get(A)?.equals(body)).toBe(true);
    expect(got.get(B)).toBeNull();
  });

  test('a truncated body throws instead of yielding short content', () => {
    const buf = Buffer.from(`${A} blob 100\nshort`, 'utf8');
    expect(() => parseCatFileBatch(buf)).toThrow(/truncated/);
  });
});

describe('parseStatusZ', () => {
  test('a rename row consumes the following field as the ORIGINAL path', () => {
    const buf = Buffer.from('R  new.ts\0old.ts\0 M other.ts\0', 'utf8');
    const got = parseStatusZ(buf);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      path: 'new.ts',
      index: 'R',
      worktree: ' ',
      origPath: 'old.ts',
    });
    expect(got[1]?.path).toBe('other.ts');
  });

  test('untracked entries parse', () => {
    expect(parseStatusZ(Buffer.from('?? new.txt\0', 'utf8'))[0]).toEqual({
      path: 'new.txt',
      index: '?',
      worktree: '?',
    });
  });
});

describe('looksBinary', () => {
  test("uses git's rule: a NUL inside the first 8000 bytes", () => {
    expect(looksBinary(Buffer.from('plain text\n'))).toBe(false);
    expect(looksBinary(Buffer.from('a\0b'))).toBe(true);
    const late = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])]);
    expect(looksBinary(late)).toBe(false);
  });
});
