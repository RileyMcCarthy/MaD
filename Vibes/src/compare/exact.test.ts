import { describe, expect, it } from 'vitest';
import { compareExact, looksBinary } from './exact.js';
import { bisectNormalization, DEFAULT_NORMALIZATION, describeAbsorption } from './normalize.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('compareExact', () => {
  it('identical means the same BYTES', () => {
    const r = compareExact(buf('a\nb\n'), buf('a\nb\n'));
    expect(r.verdict.kind).toBe('identical');
    expect(r.verdict.mode).toBe('exact');
    expect(r.patch).toBeNull();
  });

  it('a CRLF flip is equivalent, not a total rewrite', () => {
    // MaD builds on ubuntu and macos. Without the bisect this renders as every
    // line removed and every line re-added, which is how a report stops being
    // read.
    const lf = buf('one\ntwo\nthree\n');
    const crlf = buf('one\r\ntwo\r\nthree\r\n');
    const r = compareExact(lf, crlf);
    expect(r.verdict.kind).toBe('equivalent');
    expect(r.absorbedBy).toEqual(['bom', 'eol']);
    expect(r.verdict.summary).toContain('line endings');
    expect(r.patch).toBeNull();
  });

  it('a trailing-newline-only difference is equivalent and named', () => {
    const r = compareExact(buf('a\nb\n'), buf('a\nb'));
    expect(r.verdict.kind).toBe('equivalent');
    expect(r.absorbedBy).toEqual(['bom', 'eol', 'final-newline']);
    expect(r.verdict.summary).toContain('trailing newline');
  });

  it('a BOM appearing is equivalent, never identical', () => {
    const r = compareExact(buf('a\n'), buf('﻿a\n'));
    expect(r.verdict.kind).toBe('equivalent');
    expect(r.absorbedBy).toEqual(['bom']);
  });

  it('real content movement is different, with a patch and a line count', () => {
    const r = compareExact(buf('a\nb\nc\n'), buf('a\nB\nc\n'));
    expect(r.verdict.kind).toBe('different');
    expect(r.changedLines).toEqual({ added: 1, removed: 1 });
    expect(r.patch?.hunks).toHaveLength(1);
    expect(r.verdict.summary).toContain('+1 / -1');
  });

  it('does not silently equate two different invalid-UTF-8 files', () => {
    // Buffer.toString('utf8') maps both of these to U+FFFD, so a non-fatal
    // decode would report them identical. They are not.
    const a = Buffer.from([0x61, 0xff, 0x0a]);
    const b = Buffer.from([0x61, 0xfe, 0x0a]);
    expect(a.toString('utf8')).toBe(b.toString('utf8'));
    const r = compareExact(a, b);
    expect(r.verdict.kind).toBe('different');
    expect(r.notes.join(' ')).toContain('not valid UTF-8');
  });

  it('text becoming binary is structural, not different', () => {
    const r = compareExact(buf('hello\n'), Buffer.from([0x68, 0x00, 0x69]));
    expect(r.verdict.kind).toBe('structural');
    expect(r.verdict.summary).toContain('received');
  });

  it('binary-to-binary movement is different with no patch', () => {
    const r = compareExact(Buffer.from([0x00, 0x01]), Buffer.from([0x00, 0x02]));
    expect(r.verdict.kind).toBe('different');
    expect(r.patch).toBeNull();
    expect(r.verdict.summary).toContain('binary');
  });

  it('gives up honestly instead of hanging on a total rewrite', () => {
    const a = Array.from({ length: 400 }, (_, i) => `alpha ${i}`).join('\n');
    const b = Array.from({ length: 400 }, (_, i) => `omega ${i * 7}`).join('\n');
    const r = compareExact(buf(a), buf(b), { editLengthCeiling: 8 });
    expect(r.verdict.kind).toBe('different');
    expect(r.tooDivergent).toBe(true);
    expect(r.patch).toBeNull();
    expect(r.verdict.summary).toContain('too divergent');
  });

  it('reports oversize files as changed without diffing them', () => {
    const r = compareExact(buf('a'.repeat(100)), buf('b'.repeat(100)), { maxFileBytes: 10 });
    expect(r.verdict.kind).toBe('different');
    expect(r.tooDivergent).toBe(true);
    expect(r.verdict.summary).toContain('not diffed');
  });

  it('leaves trailing whitespace visible by default', () => {
    // The snapshot format pads keys to a fixed width; trailing space can be
    // layout, so stripping it by default would hide a real change.
    const r = compareExact(buf('key   value\n'), buf('key   value  \n'));
    expect(r.verdict.kind).toBe('different');
    const r2 = compareExact(buf('key   value\n'), buf('key   value  \n'), {
      normalization: { trailingWhitespace: true },
    });
    expect(r2.verdict.kind).toBe('equivalent');
    expect(r2.absorbedBy).toContain('trailing-ws');
  });

  it('does not canonicalise JSON key order by default', () => {
    // One schema generates C, TypeScript and Rust here: key order is
    // wire-format-relevant, so reordering is a change until declared otherwise.
    const a = buf('{"b":1,"a":2}');
    const b = buf('{"a":2,"b":1}');
    expect(compareExact(a, b).verdict.kind).toBe('different');
    expect(
      compareExact(a, b, { normalization: { jsonCanonical: true } }).verdict.kind,
    ).toBe('equivalent');
  });
});

describe('normalization bisect', () => {
  it('names the decisive step and lists the applied prefix', () => {
    const r = bisectNormalization('a\r\nb', 'a\nb\n', DEFAULT_NORMALIZATION);
    expect(r.equal).toBe(true);
    expect(r.decisive).toBe('final-newline');
    expect(describeAbsorption(r.absorbedBy ?? [], r.decisive)).toContain('normalized:');
  });

  it('reports no absorption when the difference is real', () => {
    const r = bisectNormalization('a\n', 'b\n', DEFAULT_NORMALIZATION);
    expect(r.equal).toBe(false);
    expect(r.absorbedBy).toBeNull();
  });
});

describe('looksBinary', () => {
  it("uses git's rule: a NUL in the first 8000 bytes", () => {
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    const late = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);
    expect(looksBinary(late)).toBe(false);
  });
});
