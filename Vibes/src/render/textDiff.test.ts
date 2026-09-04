import { describe, expect, it } from 'vitest';
import { sanitizeInline, sanitizeText } from './blocks.js';
import {
  countLines,
  decodeText,
  deriveMaxEditLength,
  looksBinary,
  makePatch,
  patchLineCount,
  patchStat,
} from './textDiff.js';

const ESC = String.fromCharCode(27);

describe('sanitizeText', () => {
  it('strips ANSI escape sequences with the node builtin', () => {
    expect(sanitizeText(`${ESC}[31mred${ESC}[0m`)).toBe('red');
  });

  it('strips a bare escape that is not part of a recognised sequence', () => {
    expect(sanitizeText(`a${ESC}b`)).not.toContain(ESC);
  });

  it('makes a carriage return visible rather than invisible', () => {
    // A CRLF/LF-only change would otherwise render as two identical lines.
    expect(sanitizeText('a\r\n')).toBe('a␍\n');
  });

  it('keeps newlines and tabs, replaces other control bytes', () => {
    expect(sanitizeText('a\n\tb')).toBe('a\n\tb');
    expect(sanitizeText(`a${String.fromCharCode(1)}b`)).toBe('a�b');
  });

  it('collapses newlines for inline contexts', () => {
    expect(sanitizeInline('a\nb\tc')).toBe('a b c');
  });
});

describe('decodeText', () => {
  it('reports invalid UTF-8 rather than throwing or silently mangling', () => {
    const bad = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
    const out = decodeText(bad);
    expect(out.lossy).toBe(true);
    expect(out.text).toContain('a');
  });

  it('round-trips valid UTF-8, multi-byte included', () => {
    const out = decodeText(Buffer.from('héllo ✓\n', 'utf8'));
    expect(out.lossy).toBe(false);
    expect(out.text).toBe('héllo ✓\n');
  });
});

describe('looksBinary', () => {
  it("uses git's rule: a NUL in the first 8000 bytes", () => {
    expect(looksBinary(Buffer.from('plain text\n'))).toBe(false);
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
  });

  it('does not sniff past 8000 bytes, matching git', () => {
    const buf = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
    expect(looksBinary(buf)).toBe(false);
  });
});

describe('makePatch', () => {
  it('produces hunks with real line numbers', () => {
    const patch = makePatch('a\nb\nc\n', 'a\nB\nc\n', {
      oldLabel: 'old',
      newLabel: 'new',
      maxPatchLines: 400,
    });
    expect(patch.hunks).toHaveLength(1);
    expect(patch.hunks[0]?.oldStart).toBe(1);
    expect(patchStat(patch)).toEqual({ added: 1, removed: 1 });
  });

  it('truncates at the cap and REPORTS the remainder', () => {
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 500 }, (_, i) => `LINE ${i}`).join('\n');
    const patch = makePatch(before, after, { oldLabel: 'o', newLabel: 'n', maxPatchLines: 40 });
    expect(patchLineCount(patch)).toBeLessThanOrEqual(40);
    expect(patch.truncated).toBe(true);
    // Silent truncation reads as "that was all of it".
    expect(patch.droppedLines).toBeGreaterThan(0);
  });

  it('is empty when the two texts are identical', () => {
    const patch = makePatch('a\n', 'a\n', { oldLabel: 'o', newLabel: 'n', maxPatchLines: 400 });
    expect(patch.hunks).toHaveLength(0);
    expect(patch.truncated).toBe(false);
  });

  it('strips ANSI out of the patch lines themselves', () => {
    const patch = makePatch('a\n', `${ESC}[32ma changed${ESC}[0m\n`, {
      oldLabel: 'o',
      newLabel: 'n',
      maxPatchLines: 400,
    });
    const text = patch.hunks.flatMap((h) => h.lines).join('\n');
    expect(text).not.toContain(ESC);
    expect(text).toContain('a changed');
  });
});

describe('deriveMaxEditLength', () => {
  it('scales with the file, so it does not fire on an ordinary rewrite', () => {
    const small = 'a\n'.repeat(10);
    const large = 'a\n'.repeat(10_000);
    expect(deriveMaxEditLength(small, small, 50_000)).toBeLessThan(
      deriveMaxEditLength(large, large, 50_000),
    );
  });

  it('never exceeds the ceiling', () => {
    const huge = 'a\n'.repeat(1_000_000);
    expect(deriveMaxEditLength(huge, huge, 50_000)).toBe(50_000);
  });
});

describe('countLines', () => {
  it('counts an empty string as zero lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
  });
});
