import { describe, expect, it } from 'vitest';
import type { RenderBlock } from '../render/index.js';
import { DEFAULT_EMIT_BUDGET } from './budget.js';
import { DISCLOSURE_SENTENCE } from './headline.js';
import { buildMarkdown, renderBlocksMarkdown } from './markdown.js';
import { prepare } from './prepare.js';
import { component, finding, makeReport, producer, snap } from './fixture.test.js';

const content = (b: string | null, r: string | null) => () => ({
  baseline: b === null ? null : Buffer.from(b),
  received: r === null ? null : Buffer.from(r),
});

describe('block → markdown', () => {
  it('escalates the fence when content contains backticks', () => {
    // A snapshot line containing ``` ends a 3-backtick fence early, and the
    // rest of the diff silently renders as prose.
    const block: RenderBlock = { kind: 'code', text: 'a\n```\nb' };
    const md = renderBlocksMarkdown([block]);
    expect(md.startsWith('````')).toBe(true);
    expect(md.trimEnd().endsWith('````')).toBe(true);
  });

  it('puts a blank line after </summary> so the nested fence renders', () => {
    const block: RenderBlock = {
      kind: 'details',
      summary: 'more',
      children: [{ kind: 'code', text: 'x' }],
    };
    const md = renderBlocksMarkdown([block]);
    expect(md).toContain('</summary>\n\n');
  });

  it('renders a diff inside a ```diff fence with hunk headers', () => {
    const block: RenderBlock = {
      kind: 'diff',
      patch: {
        oldLabel: 'a',
        newLabel: 'a',
        truncated: false,
        droppedLines: 0,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      },
    };
    const md = renderBlocksMarkdown([block]);
    expect(md).toContain('```diff');
    expect(md).toContain('@@ -1,1 +1,1 @@');
  });

  it('says out loud when a diff was truncated', () => {
    const block: RenderBlock = {
      kind: 'diff',
      patch: {
        oldLabel: 'a',
        newLabel: 'a',
        truncated: true,
        droppedLines: 120,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a'] }],
      },
    };
    expect(renderBlocksMarkdown([block])).toContain('120 further changed lines');
  });

  it('escapes pipes inside table cells', () => {
    const block: RenderBlock = { kind: 'table', columns: ['a|b'], rows: [['x|y']] };
    expect(renderBlocksMarkdown([block])).toContain('x\\|y');
  });
});

describe('report markdown', () => {
  it('carries the disclosure verbatim, outside any collapsed section', async () => {
    const prepared = await prepare(
      makeReport({ components: [component({ snapshots: [snap('a.txt', 'changed')] })] }),
      { content: content('a\n', 'b\n') },
    );
    const md = buildMarkdown(prepared).text;
    expect(md).toContain(DISCLOSURE_SENTENCE);
    const idx = md.indexOf(DISCLOSURE_SENTENCE);
    const before = md.slice(0, idx);
    // No unclosed <details> before the sentence means it cannot be collapsed.
    const opens = (before.match(/<details/g) ?? []).length;
    const closes = (before.match(/<\/details>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('leads with the headline as the only H1', async () => {
    const prepared = await prepare(makeReport());
    const md = buildMarkdown(prepared).text;
    const h1s = md.split('\n').filter((l) => /^# /.test(l));
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toContain(prepared.headline.sentence);
  });

  it('names every one of the six snapshot states distinctly', async () => {
    const prepared = await prepare(
      makeReport({
        fullyVerified: false,
        components: [
          component({
            state: 'partial',
            producers: [producer('domain', 'ok'), producer('trace', 'timedOut')],
            snapshots: [
              snap('1', 'verified-unchanged'),
              snap('2', 'changed'),
              snap('3', 'added'),
              snap('4', 'deleted'),
              snap('5', 'not-selected'),
              snap('6', 'not-run'),
            ],
          }),
        ],
      }),
      { content: content('a\n', 'b\n') },
    );
    const md = buildMarkdown(prepared).text;
    for (const label of ['unchanged since base', 'changed', 'added', 'deleted', 'not selected', 'not run']) {
      expect(md, `missing state label: ${label}`).toContain(label);
    }
    expect(md).toMatch(/nothing about its snapshots is known/);
  });

  it('renders governance findings above the ordinary findings', async () => {
    const prepared = await prepare(
      makeReport({
        findings: [finding('unclaimed-path', 'warn'), finding('governance-weakened', 'error')],
      }),
    );
    const md = buildMarkdown(prepared).text;
    expect(md.indexOf('## Governance changes')).toBeLessThan(md.indexOf('## Findings'));
  });

  it('always ends with what was left out, even when nothing was', async () => {
    const prepared = await prepare(makeReport());
    expect(buildMarkdown(prepared).text).toContain('## What was left out');
  });

  it('truncates within the byte budget and records every cut', async () => {
    const snapshots = Array.from({ length: 60 }, (_, i) => snap(`file-${i}.txt`, 'changed'));
    const big = 'x'.repeat(400) + '\n';
    const prepared = await prepare(
      makeReport({ components: [component({ state: 'changed', snapshots })] }),
      { content: content(big, `${big}changed\n`) },
    );
    const result = buildMarkdown(prepared, 12_000);
    expect(result.bytes).toBeLessThan(12_000 + 2_000);
    expect(result.truncations.length).toBeGreaterThan(0);
    // Silent truncation reads as "covered everything" — so it is never silent.
    expect(result.text).toContain('## What was left out');
    expect(result.text).toMatch(/omitted for length|not diffed|left out/);
  });

  it('keeps the required sections even at an absurdly small budget', async () => {
    const prepared = await prepare(
      makeReport({
        findings: [finding('a-finding', 'error')],
        components: [component({ snapshots: [snap('a.txt', 'changed')] })],
      }),
      { content: content('a\n', 'b\n') },
    );
    const result = buildMarkdown(prepared, 3_000);
    expect(result.text).toContain(DISCLOSURE_SENTENCE);
    expect(result.text).toMatch(/^# /m);
    expect(result.text).toContain('## What this run measured');
  });

  it('says when no content was available rather than implying empty diffs', async () => {
    const prepared = await prepare(
      makeReport({ components: [component({ snapshots: [snap('a.txt', 'changed')] })] }),
    );
    const md = buildMarkdown(prepared).text;
    expect(md).toMatch(/no snapshot content was supplied/i);
  });

  it('keeps the tests table contiguous — a blank line ends a markdown table', async () => {
    const prepared = await prepare(
      makeReport({
        components: [
          component({
            tests: { total: 10, passed: 10, failed: 0, skipped: 0, durationMs: 1, cases: [], source: 'vitest', stale: false },
          }),
          component({
            component: 'firmware',
            state: 'not-configured',
            producers: [],
            tests: { total: 5, passed: 5, failed: 0, skipped: 0, durationMs: 1, cases: [], source: 'pio', stale: false },
          }),
        ],
      }),
    );
    const md = buildMarkdown(prepared).text;
    const table = md.slice(md.indexOf('## Tests')).split('\n\n')[1] ?? '';
    const rows = table.split('\n').filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(4);
  });

  it('reports coverage as "not configured" by name, never as absence', async () => {
    const prepared = await prepare(
      makeReport({
        components: [
          component({
            tests: {
              total: 244,
              passed: 244,
              failed: 0,
              skipped: 0,
              durationMs: 1000,
              cases: [],
              source: 'vitest',
              stale: false,
            },
          }),
        ],
      }),
    );
    expect(buildMarkdown(prepared).text).toContain('not configured');
  });

  it('uses the shipped budget by default', async () => {
    const prepared = await prepare(makeReport());
    expect(prepared.budget.markdownMaxBytes).toBe(DEFAULT_EMIT_BUDGET.markdownMaxBytes);
  });
});
