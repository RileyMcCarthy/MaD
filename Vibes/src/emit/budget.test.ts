import { describe, expect, it } from 'vitest';
import { DEFAULT_EMIT_BUDGET, TruncationLedger, capList, tailBytes } from './budget.js';
import { byteLength, escapeJsonForScript, fenceFor, slug } from './escape.js';
import { bucketMinMax, sparklineSvg, sparklineText } from './sparkline.js';
import { assertNoExternalRefs } from './noExternal.js';

describe('the ledger', () => {
  it('records to BOTH the report and the log, never only one', () => {
    const lines: string[] = [];
    const ledger = new TruncationLedger((l) => lines.push(l));
    ledger.record({ where: 'markdown', what: '12 changed files', limit: 'markdownMaxBytes=96000' });
    expect(ledger.all).toHaveLength(1);
    expect(lines[0]).toMatch(/truncated in markdown: 12 changed files/);
  });

  it('summarises for the banner so truncation is visible above the fold', () => {
    const ledger = new TruncationLedger();
    expect(ledger.summary()).toBeNull();
    for (let i = 0; i < 5; i += 1) {
      ledger.record({ where: 'w', what: `thing ${i}`, limit: 'l' });
    }
    expect(ledger.summary()).toMatch(/This report is incomplete/);
    expect(ledger.summary()).toMatch(/and 2 more/);
  });
});

describe('capList', () => {
  it('always returns the hidden count, so a caller cannot drop silently', () => {
    expect(capList([1, 2, 3], 5)).toEqual({ shown: [1, 2, 3], hidden: 0 });
    expect(capList([1, 2, 3], 2)).toEqual({ shown: [1, 2], hidden: 1 });
  });
});

describe('tailBytes', () => {
  it('keeps the END of a log, because errors live at the end', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const { text: kept, dropped } = tailBytes(text, 40);
    expect(kept).toContain('line 99');
    expect(kept).not.toContain('line 0\n');
    expect(dropped).toBeGreaterThan(0);
  });

  it('drops a partial first line rather than emitting a mangled one', () => {
    const { text } = tailBytes('aaaa\nbbbb\ncccc', 7);
    expect(text.startsWith('aaa')).toBe(false);
  });

  it('is a no-op under the cap', () => {
    expect(tailBytes('short', 100)).toEqual({ text: 'short', dropped: 0 });
  });
});

describe('escaping helpers', () => {
  it('escapes a </script sequence out of a JSON island', () => {
    const json = JSON.stringify({ a: '</script><img src=x>' });
    const safe = escapeJsonForScript(json);
    expect(safe).not.toContain('</script');
    expect(safe).toContain('\\u003c');
    expect(assertNoExternalRefs(`<script type="application/json">${safe}</script>`)).toEqual([]);
  });

  it('escapes the line-terminator code points a JS parser treats as newlines', () => {
    expect(escapeJsonForScript('"a b"')).toContain('\\u2028');
    expect(escapeJsonForScript('"a b"')).toContain('\\u2029');
  });

  it('grows a fence past the longest backtick run inside it', () => {
    expect(fenceFor('no ticks')).toBe('```');
    expect(fenceFor('a ``` b')).toBe('````');
    expect(fenceFor('a ````` b')).toBe('``````');
  });

  it('counts bytes, not code units', () => {
    expect(byteLength('✓')).toBe(3);
  });

  it('slugs an anchor deterministically', () => {
    expect(slug('Software/Control — domain')).toBe('softwarecontrol-domain');
    expect(slug('Software/Control — domain')).toBe(slug('Software/Control — domain'));
  });
});

describe('sparkline', () => {
  it('preserves a one-sample spike that stride sampling would delete', () => {
    const values = Array.from({ length: 1000 }, () => 0);
    values[137] = 100;
    const { points, max } = bucketMinMax(values, 20);
    expect(max).toBe(100);
    // The spike survives as a bucket maximum.
    expect(points).toContain(100);
  });

  it('emits two points per bucket, min then max', () => {
    const { points } = bucketMinMax([1, 5, 2, 6], 2);
    expect(points).toEqual([1, 5, 2, 6]);
  });

  it('handles an empty or all-NaN series without throwing', () => {
    expect(bucketMinMax([], 10).points).toEqual([]);
    expect(bucketMinMax([Number.NaN, Number.NaN], 10).points).toEqual([]);
    expect(sparklineSvg([], [], 'x')).toBe('');
  });

  it('produces a self-contained SVG that themes itself', () => {
    const svg = sparklineSvg([0, 1, 2], [0, 2, 1], 'force');
    expect(svg).toContain('currentColor');
    expect(svg).toContain('var(--vibes-accent)');
    expect(svg).toContain('aria-label="force"');
    expect(assertNoExternalRefs(svg)).toEqual([]);
  });

  it('gives markdown a text sparkline, since GitHub strips inline SVG', () => {
    const text = sparklineText([0, 1, 2, 3, 4, 5, 6, 7], 8);
    expect(text.length).toBe(8);
    expect(text[0]).toBe('▁');
    expect(text[7]).toBe('█');
  });
});

describe('the shipped budget', () => {
  it('stays under the surfaces it targets', () => {
    // GitHub refuses to RENDER a markdown file over 512 KB; the step summary
    // silently drops the WHOLE summary past 1 MiB.
    expect(DEFAULT_EMIT_BUDGET.markdownMaxBytes).toBeLessThan(512_000);
    expect(DEFAULT_EMIT_BUDGET.stepSummaryMaxBytes).toBeLessThan(1024 * 1024);
  });

  it('is frozen, so no module can mutate the shared budget', () => {
    expect(Object.isFrozen(DEFAULT_EMIT_BUDGET)).toBe(true);
  });
});
