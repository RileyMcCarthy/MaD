/**
 * The prepared model both emitters consume.
 *
 * WHY a shared intermediate and not two renderers: markdown and HTML must say
 * the SAME THING. Two hand-maintained templates drift, and the drift is
 * invisible — one surface quietly stops mentioning `not-run` and the other
 * keeps it, and which one a reviewer opens decides what they learn. Blocks are
 * produced once, here; the emitters only choose typography.
 */

import { readFile } from 'node:fs/promises';
import type {
  ComponentResult,
  ProducerResult,
  RepoPath,
  RunReport,
  SnapshotResult,
} from '../types.js';
import type { RenderedSnapshot, RendererRegistry, RenderLimits, SnapshotFileRef } from '../render/index.js';
import { DEFAULT_RENDER_LIMITS, defaultRegistry, renderSnapshot } from '../render/index.js';
import type { EmitBudget } from './budget.js';
import { DEFAULT_EMIT_BUDGET, tailBytes, TruncationLedger } from './budget.js';
import type { Headline, ReportTally } from './headline.js';
import { headline, tally } from './headline.js';

export interface SnapshotContent {
  readonly baseline: Buffer | null;
  readonly received: Buffer | null;
}

/**
 * Supplies snapshot bytes. Injected rather than read here, because the bytes
 * come from two different places — a git blob at `base` and the gitignored
 * received dir — and neither is this module's business to know about.
 */
export type SnapshotContentProvider = (
  ref: SnapshotFileRef,
) => Promise<SnapshotContent> | SnapshotContent;

export interface PreparedSnapshot {
  readonly result: SnapshotResult;
  readonly ref: SnapshotFileRef;
  /** Null when no content provider was supplied, or it returned nothing. */
  readonly rendered: RenderedSnapshot | null;
}

export interface PreparedComponent {
  readonly result: ComponentResult;
  /** changed / added / deleted, in that order, capped by the budget. */
  readonly rendered: readonly PreparedSnapshot[];
  readonly unrenderedCount: number;
  readonly logs: ReadonlyMap<string, string>;
}

export interface PreparedReport {
  readonly report: RunReport;
  readonly tally: ReportTally;
  readonly headline: Headline;
  readonly title: string;
  readonly generatedAt: string;
  readonly components: readonly PreparedComponent[];
  readonly budget: EmitBudget;
  readonly ledger: TruncationLedger;
  /** Notes from the render pass: shadowed bindings, truncated diffs, failures. */
  readonly renderNotes: readonly string[];
  /** True when no content provider was supplied — the report says so. */
  readonly contentUnavailable: boolean;
}

export interface PrepareOptions {
  readonly title?: string;
  readonly budget?: EmitBudget;
  readonly limits?: RenderLimits;
  readonly registry?: RendererRegistry;
  readonly content?: SnapshotContentProvider;
  /**
   * Maps a snapshot to its repo-relative committed path. Renderer globs and
   * report rows must use ONE path universe; the composer knows the baseline dir
   * and this module does not.
   */
  readonly repoPathFor?: (s: SnapshotResult) => RepoPath;
  readonly readLog?: (path: string) => Promise<string | null>;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

const RENDERABLE = new Set(['changed', 'added', 'deleted']);

export async function prepare(
  report: RunReport,
  options: PrepareOptions = {},
): Promise<PreparedReport> {
  const budget = options.budget ?? DEFAULT_EMIT_BUDGET;
  const limits = options.limits ?? DEFAULT_RENDER_LIMITS;
  const registry = options.registry ?? defaultRegistry();
  const ledger = new TruncationLedger(options.log);
  const repoPathFor = options.repoPathFor ?? ((s: SnapshotResult) => s.file);
  const readLogFile = options.readLog ?? defaultReadLog;
  const renderNotes: string[] = [];

  const t = tally(report);
  const head = headline(report, t);

  let renderBudgetLeft = budget.maxRenderedFiles;
  const components: PreparedComponent[] = [];

  for (const component of report.components) {
    const candidates = component.snapshots.filter((s) => RENDERABLE.has(s.state));
    const take = options.content ? Math.max(0, Math.min(candidates.length, renderBudgetLeft)) : 0;
    const rendered: PreparedSnapshot[] = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const result = candidates[i];
      if (result === undefined) continue;
      const ref: SnapshotFileRef = {
        component: result.component,
        producer: result.producer,
        file: result.file,
        repoPath: repoPathFor(result),
        state: result.state,
        verdict: result.verdict,
        bytes: result.bytes,
      };
      if (i >= take) {
        rendered.push({ result, ref, rendered: null });
        continue;
      }
      let content: SnapshotContent = { baseline: null, received: null };
      try {
        content = await (options.content as SnapshotContentProvider)(ref);
      } catch (err) {
        renderNotes.push(`${ref.repoPath}: could not read content (${errText(err)})`);
      }
      const r = await renderSnapshot({ ref, ...content }, { registry, limits });
      for (const n of r.notes) renderNotes.push(n);
      rendered.push({ result, ref, rendered: r });
    }

    renderBudgetLeft -= take;
    const unrendered = candidates.length - take;
    if (unrendered > 0 && options.content) {
      ledger.record({
        where: `component ${component.component}`,
        what: `${unrendered} changed snapshot ${unrendered === 1 ? 'file is' : 'files are'} listed but not diffed`,
        limit: `budget.maxRenderedFiles=${budget.maxRenderedFiles}`,
      });
    }

    components.push({
      result: component,
      rendered,
      unrenderedCount: unrendered,
      logs: await collectLogs(component.producers, budget, readLogFile, ledger),
    });
  }

  const now = options.now ? options.now() : new Date();
  return {
    report,
    tally: t,
    headline: head,
    title: options.title ?? 'Vibes behaviour report',
    generatedAt: now.toISOString(),
    components,
    budget,
    ledger,
    renderNotes,
    contentUnavailable: options.content === undefined,
  };
}

async function collectLogs(
  producers: readonly ProducerResult[],
  budget: EmitBudget,
  read: (p: string) => Promise<string | null>,
  ledger: TruncationLedger,
): Promise<ReadonlyMap<string, string>> {
  const logs = new Map<string, string>();
  for (const p of producers) {
    // Only failed producers. A successful producer's stdout is noise, and the
    // budget it would eat belongs to the diffs.
    if (p.outcome === 'ok' || p.outcome === 'not-selected') continue;
    const path = p.stderrPath ?? p.stdoutPath;
    if (path === null) continue;
    const text = await read(path);
    if (text === null) continue;
    const { text: tail, dropped } = tailBytes(stripTrailing(text), budget.maxLogTailBytes);
    if (dropped > 0) {
      ledger.record({
        where: `producer log ${p.component}/${p.producer}`,
        what: `${dropped} bytes of log output before the tail shown`,
        limit: `budget.maxLogTailBytes=${budget.maxLogTailBytes}`,
      });
    }
    logs.set(`${p.component}/${p.producer}`, tail);
  }
  return logs;
}

async function defaultReadLog(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function stripTrailing(text: string): string {
  return text.replace(/\s+$/, '');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
