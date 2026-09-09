/**
 * `ingestAll` — stream B: read what the test run left behind.
 *
 * Deliberately NOT in this module: running `ingest.cmd`. Spawning belongs to
 * the runner, which already owns env layering, process groups and timeouts.
 * Ingest reads the filesystem and nothing else, so it is a pure function of
 * (globs, files on disk, run start time) and can be tested without a shell.
 *
 * The whole module is organised around one rule: A NUMBER MAY ONLY BE PRINTED
 * WHEN IT IS THIS RUN'S EVIDENCE. Everything else — nothing declared, nothing
 * matched, matched but stale, matched but unparseable — is a named gap with a
 * severity, and the summary is `null`. There is no code path that turns any of
 * those four into a zero.
 */

import { promises as fs } from 'node:fs';

import type { ComponentId, CoverageSummary, Glob, Severity, TestSummary } from '../types.js';
import { parseJUnitXml } from './adapters/junitXml.js';
import { lcovToCoverage, parseLcov } from './adapters/lcov.js';
import { parsePioJson } from './adapters/pioJson.js';
import { parseVitestJson } from './adapters/vitestJson.js';
import type { CoverageParseResult, ParseNote, TestParseResult } from './adapters/shared.js';
import { globFiles, type DiscoveredFile } from './discover.js';
import {
  mergeCoverageSummaries,
  mergeTestSummaries,
  sourceLabel,
  type AdapterId,
  type ComponentIngest,
  type IngestAllInput,
  type IngestComponentInput,
  type IngestGap,
  type IngestKind,
  type IngestReport,
  type IngestState,
  type IngestedArtifact,
  type LcovSource,
  type UnmappedCoveragePath,
} from './model.js';
import { createRelativizer, type Relativizer } from './paths.js';
import { sniff } from './sniff.js';

export const DEFAULT_STALE_GRACE_MS = 2000;

export async function ingestAll(input: IngestAllInput): Promise<IngestReport> {
  const relativize = createRelativizer(input.repoRoot);
  const components: ComponentIngest[] = [];
  for (const c of input.components) {
    components.push(await ingestComponent(c, input, relativize));
  }
  return { components, gaps: components.flatMap((c) => c.gaps) };
}

/* ────────────────────────── per component ─────────────────────────────── */

interface Declared {
  readonly adapter: AdapterId;
  readonly glob: Glob;
  readonly baseAbs: string;
  /** lcov only. */
  readonly sourceRootAbs?: string;
}

async function ingestComponent(
  c: IngestComponentInput,
  input: IngestAllInput,
  relativize: Relativizer,
): Promise<ComponentIngest> {
  const required = c.required ?? true;
  const outcome = c.outcome ?? 'ran-ok';
  const grace = input.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
  const freshFloor = input.runStartedAtMs - grace;

  const testDecls: Declared[] = [
    ...(c.vitestJson ?? []).map((g) => decl('vitest-json', g, c.rootAbs)),
    ...(c.pioJson ?? []).map((g) => decl('pio-json', g, c.rootAbs)),
    ...(c.junit ?? []).map((g) => decl('junit-xml', g, c.rootAbs)),
  ];
  const covDecls: Declared[] = (c.lcov ?? []).map((l: LcovSource) => ({
    adapter: 'lcov' as const,
    glob: l.glob,
    baseAbs: c.rootAbs,
    sourceRootAbs: l.sourceRootAbs,
  }));

  const gaps: IngestGap[] = [];
  const artifacts: IngestedArtifact[] = [];
  const unmapped: UnmappedCoveragePath[] = [];

  const tests = await ingestKind<TestSummary, TestParseResult>({
    kind: 'tests',
    component: c.component,
    decls: testDecls,
    required,
    outcome,
    freshFloor,
    gaps,
    artifacts,
    parse: (text, adapter, ctx) =>
      parseTests(text, adapter, {
        repoRoot: input.repoRoot,
        rootAbs: c.rootAbs,
        sourceLabel: sourceLabel(adapter, ctx.displayPath),
        stale: ctx.stale,
        trackedPaths: input.trackedPaths,
      }),
    merge: (parts) => mergeTestSummaries(parts),
    isEmpty: (s) => s.total === 0,
    emptyDetail: 'artifact parsed but contains no test cases',
    relativize,
  });

  const coverage = await ingestKind<CoverageSummary, CoverageParseResult>({
    kind: 'coverage',
    component: c.component,
    decls: covDecls,
    required,
    outcome,
    freshFloor,
    gaps,
    artifacts,
    parse: (text, _adapter, ctx) => {
      const result = lcovToCoverage(parseLcov(text), {
        relativize,
        repoRoot: input.repoRoot,
        sourceRootAbs: ctx.sourceRootAbs ?? c.rootAbs,
        sourceLabel: sourceLabel('lcov', ctx.displayPath),
        artifactPath: ctx.displayPath,
        stale: ctx.stale,
        trackedPaths: input.trackedPaths,
      });
      unmapped.push(...result.unmapped);
      return result;
    },
    merge: (parts) => mergeCoverageSummaries(parts),
    isEmpty: (s) => s.files.length === 0,
    emptyDetail: 'tracefile parsed but no SF: section mapped onto a repo path',
    relativize,
  });

  return {
    component: c.component,
    tests: tests.summary,
    coverage: coverage.summary,
    testsState: tests.state,
    coverageState: coverage.state,
    artifacts,
    unmappedCoverage: unmapped,
    gaps,
  };
}

/* ─────────────────────── the one shared pipeline ──────────────────────── */

interface ParseCtx {
  readonly displayPath: string;
  readonly stale: boolean;
  readonly sourceRootAbs?: string | undefined;
}

interface KindRun<S, R extends { summary: S; notes: readonly ParseNote[] }> {
  readonly kind: IngestKind;
  readonly component: ComponentId;
  readonly decls: readonly Declared[];
  readonly required: boolean;
  readonly outcome: 'ran-ok' | 'not-run' | 'failed';
  readonly freshFloor: number;
  readonly gaps: IngestGap[];
  readonly artifacts: IngestedArtifact[];
  readonly parse: (text: string, adapter: AdapterId, ctx: ParseCtx) => R;
  readonly merge: (parts: readonly S[]) => S | null;
  readonly isEmpty: (s: S) => boolean;
  readonly emptyDetail: string;
  readonly relativize: Relativizer;
}

interface KindResult<S> {
  readonly summary: S | null;
  readonly state: IngestState;
}

async function ingestKind<S, R extends { summary: S; notes: readonly ParseNote[] }>(
  run: KindRun<S, R>,
): Promise<KindResult<S>> {
  const { kind, component, decls, required, gaps } = run;

  if (decls.length === 0) {
    // The honest empty state, and it must be said BY NAME: a blank cell reads
    // as "fine", and "0%" reads as "nothing is covered".
    gaps.push(gap(kind, component, 'not-configured', null, null, notConfiguredDetail(kind, component), 'info'));
    return { summary: null, state: 'not-configured' };
  }

  if (run.outcome === 'not-run') {
    gaps.push(
      gap(
        kind,
        component,
        'component-not-run',
        null,
        null,
        `${component}: ${kind} artifacts are declared but the step that writes them did not run`,
        'warn',
      ),
    );
    return { summary: null, state: 'not-run' };
  }

  // ── discover ──────────────────────────────────────────────────────────
  interface Found {
    readonly decl: Declared;
    readonly file: DiscoveredFile;
    readonly displayPath: string;
    readonly stale: boolean;
  }
  const found: Found[] = [];
  const seen = new Set<string>();
  for (const d of decls) {
    let files: readonly DiscoveredFile[];
    try {
      files = await globFiles(d.baseAbs, d.glob);
    } catch (err) {
      gaps.push(
        gap(kind, component, 'unreadable', d.glob, null, `glob '${d.glob}': ${(err as Error).message}`, 'error'),
      );
      continue;
    }
    if (files.length === 0) {
      gaps.push(
        gap(
          kind,
          component,
          'no-files-matched',
          d.glob,
          null,
          `${component}: no file matched '${d.glob}'${required ? '' : ' (required: false)'}`,
          required ? 'error' : 'warn',
        ),
      );
      continue;
    }
    for (const f of files) {
      if (seen.has(f.absPath)) continue; // two globs, one file: ingest once
      seen.add(f.absPath);
      found.push({
        decl: d,
        file: f,
        displayPath: run.relativize(f.absPath) ?? f.absPath,
        stale: f.mtimeMs < run.freshFloor,
      });
    }
  }

  if (found.length === 0) {
    return { summary: null, state: required ? 'error' : 'not-run' };
  }

  // ── staleness gate ────────────────────────────────────────────────────
  // An artifact older than the run that produced it is not this run's
  // evidence. When anything fresh exists, the stale files are dropped
  // outright; when NOTHING is fresh we still parse, but the result is stamped
  // stale and the state is `error`, so no caller can quote it as a result.
  const fresh = found.filter((f) => !f.stale);
  const usable = fresh.length > 0 ? fresh : found;
  const staleSeverity: Severity = run.outcome === 'ran-ok' ? 'error' : 'warn';
  for (const f of found) {
    if (!f.stale) continue;
    gaps.push(
      gap(
        kind,
        component,
        'stale',
        f.decl.glob,
        f.displayPath,
        `${f.displayPath} predates this run (mtime ${new Date(f.file.mtimeMs).toISOString()}); ` +
          (fresh.length > 0 ? 'excluded from the result' : 'no fresh artifact exists, so nothing here is this run\'s evidence'),
        staleSeverity,
      ),
    );
  }
  for (const f of found) {
    if (usable.includes(f)) continue;
    run.artifacts.push(artifact(kind, f.decl.adapter, f, false));
  }

  // ── read + parse ──────────────────────────────────────────────────────
  const summaries: S[] = [];
  for (const f of usable) {
    let text: string;
    try {
      text = await fs.readFile(f.file.absPath, 'utf8');
    } catch (err) {
      gaps.push(
        gap(kind, component, 'unreadable', f.decl.glob, f.displayPath, `${f.displayPath}: ${(err as Error).message}`, 'error'),
      );
      run.artifacts.push(artifact(kind, f.decl.adapter, f, false));
      continue;
    }

    const adapter = chooseAdapter(f.decl.adapter, text, kind, component, f.displayPath, f.decl.glob, gaps);
    if (adapter === null) {
      run.artifacts.push(artifact(kind, f.decl.adapter, f, false));
      continue;
    }

    let parsed: R;
    try {
      parsed = run.parse(text, adapter, {
        displayPath: f.displayPath,
        stale: f.stale,
        sourceRootAbs: f.decl.sourceRootAbs,
      });
    } catch (err) {
      gaps.push(
        gap(kind, component, 'parse-failed', f.decl.glob, f.displayPath, `${f.displayPath}: ${(err as Error).message}`, 'error'),
      );
      run.artifacts.push(artifact(kind, f.decl.adapter, f, false));
      continue;
    }

    for (const n of parsed.notes) {
      gaps.push(gap(kind, component, n.reason, f.decl.glob, f.displayPath, `${f.displayPath}: ${n.detail}`, n.severity));
    }
    summaries.push(parsed.summary);
    run.artifacts.push(artifact(kind, adapter, f, true));
  }

  const merged = run.merge(summaries);
  if (merged === null) {
    return { summary: null, state: 'error' };
  }

  if (run.isEmpty(merged)) {
    gaps.push(
      gap(
        kind,
        component,
        'empty',
        null,
        null,
        `${component}: ${run.emptyDetail}`,
        required ? 'error' : 'warn',
      ),
    );
    // An empty artifact is not evidence of an empty problem space.
    return { summary: merged, state: 'error' };
  }

  if (fresh.length === 0) return { summary: merged, state: 'error' };
  if (run.outcome === 'failed') {
    gaps.push(
      gap(
        kind,
        component,
        'producer-failed',
        null,
        null,
        `${component}: the step producing these ${kind} artifacts failed; the artifact may be partial`,
        'error',
      ),
    );
    return { summary: merged, state: 'error' };
  }
  return { summary: merged, state: 'ingested' };
}

/* ─────────────────────────────── helpers ──────────────────────────────── */

function parseTests(
  text: string,
  adapter: AdapterId,
  opts: {
    repoRoot: string;
    rootAbs: string;
    sourceLabel: string;
    stale: boolean;
    trackedPaths?: ReadonlySet<string> | undefined;
  },
): TestParseResult {
  switch (adapter) {
    case 'vitest-json':
      return parseVitestJson(text, opts);
    case 'pio-json':
      return parsePioJson(text, opts);
    case 'junit-xml':
      return parseJUnitXml(text, opts);
    case 'lcov':
      throw new Error('lcov is not a test adapter');
    default: {
      const never: never = adapter;
      throw new Error(`unknown adapter ${String(never)}`);
    }
  }
}

/**
 * The declaration says which adapter to use; sniffing exists to catch a WRONG
 * declaration. A test glob pointing at a tracefile (or vice versa) is refused
 * rather than reinterpreted — the manifest key decides what KIND of evidence a
 * file is, and silently promoting a tracefile into the test slot would let a
 * misconfiguration masquerade as a result.
 */
function chooseAdapter(
  declared: AdapterId,
  text: string,
  kind: IngestKind,
  component: ComponentId,
  displayPath: string,
  glob: Glob,
  gaps: IngestGap[],
): AdapterId | null {
  const detected = sniff(text);
  if (detected === 'unknown' || detected === declared) return declared;

  const detectedKind: IngestKind = detected === 'lcov' ? 'coverage' : 'tests';
  if (detectedKind !== kind) {
    gaps.push(
      gap(
        kind,
        component,
        'format-mismatch',
        glob,
        displayPath,
        `${displayPath} was declared as ${declared} (${kind}) but its contents are ${detected}; not ingested`,
        'error',
      ),
    );
    return null;
  }
  gaps.push(
    gap(
      kind,
      component,
      'format-mismatch',
      glob,
      displayPath,
      `${displayPath} was declared as ${declared} but its contents are ${detected}; parsed as ${detected}`,
      'warn',
    ),
  );
  return detected;
}

function notConfiguredDetail(kind: IngestKind, component: ComponentId): string {
  return kind === 'coverage'
    ? `${component}: coverage not configured — no ingest.lcov glob is declared, so no coverage was measured (this is not 0% coverage)`
    : `${component}: tests not configured — no ingest.junit / ingest.vitestJson / ingest.pioJson glob is declared`;
}

function decl(adapter: AdapterId, glob: Glob, baseAbs: string): Declared {
  return { adapter, glob, baseAbs };
}

function artifact(
  kind: IngestKind,
  adapter: AdapterId,
  f: { file: DiscoveredFile; displayPath: string; stale: boolean },
  used: boolean,
): IngestedArtifact {
  return {
    kind,
    adapter,
    path: f.displayPath,
    absPath: f.file.absPath,
    mtimeMs: f.file.mtimeMs,
    bytes: f.file.bytes,
    stale: f.stale,
    used,
  };
}

function gap(
  kind: IngestKind,
  component: ComponentId | null,
  reason: IngestGap['reason'],
  glob: Glob | null,
  file: string | null,
  detail: string,
  severity: Severity,
): IngestGap {
  return { kind, component, reason, glob, file, detail, severity };
}

/* ─────────────────────────── public surface ───────────────────────────── */

export { parseJUnitXml } from './adapters/junitXml.js';
export { parseVitestJson } from './adapters/vitestJson.js';
export { parsePioJson } from './adapters/pioJson.js';
export { lcovToCoverage, parseLcov } from './adapters/lcov.js';
export type {
  LcovBranch,
  LcovFunction,
  LcovParseResult,
  LcovReportedCounts,
  LcovSection,
  LcovToCoverageOptions,
} from './adapters/lcov.js';
export {
  AdapterParseError,
  type CoverageParseResult,
  type TestParseOptions,
  type TestParseResult,
} from './adapters/shared.js';
export { globFiles, type DiscoverOptions, type DiscoveredFile } from './discover.js';
export { sniff, type SniffResult } from './sniff.js';
export {
  createRelativizer,
  mapArtifactPath,
  toPosix,
  type MapOutcome,
  type MapPathOptions,
  type Relativizer,
} from './paths.js';
export {
  componentInputFromSpec,
  coverageTotals,
  formatPercent,
  globList,
  mergeCoverageSummaries,
  mergeFileCoverage,
  mergeTestSummaries,
  sourceLabel,
  mergedSourceLabel,
  type AdapterId,
  type ComponentIngest,
  type CoverageTotals,
  type GapReason,
  type IngestAllInput,
  type IngestComponentInput,
  type IngestGap,
  type IngestKind,
  type IngestReport,
  type IngestState,
  type IngestedArtifact,
  type LcovSource,
  type ParseNote,
  type ProducerOutcomeHint,
  type UnmappedCoveragePath,
} from './model.js';
export { coverageLabel, testsLabel } from './labels.js';
