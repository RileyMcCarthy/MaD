/**
 * The markdown surface: `report.md` and `$GITHUB_STEP_SUMMARY`.
 *
 * This is the PRIMARY surface. The HTML is prettier, but markdown is what a
 * reviewer sees without downloading an artifact, so when the budget forces a
 * choice, markdown keeps the findings and drops the decoration.
 *
 * Two CommonMark details that are bugs if you get them wrong, both handled:
 *  - a fence must be LONGER than any backtick run inside it, or a snapshot line
 *    containing ``` ends the block early and the rest of the diff renders as
 *    prose — which looks exactly like a shorter diff;
 *  - `<details>` needs a BLANK LINE after `</summary>`, or the whole block is
 *    treated as raw HTML and the nested fence never renders.
 */

import type { Finding, RunReport, SnapshotResult } from '../types.js';
import type { RenderBlock } from '../render/index.js';
import type { Truncation } from './budget.js';
import { capList } from './budget.js';
import { byteLength, escapeMarkdownInline, fenceFor, markdownCell } from './escape.js';
import type { PreparedComponent, PreparedReport, PreparedSnapshot } from './prepare.js';
import {
  assertHeadlineInvariant,
  COMPONENT_STATE_LABEL,
  DISCLOSURE_SENTENCE,
  SNAP_STATE_LABEL,
} from './headline.js';
import { sparklineText } from './sparkline.js';

/* ─────────────────────────── block rendering ─────────────────────────── */

export function renderBlocksMarkdown(blocks: readonly RenderBlock[]): string {
  return blocks.map(renderBlockMarkdown).filter((s) => s.length > 0).join('\n\n');
}

function renderBlockMarkdown(block: RenderBlock): string {
  switch (block.kind) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.text}`;
    case 'text':
      return block.text;
    case 'kv':
      return block.entries
        .map(([k, v]) => `- **${escapeMarkdownInline(k)}**: ${escapeMarkdownInline(v)}`)
        .join('\n');
    case 'code': {
      const fence = fenceFor(block.text);
      return `${fence}${block.lang ?? ''}\n${block.text}\n${fence}`;
    }
    case 'diff': {
      const lines: string[] = [];
      for (const h of block.patch.hunks) {
        lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
        for (const l of h.lines) lines.push(l);
      }
      const body = lines.join('\n');
      const fence = fenceFor(body);
      const tail = block.patch.truncated
        ? `\n\n_${block.patch.droppedLines} further changed lines are not shown._`
        : '';
      return `${fence}diff\n${body}\n${fence}${tail}`;
    }
    case 'table': {
      const header = `| ${block.columns.map(markdownCell).join(' | ')} |`;
      const sep = `| ${block.columns
        .map((_, i) => ((block.align?.[i] ?? 'left') === 'right' ? '---:' : ':---'))
        .join(' | ')} |`;
      const rows = block.rows.map((r) => `| ${r.map(markdownCell).join(' | ')} |`);
      return [header, sep, ...rows].join('\n');
    }
    case 'series': {
      const eps = block.epsilon === undefined ? '' : ` · epsilon ${block.epsilon}`;
      const unit = block.unit === undefined ? '' : ` (${block.unit})`;
      // A code fence keeps the two rows in a monospace column so they line up.
      const chart = ['baseline ' + sparklineText(block.old), 'produced ' + sparklineText(block.new)]
        .filter((l) => l.trim().length > 9)
        .join('\n');
      const head = `**${escapeMarkdownInline(block.label)}**${unit}${eps}`;
      return chart.length > 0 ? `${head}\n\n\`\`\`\n${chart}\n\`\`\`` : head;
    }
    case 'note': {
      const marker =
        block.level === 'error' ? '**error**' : block.level === 'warn' ? '**warning**' : '**note**';
      return block.text
        .split('\n')
        .map((l, i) => (i === 0 ? `> ${marker} — ${l}` : `> ${l}`))
        .join('\n');
    }
    case 'details': {
      const inner = renderBlocksMarkdown(block.children);
      // The blank line after </summary> is mandatory. See the file header.
      return [
        `<details${block.open === true ? ' open' : ''}>`,
        `<summary>${escapeMarkdownInline(block.summary)}</summary>`,
        '',
        inner,
        '',
        '</details>',
      ].join('\n');
    }
  }
}

/* ────────────────────────── section assembly ─────────────────────────── */

interface MdSection {
  readonly id: string;
  /** Required sections are never dropped whole; only their lists truncate. */
  readonly required: boolean;
  readonly head: string;
  readonly items: readonly string[];
  readonly overflow: (n: number) => string;
  /**
   * Separator between this section's head and its items. Defaults to a blank
   * line. A markdown TABLE must be '\n': one blank line between the header row
   * and the body ends the table, and the rows then render as literal pipes.
   */
  readonly joinWith?: string;
}

export interface MarkdownResult {
  readonly text: string;
  readonly truncations: readonly Truncation[];
  readonly bytes: number;
}

/** Bytes held back so the "what was left out" footer always fits. */
const FOOTER_RESERVE = 2_500;

export function buildMarkdown(prepared: PreparedReport, maxBytes?: number): MarkdownResult {
  const limit = (maxBytes ?? prepared.budget.markdownMaxBytes) - FOOTER_RESERVE;
  const sections = buildSections(prepared);

  const parts: string[] = [];
  let used = 0;

  for (const section of sections) {
    const sep = section.joinWith ?? '\n\n';
    const headCost = byteLength(section.head) + 2;
    if (!section.required && used + headCost > limit) {
      prepared.ledger.record({
        where: `markdown section "${section.id}"`,
        what: `the whole ${section.id} section`,
        limit: `report.markdownMaxBytes=${prepared.budget.markdownMaxBytes}`,
      });
      continue;
    }
    const chunks: string[] = [];
    const push = (chunk: string): void => {
      chunks.push(chunk);
      used += byteLength(chunk) + sep.length;
    };
    if (section.head.length > 0) push(section.head);
    let dropped = 0;
    for (const item of section.items) {
      if (dropped > 0 || used + byteLength(item) + sep.length > limit) {
        dropped += 1;
        continue;
      }
      push(item);
    }
    if (dropped > 0) {
      // The overflow marker is appended with a blank line even inside a table,
      // because it is prose and would otherwise become a malformed row.
      chunks.push(`${sep === '\n' ? '\n' : ''}${section.overflow(dropped)}`);
      prepared.ledger.record({
        where: `markdown section "${section.id}"`,
        what: `${dropped} ${dropped === 1 ? 'entry' : 'entries'} in ${section.id}`,
        limit: `report.markdownMaxBytes=${prepared.budget.markdownMaxBytes}`,
      });
    }
    if (chunks.length > 0) parts.push(chunks.join(sep));
  }

  parts.push(leftOutSection(prepared.ledger.all));
  const text = `${parts.join('\n\n')}\n`;
  return { text, truncations: prepared.ledger.all, bytes: byteLength(text) };
}

function buildSections(prepared: PreparedReport): MdSection[] {
  const { report, tally: t } = prepared;
  const sections: MdSection[] = [];

  /* 1 — header. The headline is the H1 and nothing else may be. */
  assertHeadlineInvariant(prepared.headline.sentence, report.fullyVerified);
  sections.push({
    id: 'header',
    required: true,
    head: [
      `# ${prepared.headline.sentence}`,
      '',
      `\`${report.baseSha.slice(0, 8)}\` → \`${report.headSha.slice(0, 8)}\` · base \`${report.baseRef}\` · ${(report.durationMs / 1000).toFixed(1)}s · ${prepared.generatedAt}`,
    ].join('\n'),
    items: [],
    overflow: () => '',
  });

  /* 2 — coverage banner. The disclosure lives here, never collapsed. */
  const bannerLines: string[] = [
    '## What this run measured',
    '',
    `> ${DISCLOSURE_SENTENCE}`,
    '',
    `| producers | ran | did not complete | not selected |`,
    `| :--- | ---: | ---: | ---: |`,
    `| ${t.producersTotal} | ${t.producersOk} | ${t.producersFailed} | ${t.producersNotSelected} |`,
    '',
    `| snapshot files | ${SNAP_STATE_LABEL['verified-unchanged']} | changed | added | deleted | not selected | not run |`,
    `| ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    `| ${t.totalSnapshots} | ${t.states['verified-unchanged']} | ${t.states.changed} | ${t.states.added} | ${t.states.deleted} | ${t.states['not-selected']} | ${t.states['not-run']} |`,
  ];
  if (prepared.contentUnavailable) {
    bannerLines.push(
      '',
      '> **note** — no snapshot content was supplied to the emitter, so this report lists what moved without showing the diffs.',
    );
  }
  if (t.componentsNotConfigured.length > 0) {
    bannerLines.push(
      '',
      `**Not configured for behaviour snapshots:** ${t.componentsNotConfigured.join(', ')}. These components are named rather than omitted — an omitted component renders as silence, and silence reads as "fine".`,
    );
  }
  sections.push({
    id: 'coverage',
    required: true,
    head: bannerLines.join('\n'),
    items: [],
    overflow: () => '',
  });

  /* 3 — governance / policy drift, ABOVE behaviour (config-spec §6). */
  const governance = allFindings(report).filter((f) => isGovernance(f));
  if (governance.length > 0) {
    sections.push({
      id: 'governance',
      required: true,
      head: '## Governance changes\n\nThese changed what the tool is allowed to notice. Read them before the behaviour section.',
      items: governance.map(findingMarkdown),
      overflow: (n) => `_${n} further governance ${n === 1 ? 'finding' : 'findings'} omitted for length._`,
    });
  }

  /* 4 — findings. */
  const findings = allFindings(report).filter((f) => !isGovernance(f));
  if (findings.length > 0) {
    const ordered = [...findings].sort((a, b) => severityRank(a) - severityRank(b));
    sections.push({
      id: 'findings',
      required: true,
      head: `## Findings (${ordered.length})`,
      items: ordered.map(findingMarkdown),
      overflow: (n) => `_${n} further ${n === 1 ? 'finding' : 'findings'} omitted for length._`,
    });
  }

  /* 5 — changed snapshots: the product. */
  const changedItems: string[] = [];
  let expanded = 0;
  for (const c of prepared.components) {
    const moved = c.rendered.filter((s) => s.result.state !== 'verified-unchanged');
    if (moved.length === 0) continue;
    changedItems.push(`### ${c.result.component}`);
    for (const snap of moved) {
      const open = expanded < prepared.budget.expandFirstNFiles;
      changedItems.push(snapshotMarkdown(snap, open));
      expanded += 1;
    }
    if (c.unrenderedCount > 0) {
      changedItems.push(
        `_${c.unrenderedCount} further changed ${c.unrenderedCount === 1 ? 'file was' : 'files were'} listed but not diffed._`,
      );
    }
  }
  if (changedItems.length > 0) {
    sections.push({
      id: 'changed',
      required: false,
      head: '## What moved',
      items: changedItems,
      overflow: (n) => `_${n} further ${n === 1 ? 'entry' : 'entries'} omitted for length._`,
    });
  }

  /* 6 — tests. */
  const testRows = prepared.components.map((c) => testRow(c));
  if (testRows.some((r) => r !== null)) {
    sections.push({
      id: 'tests',
      required: false,
      head: [
        '## Tests',
        '',
        '| component | total | passed | failed | skipped | coverage |',
        '| :--- | ---: | ---: | ---: | ---: | :--- |',
      ].join('\n'),
      items: testRows.filter((r): r is string => r !== null),
      overflow: (n) => `_${n} further ${n === 1 ? 'component' : 'components'} omitted for length._`,
      joinWith: '\n',
    });
  }

  /* 7 — the roster. Explicitly includes the states nobody wants to read. */
  const rosterItems = prepared.components.map((c) => rosterLine(c, prepared.budget.maxPathsPerList));
  sections.push({
    id: 'roster',
    required: false,
    head: '## Every component',
    items: rosterItems,
    overflow: (n) => `_${n} further ${n === 1 ? 'component' : 'components'} omitted for length._`,
  });

  /* 8 — producer logs, only for producers that did not complete. */
  const logItems: string[] = [];
  for (const c of prepared.components) {
    for (const [key, text] of c.logs) {
      const fence = fenceFor(text);
      logItems.push(
        [
          `<details>`,
          `<summary>${escapeMarkdownInline(key)} — output tail</summary>`,
          '',
          `${fence}\n${text}\n${fence}`,
          '',
          '</details>',
        ].join('\n'),
      );
    }
  }
  if (logItems.length > 0) {
    sections.push({
      id: 'logs',
      required: false,
      head: '## Output from producers that did not complete',
      items: logItems,
      overflow: (n) => `_${n} further ${n === 1 ? 'log' : 'logs'} omitted for length._`,
    });
  }

  return sections;
}

/* ───────────────────────────── fragments ─────────────────────────────── */

function allFindings(report: RunReport): Finding[] {
  return [...report.findings, ...report.components.flatMap((c) => [...c.findings])];
}

/** Convention: governance findings are id-prefixed. Documented in the README. */
function isGovernance(f: Finding): boolean {
  return /^(governance|policy|weaken|corpus-shr|unreceipted)/.test(f.id);
}

function severityRank(f: Finding): number {
  return f.severity === 'error' ? 0 : f.severity === 'warn' ? 1 : 2;
}

function findingMarkdown(f: Finding): string {
  const label = f.severity === 'error' ? '**error**' : f.severity === 'warn' ? '**warning**' : '**note**';
  const where = f.component === undefined ? '' : ` · \`${f.component}\``;
  const lines = [`- ${label} — **${escapeMarkdownInline(f.title)}**${where}`, `  ${f.detail}`];
  if (f.paths && f.paths.length > 0) {
    const { shown, hidden } = capList(f.paths, 10);
    lines.push(`  ${shown.map((p) => `\`${p}\``).join(', ')}${hidden > 0 ? ` and ${hidden} more` : ''}`);
  }
  return lines.join('\n');
}

function snapshotMarkdown(snap: PreparedSnapshot, open: boolean): string {
  const { result } = snap;
  const summary = `\`${result.file}\` — ${SNAP_STATE_LABEL[result.state]}${verdictSuffix(result)}`;
  const body =
    snap.rendered === null
      ? '_Not diffed: no content was available for this file._'
      : renderBlocksMarkdown(snap.rendered.blocks);
  const provenance =
    snap.rendered === null ? '' : `\n\n_rendered by \`${snap.rendered.rendererId}\` (${snap.rendered.via})_`;
  if (open) {
    return `#### ${summary}\n\n${body}${provenance}`;
  }
  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    body + provenance,
    '',
    '</details>',
  ].join('\n');
}

function verdictSuffix(result: SnapshotResult): string {
  const bits: string[] = [];
  if (result.verdict.summary) bits.push(result.verdict.summary);
  if (result.verdict.mode === 'tolerance') {
    const util = result.verdict.epsilonUtilisation;
    // The epsilon's provenance matters more than its value: it is a number the
    // same agent wrote in the same PR.
    bits.push(
      util === undefined
        ? 'compared with a tolerance'
        : `compared with a tolerance, ${Math.round(util * 100)}% of it consumed`,
    );
  }
  return bits.length > 0 ? ` — ${bits.join('; ')}` : '';
}

function testRow(c: PreparedComponent): string | null {
  const tests = c.result.tests;
  const coverage =
    c.result.coverage === null
      ? 'not configured'
      : `${c.result.coverage.files.length} files${c.result.coverage.stale ? ' (stale)' : ''}`;
  if (tests === null) {
    return `| ${c.result.component} | — | — | — | — | ${coverage} |`;
  }
  const stale = tests.stale ? ' ⚠ stale' : '';
  return `| ${c.result.component}${stale} | ${tests.total} | ${tests.passed} | ${tests.failed} | ${tests.skipped} | ${coverage} |`;
}

function rosterLine(c: PreparedComponent, maxPaths: number): string {
  const counts = new Map<string, number>();
  for (const s of c.result.snapshots) {
    counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(
    ([state, n]) => `${n} ${SNAP_STATE_LABEL[state as keyof typeof SNAP_STATE_LABEL] ?? state}`,
  );
  const lines = [
    `- **${c.result.component}** — ${COMPONENT_STATE_LABEL[c.result.state]}${parts.length > 0 ? `: ${parts.join(' · ')}` : ''}`,
  ];
  if (c.result.unclaimedPaths.length > 0) {
    const { shown, hidden } = capList(c.result.unclaimedPaths, maxPaths);
    lines.push(
      `  - changed but claimed by no witness glob: ${shown.map((p) => `\`${p}\``).join(', ')}${hidden > 0 ? ` and ${hidden} more` : ''}`,
    );
  }
  const notRun = c.result.producers.filter((p) => p.outcome !== 'ok' && p.outcome !== 'not-selected');
  for (const p of notRun) {
    lines.push(`  - producer \`${p.producer}\`: **${p.outcome}** — nothing about its snapshots is known from this run`);
  }
  return lines.join('\n');
}

function leftOutSection(truncations: readonly Truncation[]): string {
  if (truncations.length === 0) {
    return '## What was left out\n\nNothing. Every section fit inside the report budget.';
  }
  const lines = ['## What was left out', ''];
  for (const t of truncations) {
    lines.push(`- ${t.what} — in ${t.where} (${t.limit})`);
  }
  lines.push(
    '',
    '_Raise the named limit, or read `report.json`, which is never truncated._',
  );
  return lines.join('\n');
}
