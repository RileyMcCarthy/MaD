/**
 * vitest `--reporter=json`.
 *
 * Shape verified by running vitest 2.1.9 (the version Software/Control pins)
 * and reading the output:
 *
 *   { numTotalTests, numPassedTests, numFailedTests, numPendingTests,
 *     numTodoTests, numTotalTestSuites, startTime,
 *     testResults: [ { name: "<ABSOLUTE path>", startTime, endTime, status,
 *                      assertionResults: [ { ancestorTitles: [], fullName,
 *                                            title, status, duration?,
 *                                            failureMessages: [] } ] } ] }
 *
 * Three facts that shape this adapter, all observed rather than assumed:
 *
 *  - `name` is ABSOLUTE, so it must be relativised against a realpath'd repo
 *    root (on macOS `/tmp` is a symlink to `/private/tmp`, so the two forms of
 *    the same directory do not share a prefix).
 *  - a SKIPPED assertion has NO `duration` key at all — not 0. `durationMs`
 *    must be null there, because 0 ms would read as "ran instantly".
 *  - `numTotalTestSuites` counts DESCRIBE BLOCKS (71 for Control's 20 files),
 *    so it must never be surfaced as a file count. This adapter does not
 *    surface it at all.
 */

import type { RepoPath, TestCaseResult, TestSummary } from '../../types.js';
import { createRelativizer } from '../paths.js';
import {
  AdapterParseError,
  capMessage,
  type ParseNote,
  type TestParseOptions,
  type TestParseResult,
} from './shared.js';

interface VitestAssertion {
  readonly ancestorTitles?: readonly unknown[];
  readonly fullName?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly duration?: unknown;
  readonly failureMessages?: readonly unknown[];
}

interface VitestFileResult {
  readonly name?: unknown;
  readonly startTime?: unknown;
  readonly endTime?: unknown;
  readonly status?: unknown;
  readonly message?: unknown;
  readonly assertionResults?: readonly unknown[];
}

interface VitestJson {
  readonly numTotalTests?: unknown;
  readonly numPassedTests?: unknown;
  readonly numFailedTests?: unknown;
  readonly numPendingTests?: unknown;
  readonly numTodoTests?: unknown;
  readonly startTime?: unknown;
  readonly testResults?: readonly unknown[];
}

export function parseVitestJson(text: string, opts: TestParseOptions): TestParseResult {
  let doc: VitestJson;
  try {
    doc = JSON.parse(text) as VitestJson;
  } catch (err) {
    throw new AdapterParseError(`vitest JSON parse failed: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.testResults)) {
    throw new AdapterParseError('not a vitest JSON report: no testResults array');
  }

  const relativize = createRelativizer(opts.repoRoot);
  const notes: ParseNote[] = [];
  const cases: TestCaseResult[] = [];
  let unmappedFiles = 0;
  let latestEnd: number | null = null;

  for (const raw of doc.testResults) {
    if (raw === null || typeof raw !== 'object') continue;
    const fileResult = raw as VitestFileResult;
    const absName = typeof fileResult.name === 'string' ? fileResult.name : undefined;
    let file: RepoPath | undefined;
    if (absName !== undefined) {
      const rel = relativize(absName);
      if (rel === null) unmappedFiles += 1;
      else if (opts.trackedPaths !== undefined && !opts.trackedPaths.has(rel)) unmappedFiles += 1;
      else file = rel;
    }
    const end = num(fileResult.endTime);
    if (end !== null) latestEnd = latestEnd === null ? end : Math.max(latestEnd, end);

    const assertions = Array.isArray(fileResult.assertionResults) ? fileResult.assertionResults : [];

    // A file that failed to COLLECT (import error, syntax error) has zero
    // assertions and a failing status. Dropping it would turn a build-breaking
    // failure into silence, so it becomes one synthetic failed case.
    if (assertions.length === 0 && String(fileResult.status ?? '') === 'failed') {
      const msg = typeof fileResult.message === 'string' ? fileResult.message : 'suite failed with no test results';
      cases.push({
        suite: file ?? absName ?? '<unknown file>',
        name: '<file failed to run>',
        status: 'failed',
        durationMs: null,
        message: capMessage(msg),
        ...(file !== undefined ? { file } : {}),
      });
      continue;
    }

    for (const a of assertions) {
      if (a === null || typeof a !== 'object') continue;
      const asrt = a as VitestAssertion;
      const ancestors = (asrt.ancestorTitles ?? []).filter((t): t is string => typeof t === 'string');
      const title = typeof asrt.title === 'string' ? asrt.title : String(asrt.fullName ?? '<unnamed>');
      const suite =
        ancestors.length > 0 ? ancestors.join(' > ') : (file ?? absName ?? '<unknown file>');
      const failureMessages = (asrt.failureMessages ?? []).filter((m): m is string => typeof m === 'string');
      const message = failureMessages.length > 0 ? capMessage(failureMessages.join('\n---\n')) : undefined;
      cases.push({
        suite,
        name: title,
        status: mapStatus(String(asrt.status ?? '')),
        // Absent duration (every skipped case) must stay null, never 0.
        durationMs: num(asrt.duration),
        ...(message !== undefined ? { message } : {}),
        ...(file !== undefined ? { file } : {}),
      });
    }
  }

  if (unmappedFiles > 0) {
    notes.push({
      reason: 'unmapped-paths',
      severity: 'info',
      detail: `${unmappedFiles} test file path(s) fell outside the repo root; per-file attribution dropped`,
    });
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.status === 'passed') passed += 1;
    else if (c.status === 'failed') failed += 1;
    else skipped += 1;
  }

  const start = num(doc.startTime);
  const durationMs = start !== null && latestEnd !== null && latestEnd >= start ? latestEnd - start : null;

  const summary: TestSummary = {
    total: cases.length,
    passed,
    failed,
    skipped,
    durationMs,
    cases,
    source: opts.sourceLabel,
    stale: opts.stale,
  };

  // The header counts and the case list are two independent claims in the same
  // file. When they disagree, we report the case list (which we can show) and
  // say the header disagreed.
  const declaredTotal = num(doc.numTotalTests);
  if (declaredTotal !== null && declaredTotal !== summary.total) {
    notes.push({
      reason: 'count-mismatch',
      severity: 'warn',
      detail: `numTotalTests=${declaredTotal} but ${summary.total} assertion result(s) present`,
    });
  }
  const declaredFailed = num(doc.numFailedTests);
  if (declaredFailed !== null && declaredFailed !== summary.failed) {
    notes.push({
      reason: 'count-mismatch',
      severity: 'warn',
      detail: `numFailedTests=${declaredFailed} but ${summary.failed} failed case(s) present`,
    });
  }

  return { summary, notes };
}

/**
 * vitest reports five statuses; TestCaseResult has three. `todo` and `pending`
 * both fold into `skipped` — they did not execute, and inventing a fourth
 * bucket downstream would be a contract change for no reporting gain.
 */
function mapStatus(s: string): TestCaseResult['status'] {
  switch (s) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
    case 'pending':
    case 'todo':
      return 'skipped';
    default:
      // An unknown status is not a pass. Under-claiming is the safe direction.
      return 'skipped';
  }
}

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}
