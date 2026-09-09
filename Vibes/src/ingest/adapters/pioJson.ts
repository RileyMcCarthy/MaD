/**
 * PlatformIO `pio test --json-output-path`.
 *
 * Shape read out of the installed PlatformIO source
 * (`platformio/test/reports/json.py` + `platformio/test/result.py`), not
 * guessed:
 *
 *   { version, project_dir, duration, testcase_nums, error_nums, failure_nums,
 *     skipped_nums,
 *     test_suites: [ { env_name, test_name, test_dir, status, duration,
 *                      timestamp, testcase_nums, error_nums, failure_nums,
 *                      skipped_nums,
 *                      test_cases: [ { name, status, message, stdout,
 *                                      duration, exception,
 *                                      source: { file, line } | null } ] } ] }
 *
 * Facts that matter, each with a bug attached to getting it wrong:
 *
 *  - `status` is the Python enum NAME: PASSED / FAILED / SKIPPED / ERRORED /
 *    WARNED. Lowercase comparison against 'passed' silently classifies
 *    everything as unknown.
 *  - suites with `testcase_nums === 0` are the env × test-dir CROSS PRODUCT.
 *    PlatformIO emits one per combination it did not run, each with status
 *    SKIPPED (see TestSuite.status: an empty suite reports SKIPPED). Counting
 *    them adds ~100 phantom skips to a 214-test firmware run.
 *  - `TestCase.duration` defaults to 0 and Unity supplies no per-test timing,
 *    so 0 means UNKNOWN here, not "instant". It maps to null.
 *  - the source key is `file`, not `filename` — the JSON writer renames it.
 */

import type { RepoPath, TestCaseResult, TestSummary } from '../../types.js';
import { createRelativizer, mapArtifactPath } from '../paths.js';
import {
  AdapterParseError,
  capMessage,
  secondsToMs,
  type ParseNote,
  type TestParseOptions,
  type TestParseResult,
} from './shared.js';

interface PioSource {
  readonly file?: unknown;
  readonly line?: unknown;
}

interface PioCase {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly message?: unknown;
  readonly stdout?: unknown;
  readonly duration?: unknown;
  readonly exception?: unknown;
  readonly source?: unknown;
}

interface PioSuite {
  readonly env_name?: unknown;
  readonly test_name?: unknown;
  readonly test_dir?: unknown;
  readonly status?: unknown;
  readonly duration?: unknown;
  readonly testcase_nums?: unknown;
  readonly test_cases?: readonly unknown[];
}

interface PioJson {
  readonly project_dir?: unknown;
  readonly duration?: unknown;
  readonly testcase_nums?: unknown;
  readonly test_suites?: readonly unknown[];
}

export function parsePioJson(text: string, opts: TestParseOptions): TestParseResult {
  let doc: PioJson;
  try {
    doc = JSON.parse(text) as PioJson;
  } catch (err) {
    throw new AdapterParseError(`pio JSON parse failed: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.test_suites)) {
    throw new AdapterParseError('not a PlatformIO test report: no test_suites array');
  }

  const relativize = createRelativizer(opts.repoRoot);
  // `source.file` is written relative to the PlatformIO project dir, which the
  // report states explicitly. Prefer it over the component root — a firmware
  // component whose root is the repo path of the pio project makes them equal,
  // but they are not equal when the manifest sits a level up.
  const anchorAbs = typeof doc.project_dir === 'string' && doc.project_dir !== '' ? doc.project_dir : opts.rootAbs;

  const notes: ParseNote[] = [];
  const cases: TestCaseResult[] = [];
  let emptySuites = 0;
  let unmappedSources = 0;

  for (const rawSuite of doc.test_suites) {
    if (rawSuite === null || typeof rawSuite !== 'object') continue;
    const suite = rawSuite as PioSuite;
    const suiteCases = Array.isArray(suite.test_cases) ? suite.test_cases : [];
    const declaredNums = typeof suite.testcase_nums === 'number' ? suite.testcase_nums : suiteCases.length;
    if (declaredNums === 0 || suiteCases.length === 0) {
      emptySuites += 1;
      continue;
    }

    const env = str(suite.env_name) ?? '<env>';
    const test = str(suite.test_name) ?? str(suite.test_dir) ?? '<suite>';
    const label = `${env}:${test}`;

    for (const rawCase of suiteCases) {
      if (rawCase === null || typeof rawCase !== 'object') continue;
      const tc = rawCase as PioCase;
      const status = mapStatus(str(tc.status) ?? '');
      const messageParts = [str(tc.message), str(tc.exception)].filter(
        (x): x is string => x !== undefined && x !== '',
      );
      const message = messageParts.length > 0 ? capMessage(messageParts.join('\n')) : undefined;

      let file: RepoPath | undefined;
      const src = tc.source as PioSource | null | undefined;
      const srcFile = src !== null && src !== undefined ? str(src.file) : undefined;
      if (srcFile !== undefined && srcFile !== '') {
        const mapped = mapArtifactPath(srcFile, {
          relativize,
          repoRoot: opts.repoRoot,
          anchorAbs,
          trackedPaths: opts.trackedPaths,
        });
        if (mapped.ok) file = mapped.path;
        else unmappedSources += 1;
      }

      // 0 means "Unity gave us nothing", not "0 ms". Reporting 0 ms would be a
      // fabricated measurement.
      const rawDuration = typeof tc.duration === 'number' ? tc.duration : null;
      const durationMs = rawDuration === null || rawDuration === 0 ? null : secondsToMs(rawDuration);

      cases.push({
        suite: label,
        name: str(tc.name) ?? '<unnamed>',
        status,
        durationMs,
        ...(message !== undefined ? { message } : {}),
        ...(file !== undefined ? { file } : {}),
      });
    }
  }

  if (emptySuites > 0) {
    notes.push({
      reason: 'empty',
      severity: 'info',
      detail: `${emptySuites} zero-case suite(s) dropped (PlatformIO env × test-dir cross product, not real skips)`,
    });
  }
  if (unmappedSources > 0) {
    notes.push({
      reason: 'unmapped-paths',
      severity: 'info',
      detail: `${unmappedSources} case source path(s) could not be mapped into the repo; attribution dropped`,
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

  const summary: TestSummary = {
    total: cases.length,
    passed,
    failed,
    skipped,
    durationMs: secondsToMs(typeof doc.duration === 'number' ? doc.duration : null),
    cases,
    source: opts.sourceLabel,
    stale: opts.stale,
  };

  const declaredTotal = typeof doc.testcase_nums === 'number' ? doc.testcase_nums : null;
  if (declaredTotal !== null && declaredTotal !== summary.total) {
    notes.push({
      reason: 'count-mismatch',
      severity: 'warn',
      detail: `testcase_nums=${declaredTotal} but ${summary.total} case(s) present after dropping zero-case suites`,
    });
  }

  return { summary, notes };
}

/**
 * WARNED maps to `passed`: PlatformIO does not fail a run on it, so calling it
 * a failure would invent a build break, and calling it skipped would erase an
 * executed test. The warning text survives in `message`.
 */
function mapStatus(s: string): TestCaseResult['status'] {
  switch (s.toUpperCase()) {
    case 'PASSED':
    case 'WARNED':
      return 'passed';
    case 'FAILED':
    case 'ERRORED':
      return 'failed';
    case 'SKIPPED':
      return 'skipped';
    default:
      return 'skipped';
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}
