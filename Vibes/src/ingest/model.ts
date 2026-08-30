/**
 * Ingest — the normalised model and the vocabulary around it.
 *
 * Stream B of the report: test results and coverage that some OTHER tool
 * produced. Vibes does not run the tests; it reads what the run left behind.
 *
 * Two rules shape every type in this file:
 *
 *  1. AN ARTIFACT IS EVIDENCE ONLY IF IT IS FRESH. A JUnit XML from yesterday
 *     parses perfectly and reports 244 passing tests that nobody ran today.
 *     Staleness is therefore modelled per artifact and never averaged away.
 *
 *  2. ABSENCE IS NOT ZERO. A component with no coverage tool configured has
 *     `coverage: null` and a named gap — never an empty CoverageSummary, which
 *     downstream would render as 0% and read as "nothing is covered".
 */

import type {
  ComponentId,
  CoverageSummary,
  FileCoverage,
  Glob,
  IngestSpec,
  RepoPath,
  Severity,
  TestSummary,
} from '../types.js';

/* ─────────────────────────────── adapters ─────────────────────────────── */

/** v1 adapters. `playwright-json` and `libtest-json` are deliberately absent. */
export type AdapterId = 'vitest-json' | 'junit-xml' | 'pio-json' | 'lcov';

export type IngestKind = 'tests' | 'coverage';

export const TEST_ADAPTERS: readonly AdapterId[] = ['vitest-json', 'junit-xml', 'pio-json'];

/* ───────────────────────────────── gaps ───────────────────────────────── */

/**
 * Why a number is missing. Every gap is rendered; a gap is the honest form of
 * a blank cell. The first ten come from the core spec; the last three are
 * additions this module needs (documented in the module report).
 */
export type GapReason =
  | 'not-configured'
  | 'component-not-run'
  | 'producer-failed'
  | 'no-files-matched'
  | 'unreadable'
  | 'unknown-format'
  | 'unsupported-format'
  | 'parse-failed'
  | 'empty'
  | 'stale'
  /** Declared as one format, sniffed as another. Parsed as sniffed, loudly. */
  | 'format-mismatch'
  /** The artifact's own header totals disagree with its own case list. */
  | 'count-mismatch'
  /** LCOV `SF:` records that could not be mapped into the repo (R-I4). */
  | 'unmapped-paths';

export interface IngestGap {
  readonly kind: IngestKind;
  readonly component: ComponentId | null;
  readonly reason: GapReason;
  /** The declared glob, when the gap is about discovery. */
  readonly glob: Glob | null;
  /** Repo-relative when the file is inside the repo, else absolute. */
  readonly file: string | null;
  readonly detail: string;
  readonly severity: Severity;
}

/** A note an adapter raises about the artifact it just parsed. */
export interface ParseNote {
  readonly reason: GapReason;
  readonly severity: Severity;
  readonly detail: string;
}

/* ──────────────────────────── provenance ──────────────────────────────── */

export interface IngestedArtifact {
  readonly kind: IngestKind;
  readonly adapter: AdapterId;
  /** Repo-relative when inside the repo, else the absolute path. */
  readonly path: string;
  readonly absPath: string;
  readonly mtimeMs: number;
  readonly bytes: number;
  /** mtime predates this run (minus a grace window). */
  readonly stale: boolean;
  /** False when the artifact was read but excluded — stale, unparseable, empty. */
  readonly used: boolean;
}

/** An `SF:` record that never landed on a real repo path. Reported WITH counts
 *  (R-I4): silently dropping unmapped files is how coverage inflates. */
export interface UnmappedCoveragePath {
  readonly raw: string;
  readonly resolved: string | null;
  readonly reason: 'outside-repo' | 'untracked';
  /** How many DA records were attached to it — the size of what we dropped. */
  readonly lines: number;
  /** The artifact it came from. */
  readonly artifact: string;
}

/* ─────────────────────────────── results ──────────────────────────────── */

/**
 * `ingested` — fresh evidence exists.
 * `not-configured` — nothing declared. The honest empty state.
 * `not-run` — declared, but the step that produces it did not run this run.
 * `error` — declared and expected, but unusable: missing, stale-only,
 *           unparseable, or produced by a failed step.
 *
 * A caller may print a number only for `ingested`. Everything else is a gap.
 */
export type IngestState = 'ingested' | 'not-configured' | 'not-run' | 'error';

export interface ComponentIngest {
  readonly component: ComponentId;
  readonly tests: TestSummary | null;
  readonly coverage: CoverageSummary | null;
  readonly testsState: IngestState;
  readonly coverageState: IngestState;
  readonly artifacts: readonly IngestedArtifact[];
  readonly unmappedCoverage: readonly UnmappedCoveragePath[];
  readonly gaps: readonly IngestGap[];
}

export interface IngestReport {
  readonly components: readonly ComponentIngest[];
  /** Every component's gaps, flattened, in component order. */
  readonly gaps: readonly IngestGap[];
}

/* ──────────────────────────────── input ───────────────────────────────── */

/**
 * What the runner knows about the step that was supposed to write these
 * artifacts. It changes the SEVERITY of a stale or missing file, not the fact.
 */
export type ProducerOutcomeHint = 'ran-ok' | 'not-run' | 'failed';

export interface LcovSource {
  readonly glob: Glob;
  /** Absolute anchor for RELATIVE `SF:` records (R-I4). */
  readonly sourceRootAbs: string;
}

export interface IngestComponentInput {
  readonly component: ComponentId;
  /** Absolute component root. ROOT-relative globs resolve against it (R-A). */
  readonly rootAbs: string;
  readonly junit?: readonly Glob[];
  readonly vitestJson?: readonly Glob[];
  readonly pioJson?: readonly Glob[];
  readonly lcov?: readonly LcovSource[];
  /** Zero matches is an error. Default true (R-I3). */
  readonly required?: boolean;
  /** Default 'ran-ok'. */
  readonly outcome?: ProducerOutcomeHint;
}

export interface IngestAllInput {
  readonly repoRoot: string;
  /** Epoch ms. Artifacts older than this (minus the grace) are stale. */
  readonly runStartedAtMs: number;
  readonly components: readonly IngestComponentInput[];
  /** Default 2000 ms — filesystem timestamp coarseness, not slack for lying. */
  readonly staleGraceMs?: number;
  /** When supplied, coverage paths outside it are reported unmapped (R-I4). */
  readonly trackedPaths?: ReadonlySet<RepoPath>;
}

/* ───────────────────── shaping the declared spec ──────────────────────── */

/** `Glob | readonly Glob[] | undefined` → a plain array. */
export function globList(v: Glob | readonly Glob[] | undefined): readonly Glob[] {
  if (v === undefined) return [];
  return typeof v === 'string' ? [v] : v;
}

/**
 * Turn a manifest `IngestSpec` into ingest input.
 *
 * `IngestSpec.lcov` is a three-way union whose two array arms are only
 * distinguishable by element type, so discriminate per element rather than on
 * the array: a mixed array is legal input and must not silently drop entries.
 */
export function componentInputFromSpec(
  component: ComponentId,
  rootAbs: string,
  spec: IngestSpec | null | undefined,
  resolveRootRel: (p: string) => string,
): IngestComponentInput {
  const lcov: LcovSource[] = [];
  if (spec?.lcov !== undefined) {
    const raw: readonly (Glob | { readonly path: Glob; readonly sourceRoot?: string })[] =
      typeof spec.lcov === 'string' ? [spec.lcov] : spec.lcov;
    for (const item of raw) {
      if (typeof item === 'string') {
        lcov.push({ glob: item, sourceRootAbs: resolveRootRel('.') });
      } else {
        lcov.push({ glob: item.path, sourceRootAbs: resolveRootRel(item.sourceRoot ?? '.') });
      }
    }
  }
  return {
    component,
    rootAbs,
    junit: globList(spec?.junit),
    vitestJson: globList(spec?.vitestJson),
    pioJson: globList(spec?.pioJson),
    lcov,
    required: spec?.required ?? true,
  };
}

/* ─────────────────────────────── merging ──────────────────────────────── */

/** Label an artifact contributes to `TestSummary.source` / `CoverageSummary.source`. */
export function sourceLabel(adapter: AdapterId, path: string): string {
  return `${adapter}:${path}`;
}

/** Merge label for N artifacts. Deterministic, and it never hides the count. */
export function mergedSourceLabel(parts: readonly { adapter: AdapterId; path: string }[]): string {
  if (parts.length === 0) return 'none';
  const first = parts[0];
  if (parts.length === 1 && first !== undefined) return sourceLabel(first.adapter, first.path);
  const adapters = [...new Set(parts.map((p) => p.adapter))].sort();
  return `${adapters.join('+')}:${parts.length} files`;
}

export function mergeTestSummaries(parts: readonly TestSummary[]): TestSummary | null {
  if (parts.length === 0) return null;
  const single = parts[0];
  if (parts.length === 1 && single !== undefined) return single;
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs: number | null = null;
  const cases = [];
  const sources: string[] = [];
  let stale = false;
  for (const p of parts) {
    total += p.total;
    passed += p.passed;
    failed += p.failed;
    skipped += p.skipped;
    if (p.durationMs !== null) durationMs = (durationMs ?? 0) + p.durationMs;
    cases.push(...p.cases);
    sources.push(p.source);
    stale = stale || p.stale;
  }
  return { total, passed, failed, skipped, durationMs, cases, source: sources.join(' + '), stale };
}

/**
 * Merge per-file coverage across tracefiles. Line hits SUM (two runs of the
 * same suite genuinely executed a line twice); a line present in one file and
 * absent in the other stays present, because absent means UNINSTRUMENTED and
 * union is the only interpretation that does not invent instrumentation.
 */
export function mergeFileCoverage(parts: readonly FileCoverage[]): FileCoverage {
  const first = parts[0];
  if (first === undefined) throw new Error('mergeFileCoverage: empty input');
  if (parts.length === 1) return first;
  const lines = new Map<number, number>();
  let branchesTaken = 0;
  let branchesTotal = 0;
  for (const p of parts) {
    for (const [line, hits] of p.lines) lines.set(line, (lines.get(line) ?? 0) + hits);
    branchesTaken += p.branchesTaken;
    branchesTotal += p.branchesTotal;
  }
  return { file: first.file, lines: sortedLineMap(lines), branchesTaken, branchesTotal };
}

export function mergeCoverageSummaries(parts: readonly CoverageSummary[]): CoverageSummary | null {
  if (parts.length === 0) return null;
  const single = parts[0];
  if (parts.length === 1 && single !== undefined) return single;
  const byFile = new Map<RepoPath, FileCoverage[]>();
  const sources: string[] = [];
  let stale = false;
  for (const p of parts) {
    for (const f of p.files) {
      const bucket = byFile.get(f.file);
      if (bucket === undefined) byFile.set(f.file, [f]);
      else bucket.push(f);
    }
    sources.push(p.source);
    stale = stale || p.stale;
  }
  const files = [...byFile.keys()]
    .sort()
    .map((k) => mergeFileCoverage(byFile.get(k) ?? []));
  return { files, source: sources.join(' + '), stale };
}

/** Deterministic map ordering — report bytes must not depend on insertion order. */
export function sortedLineMap(m: ReadonlyMap<number, number>): ReadonlyMap<number, number> {
  return new Map([...m.entries()].sort((a, b) => a[0] - b[0]));
}

/* ───────────────────────────── presentation ───────────────────────────── */

export interface CoverageTotals {
  readonly linesFound: number;
  readonly linesHit: number;
  readonly branchesTotal: number;
  readonly branchesTaken: number;
  readonly files: number;
}

/**
 * `found` counts INSTRUMENTED lines (DA records), not lines in the file.
 * An uninstrumented line is absent from the map and is absent from both
 * numerator and denominator — it is not "uncovered", it is unmeasured.
 */
export function coverageTotals(cov: CoverageSummary): CoverageTotals {
  let linesFound = 0;
  let linesHit = 0;
  let branchesTotal = 0;
  let branchesTaken = 0;
  for (const f of cov.files) {
    for (const hits of f.lines.values()) {
      linesFound += 1;
      if (hits > 0) linesHit += 1;
    }
    branchesTotal += f.branchesTotal;
    branchesTaken += f.branchesTaken;
  }
  return { linesFound, linesHit, branchesTotal, branchesTaken, files: cov.files.length };
}

/**
 * The ONLY sanctioned way to print a coverage or pass rate.
 *
 * Returns 'n/a' when nothing was measured — 0/0 is not 0% and not 100%.
 * Never prints '100%' unless hit === found, and never prints '0.0%' for a
 * nonzero numerator: both roundings turn a real number into a false claim.
 */
export function formatPercent(hit: number, found: number): string {
  if (!Number.isFinite(hit) || !Number.isFinite(found) || found <= 0) return 'n/a';
  if (hit >= found) return '100%';
  const pct = (hit / found) * 100;
  if (pct >= 99.95) return '99.9%';
  if (hit > 0 && pct < 0.05) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}
