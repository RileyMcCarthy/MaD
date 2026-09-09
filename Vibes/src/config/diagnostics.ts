/**
 * Config diagnostics.
 *
 * A validation error that does not name the FILE, the FIELD and the FIX is not
 * a check — it is a complaint. Every diagnostic below carries all three, and
 * `evidence` carries only computed facts (resolved paths, verbatim git output,
 * counts) so a reader can verify the claim without re-running anything.
 *
 * NOTE: `Diagnostic` deliberately lives here rather than in ../types.ts. The
 * contract in types.ts owns the run/report vocabulary; this is the load-time
 * vocabulary, and `vibes doctor` consumes it without any of the run types.
 */

import type { ComponentId, RepoPath, Severity } from '../types.js';

export type DiagnosticCode =
  /* environment / root ------------------------------------------------- */
  | 'V001_GIT_UNAVAILABLE' | 'V002_NOT_A_REPO' | 'V003_NODE_TOO_OLD'
  | 'V010_ROOT_MISSING' | 'V011_ROOT_NOT_MJS' | 'V012_ROOT_UNKNOWN_KEY'
  | 'V013_ROOT_VERSION' | 'V014_BASEREF_UNRESOLVED' | 'V015_REPORT_OUT_ESCAPES'
  | 'V016_REPORT_OUT_UNIGNORED'
  /** ADDED (not in the spec's list): default export present but not an object.
   *  A factory root config cannot work — ManifestContext needs baseSha, which
   *  needs baseRef, which is a field of the root config. */
  | 'V017_ROOT_NOT_OBJECT'
  /** ADDED: concurrency out of range. */
  | 'V018_CONCURRENCY_RANGE'
  /* registry ------------------------------------------------------------ */
  | 'V020_ID_INVALID' | 'V021_ID_DUPLICATE' | 'V022_ROOT_MISSING_DIR'
  | 'V023_ROOT_NESTED' | 'V024_ROOT_IN_SUBMODULE' | 'V025_ROOT_IS_REPO_ROOT'
  | 'V026_DISABLED_REASON_REQUIRED' | 'V027_DISABLED_EXPIRED'
  | 'V028_DEPENDSON_UNKNOWN' | 'V029_DEPENDSON_CYCLE'
  | 'V02A_SUBMODULE_UNKNOWN' | 'V02B_GENERATES_ESCAPES'
  /* manifest loading ---------------------------------------------------- */
  | 'V030_MANIFEST_MISSING' | 'V031_MANIFEST_NOT_MJS' | 'V032_MODULE_FORMAT'
  | 'V033_NO_DEFAULT_EXPORT' | 'V034_MANIFEST_THREW' | 'V035_MANIFEST_UNTRACKED'
  | 'V036_MANIFEST_UNKNOWN_KEY' | 'V037_REGISTRY_KEY_IN_MANIFEST'
  | 'V038_COMPONENT_MISMATCH'
  /** ADDED: default export (or factory return) is not an object. */
  | 'V039_MANIFEST_NOT_OBJECT'
  /* producers ------------------------------------------------------------ */
  | 'V040_NAME_INVALID' | 'V041_NAME_DUPLICATE' | 'V042_CMD_HAS_CD'
  | 'V043_OUT_ESCAPES' | 'V044_OUT_COLLISION' | 'V045_OUT_IGNORED_DIR'
  | 'V046_OUT_IGNORED_FILE' | 'V047_OUT_IN_SUBMODULE' | 'V048_CWD_MISSING'
  | 'V049_TIMEOUT_RANGE' | 'V04A_RENDERER_UNKNOWN' | 'V04B_TOLERANCE_UNBOUNDED'
  | 'V04C_TOLERANCE_NO_REASON' | 'V04D_NO_BASELINE' | 'V04E_CENSUS_MISSING'
  /** ADDED: `cwd` resolves outside the component root. */
  | 'V04F_CWD_ESCAPES_ROOT'
  /** ADDED (warn): no `ciJob`, so this producer's snapshots can only ever
   *  render `locally-accepted, never CI-verified`. */
  | 'V04G_CIJOB_MISSING'
  /** ADDED: `out` exists but its final segment differs in case from what the
   *  manifest wrote. Passes on APFS, breaks on the ubuntu runner. */
  | 'V04H_OUT_CASE_MISMATCH'
  /** ADDED: `out` is a symlink; containment checks cannot be trusted through it. */
  | 'V04I_OUT_IS_SYMLINK'
  /* witnesses ------------------------------------------------------------ */
  | 'V050_WITNESSES_REQUIRED' | 'V051_WITNESS_ESCAPES_ROOT'
  | 'V052_WITNESS_IN_VIBES_DIR' | 'V053_WITNESS_ZERO_ALWAYS'
  | 'V054_WITNESS_RETIRED' | 'V055_WITNESS_IN_OUT' | 'V056_WITNESS_IN_SUBMODULE'
  | 'V057_WITNESS_MULTICLAIM'
  /* ingest --------------------------------------------------------------- */
  | 'V060_INGEST_ESCAPES_ROOT' | 'V061_INGEST_IN_OUT' | 'V062_INGEST_NO_MATCH'
  | 'V063_INGEST_TRACKED' | 'V064_LCOV_UNMAPPED' | 'V065_NO_TEST_EVIDENCE'
  /* governance ----------------------------------------------------------- */
  | 'V070_GOVERNANCE_WEAKENED' | 'V071_COMPONENT_REMOVED'
  | 'V072_SNAPSHOT_HAND_EDITED' | 'V073_MINCASES_LOWERED'
  /* run-time ------------------------------------------------------------- */
  | 'V080_PRODUCER_FAILED' | 'V081_PRODUCER_TIMEOUT' | 'V082_EMPTY_OUTPUT'
  | 'V083_STRAY_WRITE' | 'V084_MUTATED_SOURCE' | 'V085_CROSS_OUT'
  | 'V086_SUBMODULE_DIRTY' | 'V087_STALE_BASELINE' | 'V088_CORPUS_FLOOR'
  /* cross-cutting shape checks (ADDED — the spec listed no generic codes) -- */
  /** A glob contains `{a,b}`. git pathspecs silently match NOTHING with braces,
   *  which reads in a report as "no files changed". Rejected, never tolerated. */
  | 'V0A0_GLOB_BRACES'
  /** Backslash, NUL, drive letter, leading `/`, or a `..` segment in a path. */
  | 'V0A1_PATH_NOT_POSIX'
  /** A relative path escapes the anchor it is resolved against. */
  | 'V0A2_PATH_ESCAPES'
  /** A field is missing, or present with the wrong type or an illegal value.
   *  `locator` names the exact field; `evidence` carries what was found. */
  | 'V0A3_FIELD_TYPE'
  /** `--only` / `--skip` named a component id that is not in the registry.
   *  Never a silent no-op: a typo'd `--only` would run nothing and look clean. */
  | 'V0A4_SELECTION_UNKNOWN';

export interface DiagnosticSpan {
  readonly line: number;
  readonly column: number;
}

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  /** Repo-relative POSIX. Always set — a diagnostic with no file is unactionable. */
  readonly file: RepoPath;
  readonly span?: DiagnosticSpan;
  /** Field path inside the file, e.g. `components[2].root`. */
  readonly locator?: string;
  readonly component?: ComponentId;
  /** ≤100 chars, no trailing period. The detail belongs in `evidence`. */
  readonly message: string;
  /** Computed facts only: resolved paths, verbatim tool output, counts. */
  readonly evidence: readonly string[];
  /** REQUIRED, non-empty, imperative. A check with no remedy is not a check. */
  readonly fix: string;
}

export interface DiagnosticInit {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  readonly file: RepoPath;
  readonly message: string;
  readonly fix: string;
  readonly span?: DiagnosticSpan | undefined;
  readonly locator?: string | undefined;
  readonly component?: ComponentId | undefined;
  readonly evidence?: readonly string[] | undefined;
}

/**
 * Build a Diagnostic. Optional fields are conditionally spread rather than set
 * to `undefined` — `exactOptionalPropertyTypes` makes `{ span: undefined }`
 * illegal where the property is declared `span?: DiagnosticSpan`.
 */
export function diag(init: DiagnosticInit): Diagnostic {
  return {
    code: init.code,
    severity: init.severity,
    file: init.file,
    message: init.message,
    fix: init.fix,
    evidence: init.evidence ?? [],
    ...(init.span !== undefined ? { span: init.span } : {}),
    ...(init.locator !== undefined ? { locator: init.locator } : {}),
    ...(init.component !== undefined ? { component: init.component } : {}),
  };
}

/** Mutable accumulator. Validation is TOTAL: everything is collected, nothing
 *  short-circuits, and no producer runs while any error-severity entry exists. */
export class DiagnosticBag {
  readonly #items: Diagnostic[] = [];

  add(init: DiagnosticInit): void {
    this.#items.push(diag(init));
  }

  addAll(items: readonly Diagnostic[]): void {
    for (const d of items) this.#items.push(d);
  }

  get items(): readonly Diagnostic[] {
    return this.#items;
  }

  errors(): readonly Diagnostic[] {
    return this.#items.filter((d) => d.severity === 'error');
  }

  warnings(): readonly Diagnostic[] {
    return this.#items.filter((d) => d.severity === 'warn');
  }

  get ok(): boolean {
    return !this.#items.some((d) => d.severity === 'error');
  }
}

/** Stable ordering for reports: errors first, then by file, then by code. */
export function sortDiagnostics(items: readonly Diagnostic[]): readonly Diagnostic[] {
  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return [...items].sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.locator ?? '').localeCompare(b.locator ?? ''),
  );
}

/**
 * One line per diagnostic, in the GitHub Actions annotation format already used
 * elsewhere in this repo's CI. Emitted IN ADDITION to human output, never
 * instead of it.
 */
export function formatGithubAnnotation(d: Diagnostic): string {
  const kind = d.severity === 'error' ? 'error' : d.severity === 'warn' ? 'warning' : 'notice';
  const parts = [`file=${d.file}`];
  if (d.span) parts.push(`line=${d.span.line}`, `col=${d.span.column}`);
  parts.push(`title=${d.code}`);
  return `::${kind} ${parts.join(',')}::${d.message} — fix: ${d.fix}`;
}

/** Human line: `V043 error Software/Control/vibes/vibes.manifest.mjs producers[0].out — …` */
export function formatDiagnostic(d: Diagnostic): string {
  const where = d.locator ? `${d.file} ${d.locator}` : d.file;
  const head = `${d.code} ${d.severity} ${where} — ${d.message}`;
  const body = d.evidence.map((e) => `\n    ${e}`).join('');
  return `${head}${body}\n    fix: ${d.fix}`;
}
