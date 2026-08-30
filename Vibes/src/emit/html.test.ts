import { describe, expect, it } from 'vitest';
import type { RenderBlock } from '../render/index.js';
import { makePatch } from '../render/index.js';
import { diffTableHtml } from './diffTable.js';
import { DISCLOSURE_SENTENCE } from './headline.js';
import { buildHtml, renderBlocksHtml } from './html.js';
import { buildMarkdown } from './markdown.js';
import { assertNoExternalRefs } from './noExternal.js';
import { prepare } from './prepare.js';
import { component, finding, makeReport, producer, snap } from './fixture.test.js';

const content = (b: string | null, r: string | null) => () => ({
  baseline: b === null ? null : Buffer.from(b),
  received: r === null ? null : Buffer.from(r),
});

describe('diff tables', () => {
  const patch = makePatch('a\nb\nc\n', 'a\nB\nc\n', {
    oldLabel: 'f',
    newLabel: 'f',
    maxPatchLines: 400,
  });

  it('carries line numbers on both sides', () => {
    const html = diffTableHtml(patch);
    expect(html).toContain('class="ln"');
    expect(html).toContain('@@ -1,3 +1,3 @@');
    expect(html).toContain('class="del"');
    expect(html).toContain('class="add"');
  });

  it('marks intra-line word changes on a matched pair', () => {
    const html = diffTableHtml(patch, { intraLine: 'word' });
    expect(html).toContain('<mark class="w">');
  });

  it('does not invent a pairing across an unbalanced rewrite', () => {
    const uneven = makePatch('a\n', 'x\ny\nz\n', { oldLabel: 'f', newLabel: 'f', maxPatchLines: 400 });
    expect(diffTableHtml(uneven, { intraLine: 'word' })).not.toContain('<mark');
  });

  it('renders a split view with four columns', () => {
    const html = diffTableHtml(patch, { view: 'split' });
    expect(html).toContain('class="diff split"');
    expect(html).toContain('colspan="4"');
  });

  it('escapes content so markup in a snapshot cannot become markup', () => {
    const hostile = makePatch('a\n', '<script>alert(1)</script>\n', {
      oldLabel: 'f',
      newLabel: 'f',
      maxPatchLines: 400,
    });
    const html = diffTableHtml(hostile);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('says when it was truncated', () => {
    const truncated = makePatch('a\n'.repeat(200), 'b\n'.repeat(200), {
      oldLabel: 'f',
      newLabel: 'f',
      maxPatchLines: 10,
    });
    expect(diffTableHtml(truncated)).toMatch(/Diff truncated/);
  });
});

describe('blocks → html', () => {
  it('never uses the lang hint to highlight', () => {
    const block: RenderBlock = { kind: 'code', text: 'const x = 1', lang: 'ts' };
    const html = renderBlocksHtml([block]);
    expect(html).toBe('<pre><code>const x = 1</code></pre>');
  });

  it('renders a series as an inline SVG with no script', () => {
    const block: RenderBlock = {
      kind: 'series',
      label: 'force_mN',
      x: { x0: 0, dx: 1 },
      old: [0, 1, 2, 3],
      new: [0, 1, 5, 3],
    };
    const html = renderBlocksHtml([block]);
    expect(html).toContain('<svg');
    expect(html).toContain('<polyline');
    expect(html).not.toContain('<script');
    expect(assertNoExternalRefs(html)).toEqual([]);
  });
});

describe('report html', () => {
  const bigReport = () =>
    makeReport({
      fullyVerified: false,
      findings: [finding('governance-weakened', 'error'), finding('unclaimed-path', 'warn')],
      components: [
        component({
          state: 'partial',
          producers: [producer('domain', 'ok'), producer('trace', 'timedOut')],
          snapshots: [
            snap('1.txt', 'verified-unchanged'),
            snap('2.txt', 'changed'),
            snap('3.txt', 'added'),
            snap('4.txt', 'deleted'),
            snap('5.txt', 'not-selected'),
            snap('6.txt', 'not-run'),
          ],
          unclaimedPaths: ['src/domain/gcode.ts'],
        }),
      ],
    });

  it('is self-contained: the emitter runs the check and would throw', async () => {
    const prepared = await prepare(bigReport(), { content: content('a\n', 'b\n') });
    const built = buildHtml(prepared);
    expect(assertNoExternalRefs(built.html)).toEqual([]);
  });

  it('ships zero script, so it is readable with JS disabled', async () => {
    const prepared = await prepare(bigReport(), { content: content('a\n', 'b\n') });
    expect(buildHtml(prepared).html).not.toMatch(/<script/);
  });

  it('defines every colour in the light palette and redefines it for dark', async () => {
    const prepared = await prepare(makeReport());
    const html = buildHtml(prepared).html;
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('[data-theme="dark"]');
    // A colour whose ONLY definition is inside a media query is invisible in
    // the other theme, so the base :root block must define them all.
    const root = html.slice(html.indexOf(':root{'), html.indexOf('@media'));
    for (const token of ['--bg', '--fg', '--border', '--add-bg', '--del-bg', '--err', '--warn']) {
      expect(root, `token missing from the base palette: ${token}`).toContain(token);
    }
  });

  it('carries the disclosure outside any <details>', async () => {
    const prepared = await prepare(bigReport(), { content: content('a\n', 'b\n') });
    const html = buildHtml(prepared).html;
    expect(html).toContain(DISCLOSURE_SENTENCE);
    const before = html.slice(0, html.indexOf(DISCLOSURE_SENTENCE));
    expect((before.match(/<details/g) ?? []).length).toBe(
      (before.match(/<\/details>/g) ?? []).length,
    );
  });

  it('embeds hostile snapshot content without breaking the page or the check', async () => {
    const hostile = '<script src="https://evil.example/x.js"></script>\n@import "https://a/b.css";\n';
    const prepared = await prepare(
      makeReport({ components: [component({ snapshots: [snap('evil.html', 'changed')] })] }),
      { content: content('safe\n', hostile) },
    );
    const html = buildHtml(prepared).html;
    expect(assertNoExternalRefs(html)).toEqual([]);
    expect(html).toContain('&lt;script');
  });

  it('names the not-run producer instead of leaving a silent gap', async () => {
    const prepared = await prepare(bigReport(), { content: content('a\n', 'b\n') });
    const html = buildHtml(prepared).html;
    expect(html).toContain('trace');
    expect(html).toMatch(/nothing about its snapshots is known/);
  });

  it('has a title, and the title obeys the headline invariant too', async () => {
    const prepared = await prepare(bigReport(), { content: content('a\n', 'b\n') });
    const html = buildHtml(prepared).html;
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    expect(title.length).toBeGreaterThan(0);
    expect(/\bunchanged\b/i.test(title)).toBe(false);
  });

  it('lists the same sections as the markdown surface', async () => {
    // Two surfaces that list different sections mean which file a reviewer
    // opens decides what they learn.
    const prepared = await prepare(
      makeReport({
        fullyVerified: false,
        findings: [finding('governance-weakened', 'error'), finding('unclaimed-path', 'warn')],
        components: [
          component({
            state: 'partial',
            snapshots: [snap('a.txt', 'changed')],
            tests: { total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 1, cases: [], source: 'v', stale: false },
          }),
        ],
      }),
      { content: content('a\n', 'b\n') },
    );
    const html = buildHtml(prepared).html;
    const md = buildMarkdown(prepared).text;
    const htmlSections = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
    const mdSections = [...md.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
    expect(htmlSections).toEqual(mdSections);
  });

  it('wraps wide content so the page body never scrolls horizontally', async () => {
    const prepared = await prepare(
      makeReport({ components: [component({ snapshots: [snap('wide.txt', 'changed')] })] }),
      { content: content('a\n', `${'x'.repeat(400)}\n`) },
    );
    const html = buildHtml(prepared).html;
    expect(html).toContain('class="scroll"');
    expect(html).toContain('overflow-x:auto');
  });
});
