import { describe, expect, it } from 'vitest';
import { classifyCell, parseSeries, VOLATILE_PREFIX } from './series.js';

function doc(text: string) {
  const parsed = parseSeries(text);
  if (!parsed.ok) throw new Error(`expected parse to succeed: ${parsed.error.message}`);
  return parsed.doc;
}

describe('parseSeries', () => {
  it('reads preamble, header and rows', () => {
    const d = doc(
      '# sample profile SN-1\n' +
        `${VOLATILE_PREFIX} started=2026-08-21T10:00:00Z\n` +
        'time_us,position_um,force_mN\n' +
        '0,0,0\n' +
        '1000,25.5,3.5\n',
    );
    expect(d.columns).toEqual(['time_us', 'position_um', 'force_mN']);
    expect(d.rows).toEqual([
      ['0', '0', '0'],
      ['1000', '25.5', '3.5'],
    ]);
    expect(d.comments.map((c) => c.text)).toEqual(['# sample profile SN-1']);
    expect(d.volatileComments).toHaveLength(1);
    expect(d.headerless).toBe(false);
  });

  it('scans CRLF identically to LF — the data is the same data', () => {
    const lf = doc('a,b\n1,2\n');
    const crlf = doc('a,b\r\n1,2\r\n');
    expect(crlf).toEqual(lf);
  });

  it('handles quoting, doubled quotes and trailing empty fields', () => {
    const d = doc('a,b,c\n"x,y","he said ""hi""",\n');
    expect(d.rows[0]).toEqual(['x,y', 'he said "hi"', '']);
  });

  it('rejects an embedded newline instead of guessing', () => {
    // A quoted field spanning lines would break the line-oriented scan that
    // keeps preamble/header/rows separable; it is rejected with a line number.
    const parsed = parseSeries('a,b\n"unterminated,2\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.line).toBe(2);
    expect(parsed.error.message).toContain('unterminated quoted field');
  });

  it('rejects duplicate and empty column names — an ambiguous key cannot be honest', () => {
    const dup = parseSeries('a,b,a\n1,2,3\n');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.message).toContain('duplicate column name');

    const empty = parseSeries('a,,c\n1,2,3\n');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.message).toContain('empty column name');
  });

  it('rejects a ragged row and names the line', () => {
    const parsed = parseSeries('a,b\n1,2\n3\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.line).toBe(3);
    expect(parsed.error.message).toContain('1 cells');
  });

  it('treats an all-comment file as headerless rather than inventing a header', () => {
    const d = doc('# nothing but prose\n');
    expect(d.headerless).toBe(true);
    expect(d.columns).toEqual([]);
    expect(d.rows).toEqual([]);
  });

  it('honours a declared tab delimiter without sniffing it', () => {
    const parsed = parseSeries('a\tb\n1\t2\n', { delimiter: '\t' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.columns).toEqual(['a', 'b']);
    // The SAME bytes with the default delimiter parse as one column. That is
    // the point: the dialect comes from the caller, never from the content.
    const asComma = doc('a\tb\n1\t2\n');
    expect(asComma.columns).toEqual(['a\tb']);
  });

  it('enforces the row budget', () => {
    const parsed = parseSeries('a\n1\n2\n3\n', { maxRows: 2 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain('2-row budget');
  });
});

describe('classifyCell', () => {
  it('classifies a blank BEFORE any Number() coercion', () => {
    // Number('') === 0. Coercing first turns a missing force reading into a
    // confident 0.000 that sits inside every epsilon.
    expect(Number('')).toBe(0);
    expect(classifyCell('').kind).toBe('gap');
    expect(classifyCell('   ').kind).toBe('gap');
  });

  it('keeps non-finite tokens out of the numeric bucket', () => {
    expect(classifyCell('NaN').kind).toBe('non-finite');
    expect(classifyCell('Infinity').kind).toBe('non-finite');
    expect(classifyCell('-Infinity').kind).toBe('non-finite');
  });

  it('classifies ordinary numbers, signed zero and text', () => {
    expect(classifyCell('3.5')).toEqual({ kind: 'number', value: 3.5 });
    expect(Object.is(classifyCell('-0').value, -0)).toBe(true);
    expect(classifyCell('DISABLED').kind).toBe('text');
    expect(classifyCell('1e3')).toEqual({ kind: 'number', value: 1000 });
  });
});
