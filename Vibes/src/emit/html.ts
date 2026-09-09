/**
 * The HTML surface: ONE self-contained file.
 *
 * Hard constraints, all enforced rather than intended:
 *  - no external requests, ever — `assertNoExternalRefs` runs on the finished
 *    document and the emitter THROWS on a violation;
 *  - no script. `actions/upload-artifact` only guarantees "simple HTML files",
 *    and the report has to be fully readable with JS disabled. Collapsing is
 *    `<details>`, theming is `prefers-color-scheme`, charts are inline SVG.
 *    Zero script also means zero XSS surface to reason about;
 *  - every colour comes from a CSS custom property, defined once in the light
 *    palette and redefined for dark. A colour whose only definition lives
 *    inside a media query is invisible in the other theme.
 */

import type { Finding, SnapshotResult } from '../types.js';
import type { RenderBlock } from '../render/index.js';
import type { Truncation } from './budget.js';
import { capList } from './budget.js';
import { diffTableHtml } from './diffTable.js';
import { byteLength, escapeHtml, slug } from './escape.js';
import {
  assertHeadlineInvariant,
  COMPONENT_STATE_LABEL,
  DISCLOSURE_SENTENCE,
  SNAP_STATE_LABEL,
} from './headline.js';
import { throwIfExternalRefs } from './noExternal.js';
import type { PreparedComponent, PreparedReport, PreparedSnapshot } from './prepare.js';
import { sparklineSvg } from './sparkline.js';

/* ──────────────────────────────── CSS ────────────────────────────────── */

const CSS = `
:root{
  --bg:#ffffff; --panel:#f6f8fa; --fg:#1f2328; --muted:#59636e; --border:#d1d9e0;
  --accent:#0969da; --vibes-accent:#0969da;
  --add-bg:#e6ffec; --add-fg:#116329; --del-bg:#ffebe9; --del-fg:#82071e;
  --mark-add:#abf2bc; --mark-del:#ffc1bc;
  --err:#cf222e; --warn:#9a6700; --info:#0969da;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0d1117; --panel:#151b23; --fg:#f0f6fc; --muted:#9198a1; --border:#3d444d;
    --accent:#4493f8; --vibes-accent:#4493f8;
    --add-bg:#12261e; --add-fg:#3fb950; --del-bg:#25171c; --del-fg:#f85149;
    --mark-add:#1f6f37; --mark-del:#8d2f28;
    --err:#f85149; --warn:#d29922; --info:#4493f8;
  }
}
:root[data-theme="dark"]{
  --bg:#0d1117; --panel:#151b23; --fg:#f0f6fc; --muted:#9198a1; --border:#3d444d;
  --accent:#4493f8; --vibes-accent:#4493f8;
  --add-bg:#12261e; --add-fg:#3fb950; --del-bg:#25171c; --del-fg:#f85149;
  --mark-add:#1f6f37; --mark-del:#8d2f28;
  --err:#f85149; --warn:#d29922; --info:#4493f8;
}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem 6rem;background:var(--bg);color:var(--fg);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:60rem;margin:0 auto}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 .5rem;font-weight:600}
h2{font-size:1.1rem;margin:2.25rem 0 .75rem;padding-bottom:.3rem;border-bottom:1px solid var(--border)}
h3{font-size:1rem;margin:1.5rem 0 .5rem}
h4{font-size:.95rem;margin:1rem 0 .4rem;font-weight:600}
p{margin:.6rem 0}
code,pre,.tx,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
code{background:var(--panel);padding:.1em .35em;border-radius:4px}
pre{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:.75rem;overflow-x:auto}
.meta-line{color:var(--muted);font-size:.85rem;margin:0 0 1.25rem}
.disclosure{border-left:3px solid var(--accent);background:var(--panel);padding:.75rem 1rem;margin:1rem 0;border-radius:0 6px 6px 0}
.note{border-left:3px solid var(--info);padding:.5rem .85rem;margin:.6rem 0;background:var(--panel);border-radius:0 6px 6px 0}
.note.warn{border-color:var(--warn)}
.note.error{border-color:var(--err)}
.sev{font-weight:600;text-transform:uppercase;font-size:.7rem;letter-spacing:.04em}
.sev.error{color:var(--err)} .sev.warn{color:var(--warn)} .sev.info{color:var(--info)}
table{border-collapse:collapse;width:100%;margin:.75rem 0}
.tally th,.tally td{border:1px solid var(--border);padding:.35rem .6rem;text-align:right}
.tally th:first-child,.tally td:first-child{text-align:left}
.tally th{background:var(--panel);font-weight:600}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.diff{border:1px solid var(--border);border-radius:6px;font-size:12.5px;table-layout:auto}
table.diff td{padding:0 .5rem;vertical-align:top;white-space:pre-wrap;word-break:break-word}
table.diff .ln{width:1%;min-width:3ch;text-align:right;color:var(--muted);
  user-select:none;background:var(--panel);border-right:1px solid var(--border)}
table.diff .sg{display:inline-block;width:1.25ch;color:var(--muted)}
table.diff tr.del td{background:var(--del-bg);color:var(--del-fg)}
table.diff tr.add td{background:var(--add-bg);color:var(--add-fg)}
table.diff td.del{background:var(--del-bg);color:var(--del-fg)}
table.diff td.add{background:var(--add-bg);color:var(--add-fg)}
table.diff td.nil{background:var(--panel)}
table.diff tr.hunk td{background:var(--panel);color:var(--muted);padding:.25rem .5rem;
  border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
table.diff tr.meta td{color:var(--muted);font-style:italic}
mark.w{background:var(--mark-add);color:inherit;border-radius:2px}
tr.del mark.w,td.del mark.w{background:var(--mark-del)}
details{border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;margin:.6rem 0;background:var(--panel)}
details>summary{cursor:pointer;font-weight:600}
details[open]>summary{margin-bottom:.6rem}
.spark-row{display:flex;align-items:center;gap:.75rem;margin:.5rem 0}
.spark-row .label{min-width:12ch;color:var(--muted);font-size:.8rem}
.spark-row .chart{flex:1;min-width:0}
svg.vibes-spark{width:100%;height:56px;display:block;color:var(--muted)}
.state{font-size:.75rem;padding:.1rem .4rem;border-radius:999px;border:1px solid var(--border);color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
ul.paths{margin:.35rem 0;padding-left:1.25rem;color:var(--muted)}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--border);color:var(--muted);font-size:.85rem}
`.trim();

/* ─────────────────────────── block rendering ─────────────────────────── */

export function renderBlocksHtml(blocks: readonly RenderBlock[]): string {
  return blocks.map(renderBlockHtml).join('');
}

function renderBlockHtml(block: RenderBlock): string {
  switch (block.kind) {
    case 'heading':
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    case 'text':
      return `<p>${escapeHtml(block.text).replace(/\n/g, '<br>')}</p>`;
    case 'kv':
      return `<table class="tally"><tbody>${block.entries
        .map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
        .join('')}</tbody></table>`;
    case 'code':
      // `lang` is a hint and is deliberately NOT used to highlight: highlighting
      // means shipping a tokenizer, and a wrong tokenizer misreads content.
      return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
    case 'diff': {
      const opts: { view?: 'unified' | 'split'; intraLine?: 'word' | 'none' } = {};
      if (block.view !== undefined) opts.view = block.view;
      if (block.intraLine !== undefined) opts.intraLine = block.intraLine;
      return `<div class="scroll">${diffTableHtml(block.patch, opts)}</div>`;
    }
    case 'table': {
      const head = block.columns
        .map((c, i) => `<th${(block.align?.[i] ?? 'left') === 'right' ? ' class="r"' : ''}>${escapeHtml(c)}</th>`)
        .join('');
      const body = block.rows
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(String(c ?? ''))}</td>`).join('')}</tr>`)
        .join('');
      return `<div class="scroll"><table class="tally"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
    case 'series': {
      const unit = block.unit === undefined ? '' : ` (${escapeHtml(block.unit)})`;
      const eps = block.epsilon === undefined ? '' : ` · epsilon ${block.epsilon}`;
      const svg = sparklineSvg(block.old, block.new, `${block.label} baseline versus produced`);
      return (
        `<div class="spark-row"><span class="label">${escapeHtml(block.label)}${unit}${eps}</span>` +
        `<span class="chart">${svg}</span></div>`
      );
    }
    case 'note':
      return `<p class="note ${block.level}"><span class="sev ${block.level}">${block.level}</span> ${escapeHtml(block.text)}</p>`;
    case 'details':
      return (
        `<details${block.open === true ? ' open' : ''}><summary>${escapeHtml(block.summary)}</summary>` +
        renderBlocksHtml(block.children) +
        `</details>`
      );
  }
}

/* ────────────────────────── document assembly ────────────────────────── */

export interface HtmlResult {
  readonly html: string;
  readonly bytes: number;
  readonly truncations: readonly Truncation[];
}

export function buildHtml(prepared: PreparedReport): HtmlResult {
  const { report, tally: t } = prepared;
  assertHeadlineInvariant(prepared.headline.sentence, report.fullyVerified);

  const parts: string[] = [];
  const budgetBytes = prepared.budget.htmlMaxBytes;

  parts.push(`<main>`);
  parts.push(`<h1>${escapeHtml(prepared.headline.sentence)}</h1>`);
  parts.push(
    `<p class="meta-line">${escapeHtml(report.baseSha.slice(0, 8))} → ${escapeHtml(report.headSha.slice(0, 8))} · base ${escapeHtml(report.baseRef)} · ${(report.durationMs / 1000).toFixed(1)}s · ${escapeHtml(prepared.generatedAt)}</p>`,
  );

  // The disclosure. Never inside <details>, by construction — it is emitted
  // here, above everything, and no code path wraps it.
  parts.push(`<p class="disclosure">${escapeHtml(DISCLOSURE_SENTENCE)}</p>`);

  parts.push('<h2>What this run measured</h2>');
  parts.push(
    `<table class="tally"><thead><tr><th>producers</th><th>ran</th><th>did not complete</th><th>not selected</th></tr></thead>` +
      `<tbody><tr><td>${t.producersTotal}</td><td>${t.producersOk}</td><td>${t.producersFailed}</td><td>${t.producersNotSelected}</td></tr></tbody></table>`,
  );
  parts.push(
    `<table class="tally"><thead><tr><th>snapshot files</th><th>${escapeHtml(SNAP_STATE_LABEL['verified-unchanged'])}</th><th>changed</th><th>added</th><th>deleted</th><th>not selected</th><th>not run</th></tr></thead>` +
      `<tbody><tr><td>${t.totalSnapshots}</td><td>${t.states['verified-unchanged']}</td><td>${t.states.changed}</td><td>${t.states.added}</td><td>${t.states.deleted}</td><td>${t.states['not-selected']}</td><td>${t.states['not-run']}</td></tr></tbody></table>`,
  );
  if (prepared.contentUnavailable) {
    parts.push(
      `<p class="note warn"><span class="sev warn">note</span> No snapshot content was supplied to the emitter, so this report lists what moved without showing the diffs.</p>`,
    );
  }
  if (t.componentsNotConfigured.length > 0) {
    parts.push(
      `<p class="note info"><span class="sev info">note</span> Not configured for behaviour snapshots: ${escapeHtml(t.componentsNotConfigured.join(', '))}. Named rather than omitted — an omitted component renders as silence, and silence reads as “fine”.</p>`,
    );
  }

  const governance = allFindings(prepared).filter(isGovernance);
  if (governance.length > 0) {
    parts.push('<h2>Governance changes</h2>');
    parts.push(
      '<p>These changed what the tool is allowed to notice. Read them before the behaviour section.</p>',
    );
    parts.push(governance.map(findingHtml).join(''));
  }

  const findings = allFindings(prepared).filter((f) => !isGovernance(f));
  if (findings.length > 0) {
    const ordered = [...findings].sort((a, b) => severityRank(a) - severityRank(b));
    parts.push(`<h2>Findings (${ordered.length})</h2>`);
    parts.push(ordered.map(findingHtml).join(''));
  }

  let expanded = 0;
  let bytesSoFar = byteLength(parts.join(''));
  let droppedFiles = 0;
  const movedParts: string[] = [];
  for (const c of prepared.components) {
    const moved = c.rendered.filter((s) => s.result.state !== 'verified-unchanged');
    if (moved.length === 0) continue;
    movedParts.push(`<h3 id="c-${slug(c.result.component)}">${escapeHtml(c.result.component)}</h3>`);
    for (const snap of moved) {
      const html = snapshotHtml(snap, expanded < prepared.budget.expandFirstNFiles);
      if (bytesSoFar + byteLength(html) > budgetBytes) {
        droppedFiles += 1;
        continue;
      }
      movedParts.push(html);
      bytesSoFar += byteLength(html);
      expanded += 1;
    }
    if (c.unrenderedCount > 0) {
      movedParts.push(
        `<p class="note info"><span class="sev info">note</span> ${c.unrenderedCount} further changed file${c.unrenderedCount === 1 ? ' was' : 's were'} listed but not diffed.</p>`,
      );
    }
  }
  if (droppedFiles > 0) {
    prepared.ledger.record({
      where: 'html report',
      what: `${droppedFiles} rendered diff${droppedFiles === 1 ? '' : 's'}`,
      limit: `report.htmlMaxBytes=${budgetBytes}`,
    });
  }
  if (movedParts.length > 0) {
    parts.push('<h2>What moved</h2>');
    parts.push(...movedParts);
  }

  // Section parity with markdown is not cosmetic: two surfaces that list
  // different sections mean which file a reviewer opens decides what they learn.
  const testRows = prepared.components.filter((c) => c.result.tests !== null || c.result.coverage !== null);
  if (testRows.length > 0) {
    parts.push('<h2>Tests</h2>');
    parts.push(
      `<table class="tally"><thead><tr><th>component</th><th>total</th><th>passed</th><th>failed</th><th>skipped</th><th>coverage</th></tr></thead><tbody>` +
        prepared.components.map(testRowHtml).join('') +
        `</tbody></table>`,
    );
  }

  parts.push('<h2>Every component</h2>');
  for (const c of prepared.components) parts.push(componentHtml(c, prepared.budget.maxPathsPerList));

  const logBlocks: string[] = [];
  for (const c of prepared.components) {
    for (const [key, text] of c.logs) {
      logBlocks.push(
        `<details><summary>${escapeHtml(key)} — output tail</summary><pre><code>${escapeHtml(text)}</code></pre></details>`,
      );
    }
  }
  if (logBlocks.length > 0) {
    parts.push('<h2>Output from producers that did not complete</h2>');
    parts.push(...logBlocks);
  }

  parts.push(leftOutHtml(prepared.ledger.all));
  parts.push('</main>');

  const body = parts.join('\n');
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(prepared.headline.sentence).slice(0, 200)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    body,
    '<footer>Generated by Vibes. This file is self-contained: it makes no network requests.</footer>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  // The gate. A report that phones home is worse than no report, because it is
  // a report a reviewer will trust.
  throwIfExternalRefs(html, 'report.html');

  return { html, bytes: byteLength(html), truncations: prepared.ledger.all };
}

/* ───────────────────────────── fragments ─────────────────────────────── */

function allFindings(prepared: PreparedReport): Finding[] {
  return [
    ...prepared.report.findings,
    ...prepared.report.components.flatMap((c) => [...c.findings]),
  ];
}

function isGovernance(f: Finding): boolean {
  return /^(governance|policy|weaken|corpus-shr|unreceipted)/.test(f.id);
}

function severityRank(f: Finding): number {
  return f.severity === 'error' ? 0 : f.severity === 'warn' ? 1 : 2;
}

function findingHtml(f: Finding): string {
  const paths =
    f.paths && f.paths.length > 0
      ? (() => {
          const { shown, hidden } = capList(f.paths, 10);
          return `<ul class="paths">${shown
            .map((p) => `<li><code>${escapeHtml(p)}</code></li>`)
            .join('')}${hidden > 0 ? `<li>and ${hidden} more</li>` : ''}</ul>`;
        })()
      : '';
  const where = f.component === undefined ? '' : ` <span class="state">${escapeHtml(f.component)}</span>`;
  return (
    `<div class="note ${f.severity}"><span class="sev ${f.severity}">${f.severity}</span> ` +
    `<strong>${escapeHtml(f.title)}</strong>${where}<br>${escapeHtml(f.detail)}${paths}</div>`
  );
}

function snapshotHtml(snap: PreparedSnapshot, open: boolean): string {
  const { result } = snap;
  const title = `<code>${escapeHtml(result.file)}</code> <span class="state">${escapeHtml(SNAP_STATE_LABEL[result.state])}</span>${verdictSuffix(result)}`;
  const body =
    snap.rendered === null
      ? '<p class="note warn"><span class="sev warn">note</span> Not diffed: no content was available for this file.</p>'
      : renderBlocksHtml(snap.rendered.blocks) +
        `<p class="meta-line">rendered by <code>${escapeHtml(snap.rendered.rendererId)}</code> (${escapeHtml(snap.rendered.via)})</p>`;
  return `<details${open ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
}

function verdictSuffix(result: SnapshotResult): string {
  const bits: string[] = [];
  if (result.verdict.summary) bits.push(escapeHtml(result.verdict.summary));
  if (result.verdict.mode === 'tolerance') {
    const util = result.verdict.epsilonUtilisation;
    bits.push(
      util === undefined
        ? 'compared with a tolerance'
        : `compared with a tolerance, ${Math.round(util * 100)}% of it consumed`,
    );
  }
  return bits.length > 0 ? ` <span class="meta-line">— ${bits.join('; ')}</span>` : '';
}

function testRowHtml(c: PreparedComponent): string {
  const tests = c.result.tests;
  const coverage =
    c.result.coverage === null
      ? 'not configured'
      : `${c.result.coverage.files.length} files${c.result.coverage.stale ? ' (stale)' : ''}`;
  const name = `${escapeHtml(c.result.component)}${tests?.stale === true ? ' (stale artifact)' : ''}`;
  if (tests === null) {
    return `<tr><td>${name}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>${escapeHtml(coverage)}</td></tr>`;
  }
  return `<tr><td>${name}</td><td>${tests.total}</td><td>${tests.passed}</td><td>${tests.failed}</td><td>${tests.skipped}</td><td>${escapeHtml(coverage)}</td></tr>`;
}

function componentHtml(c: PreparedComponent, maxPaths: number): string {
  const counts = new Map<string, number>();
  for (const s of c.result.snapshots) counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
  const chips = [...counts.entries()]
    .map(
      ([state, n]) =>
        `<span class="state">${n} ${escapeHtml(SNAP_STATE_LABEL[state as keyof typeof SNAP_STATE_LABEL] ?? state)}</span>`,
    )
    .join(' ');

  const tests = c.result.tests;
  const testLine =
    tests === null
      ? 'tests: none ingested'
      : `tests: ${tests.passed}/${tests.total} passed, ${tests.failed} failed, ${tests.skipped} skipped${tests.stale ? ' (artifact is stale)' : ''}`;
  const coverageLine =
    c.result.coverage === null
      ? 'coverage: not configured'
      : `coverage: ${c.result.coverage.files.length} files${c.result.coverage.stale ? ' (stale)' : ''}`;

  const notRun = c.result.producers.filter((p) => p.outcome !== 'ok' && p.outcome !== 'not-selected');
  const notRunHtml = notRun
    .map(
      (p) =>
        `<li><code>${escapeHtml(p.producer)}</code>: <strong>${escapeHtml(p.outcome)}</strong> — nothing about its snapshots is known from this run</li>`,
    )
    .join('');

  const unclaimed =
    c.result.unclaimedPaths.length > 0
      ? (() => {
          const { shown, hidden } = capList(c.result.unclaimedPaths, maxPaths);
          return `<p>Changed but claimed by no witness glob:</p><ul class="paths">${shown
            .map((p) => `<li><code>${escapeHtml(p)}</code></li>`)
            .join('')}${hidden > 0 ? `<li>and ${hidden} more</li>` : ''}</ul>`;
        })()
      : '';

  return (
    `<h3>${escapeHtml(c.result.component)} — ${escapeHtml(COMPONENT_STATE_LABEL[c.result.state])}</h3>` +
    `<p>${chips}</p><p class="meta-line">${escapeHtml(testLine)} · ${escapeHtml(coverageLine)}</p>` +
    (notRunHtml.length > 0 ? `<ul class="paths">${notRunHtml}</ul>` : '') +
    unclaimed
  );
}

function leftOutHtml(truncations: readonly Truncation[]): string {
  if (truncations.length === 0) {
    return '<h2>What was left out</h2><p>Nothing. Every section fit inside the report budget.</p>';
  }
  return (
    '<h2>What was left out</h2><ul class="paths">' +
    truncations
      .map(
        (t) =>
          `<li>${escapeHtml(t.what)} — in ${escapeHtml(t.where)} <code>${escapeHtml(t.limit)}</code></li>`,
      )
      .join('') +
    '</ul><p>Raise the named limit, or read <code>report.json</code>, which is never truncated.</p>'
  );
}
