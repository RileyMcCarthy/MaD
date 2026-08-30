/**
 * `emitReport` — writes every configured surface, in the order that matters.
 *
 * JSON is written FIRST and is never truncated. Every other surface has a byte
 * budget and can lose content; the JSON is the one place a reader can always go
 * to find what the budget cut. Writing it first also means a crash while
 * rendering the HTML still leaves a complete machine-readable record.
 *
 * The truncation ledger is RUN-scoped, not surface-scoped: every entry names
 * the surface it happened in, and both reports print the whole list. A reader
 * of the HTML should learn that the markdown dropped a section, because the
 * markdown is what their colleague will read in the PR. The markdown is built
 * exactly once here and reused for the step summary, so nothing double-records.
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReportFormat, RunReport } from '../types.js';
import type { EmitBudget, Truncation } from './budget.js';
import { DEFAULT_EMIT_BUDGET } from './budget.js';
import { byteLength } from './escape.js';
import { buildHtml } from './html.js';
import { buildMarkdown } from './markdown.js';
import type { PrepareOptions, PreparedReport } from './prepare.js';
import { prepare } from './prepare.js';

export interface EmitOptions extends PrepareOptions {
  /** Directory for report.{json,md,html}. Created if absent. */
  readonly outDir: string;
  readonly formats?: readonly ReportFormat[];
  readonly budget?: EmitBudget;
  /** Append the markdown to `$GITHUB_STEP_SUMMARY` when it is set. */
  readonly githubStepSummary?: boolean;
  /** Override for tests. Defaults to `process.env.GITHUB_STEP_SUMMARY`. */
  readonly stepSummaryPath?: string | null;
  readonly log?: (line: string) => void;
}

export interface EmitResult {
  readonly files: readonly string[];
  readonly headline: string;
  readonly truncations: readonly Truncation[];
  readonly stepSummaryWritten: boolean;
  readonly bytes: Readonly<Record<string, number>>;
}

const DEFAULT_FORMATS: readonly ReportFormat[] = ['json', 'md', 'html'];

export async function emitReport(
  report: RunReport,
  options: EmitOptions,
): Promise<EmitResult> {
  const budget = options.budget ?? DEFAULT_EMIT_BUDGET;
  const prepared = await prepare(report, { ...options, budget });
  return emitPrepared(prepared, options);
}

/** Exposed so a caller that already prepared (e.g. to inspect blocks) can reuse it. */
export async function emitPrepared(
  prepared: PreparedReport,
  options: EmitOptions,
): Promise<EmitResult> {
  const formats = new Set(options.formats ?? DEFAULT_FORMATS);
  const files: string[] = [];
  const bytes: Record<string, number> = {};
  await mkdir(options.outDir, { recursive: true });

  if (formats.has('json')) {
    const path = join(options.outDir, 'report.json');
    const text = `${JSON.stringify(prepared.report, null, 2)}\n`;
    await writeFile(path, text, 'utf8');
    files.push(path);
    bytes['report.json'] = byteLength(text);
  }

  // Markdown is built even when only HTML was asked for IF the step summary is
  // wanted — the summary surface is markdown and nothing else.
  const wantsMarkdown = formats.has('md');
  const wantsSummary = (options.githubStepSummary ?? true) && resolveSummaryPath(options) !== null;
  let markdownText: string | null = null;
  if (wantsMarkdown || wantsSummary) {
    markdownText = buildMarkdown(prepared).text;
  }

  if (wantsMarkdown && markdownText !== null) {
    const path = join(options.outDir, 'report.md');
    await writeFile(path, markdownText, 'utf8');
    files.push(path);
    bytes['report.md'] = byteLength(markdownText);
  }

  if (formats.has('html')) {
    const path = join(options.outDir, 'report.html');
    const built = buildHtml(prepared);
    await writeFile(path, built.html, 'utf8');
    files.push(path);
    bytes['report.html'] = built.bytes;
  }

  let stepSummaryWritten = false;
  const summaryPath = resolveSummaryPath(options);
  if (wantsSummary && summaryPath !== null && markdownText !== null) {
    // $GITHUB_STEP_SUMMARY caps at 1 MiB and silently drops the WHOLE summary
    // past it. The failure is total, not partial, so the cut is made here with
    // a visible marker rather than discovered as a blank job summary.
    let text = markdownText;
    if (byteLength(text) > prepared.budget.stepSummaryMaxBytes) {
      const buf = Buffer.from(text, 'utf8').subarray(0, prepared.budget.stepSummaryMaxBytes - 200);
      text = `${buf.toString('utf8')}\n\n_Step summary truncated at ${prepared.budget.stepSummaryMaxBytes} bytes; the full report is in the uploaded artifact._\n`;
      prepared.ledger.record({
        where: 'GitHub step summary',
        what: 'the tail of the markdown report',
        limit: `report.stepSummaryMaxBytes=${prepared.budget.stepSummaryMaxBytes}`,
      });
      options.log?.('vibes: step summary truncated');
    }
    try {
      await appendFile(summaryPath, `${text}\n`, 'utf8');
      stepSummaryWritten = true;
    } catch (err) {
      // Never fatal: a report that exists on disk but could not be appended to
      // a CI surface is still a report.
      options.log?.(
        `vibes: could not write $GITHUB_STEP_SUMMARY (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  return {
    files,
    headline: prepared.headline.sentence,
    truncations: prepared.ledger.all,
    stepSummaryWritten,
    bytes,
  };
}

function resolveSummaryPath(options: EmitOptions): string | null {
  if (options.stepSummaryPath !== undefined) return options.stepSummaryPath;
  const fromEnv = process.env['GITHUB_STEP_SUMMARY'];
  return fromEnv === undefined || fromEnv.length === 0 ? null : fromEnv;
}
