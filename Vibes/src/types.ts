/**
 * Vibes — the single shared vocabulary.
 *
 * ARCHITECTURAL INVARIANT: nothing under Vibes/src may import from any project
 * being measured. Producers are shell commands that write files into a declared
 * output directory. That is the whole coupling surface, and it is what makes
 * this tool polyglot for free.
 */

/* ─────────────────────────── path vocabulary ─────────────────────────── */

/** Relative to the repo root, e.g. "Software/Control/src/domain/gcode.ts". */
export type RepoPath = string;
/** Relative to the component `root` declared in the registry. */
export type RootRelPath = string;
/** Relative to `<root>/vibes/` — the manifest's own directory. */
export type VibesRelPath = string;
/** picomatch syntax: globstar and leading `!` negation. Braces are REJECTED at
 *  validation time — `git ls-files -- '**\/x.{ts,tsx}'` silently matches nothing. */
export type Glob = string;

/** /^[a-z0-9][a-z0-9-]{0,31}$/ — becomes a directory name and an HTML anchor. */
export type ComponentId = string;
/** /^[a-z0-9][a-z0-9-]{0,63}$/ — unique within a component. */
export type ProducerName = string;
/** Key into the path-glob renderer registry. Unknown ids error at resolve time. */
export type RendererId = string;
/** ISO date, YYYY-MM-DD. */
export type IsoDate = string;
/** 40-char lowercase hex. */
export type Sha = string;

export const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PRODUCER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/* ─────────────── files `vibes accept` writes, not producers ───────────────
 * `vibes accept` writes a receipt and a `.gitattributes` beside the committed
 * baselines. NO producer ever emits either, so every place that compares a
 * baseline roster against producer output must exclude them — otherwise they
 * read as snapshots that vanished.
 *
 * This lives here, in the shared vocabulary, because getting it wrong was not
 * hypothetical: the same defect shipped three times in three modules, each
 * with its own local copy of the rule, and each surfaced only under a
 * condition the previous one could not reach —
 *   1. receipt scan          -> `unreceipted-baseline` on every adopted repo
 *   2. snapshot categorizer  -> two phantom `deleted` rows above every diff
 *   3. baseline case count   -> `corpus-shrank`, which disqualifies the
 *                               producer entirely and reports it `not-run`
 * One predicate, imported everywhere. Do not re-derive it locally.
 *
 * `_vibes-census.json` is deliberately NOT here: a producer emits it, and
 * excluding it would make a shrinking corpus invisible.
 */
export const ACCEPT_GITATTRIBUTES = '.gitattributes';
/** `.vibes-accept.json` plus the numbered variants accept rotates to. */
export const ACCEPT_RECEIPT_RE = /^\.vibes-accept(?:-\d+)?\.json$/;

/** `rel` is relative to the producer's out dir. Top level only — a producer
 *  that genuinely emits `cases/.gitattributes` is emitting a snapshot. */
export function isAcceptWritten(rel: string): boolean {
  if (rel.includes('/')) return false;
  return rel === ACCEPT_GITATTRIBUTES || ACCEPT_RECEIPT_RE.test(rel);
}

/* ══════════════════════ ROOT REGISTRY — /vibes.config.mjs ══════════════════
 * Owns identity, existence, scope, suppression and the dependency graph.
 * These are exactly the fields an agent would reach for to hide a regression,
 * so they live in ONE file that shows up as one reviewable hunk.
 * There is NO filesystem discovery: this repo carries 18 worktrees, and a glob
 * would ingest stale checkouts and the tool's own self-hosting fixtures.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface VibesRootConfig {
  readonly version: 1;
  /** Single base for the whole run — one report cannot be coherent across two
   *  baselines. Resolved through an event-aware ladder with NO fallback to HEAD. */
  readonly baseRef: string;
  readonly report: ReportPolicy;
  /** The registry. Explicit, ordered, exhaustive. */
  readonly components: readonly ComponentEntry[];
  readonly defaults?: SharedDefaults;
  /** Max concurrent producers. Resource tokens still apply on top. */
  readonly concurrency?: number;
  readonly failOn?: FailPolicy;
}

export interface ReportPolicy {
  readonly out: RepoPath;
  readonly formats: readonly ReportFormat[];
  readonly title?: string;
  readonly maxInlineDiffLines?: number;
}

export type ReportFormat = 'md' | 'html' | 'json';

export interface FailPolicy {
  readonly producerError?: boolean;
  readonly ingestMissing?: boolean;
  readonly honestyViolation?: boolean;
  readonly governanceWeakened?: boolean;
  readonly snapshotDrift?: boolean;
}

export interface ComponentEntry {
  readonly id: ComponentId;
  readonly title?: string;
  /** Component root, repo-relative. The manifest path is DERIVED as
   *  `<root>/vibes/vibes.manifest.mjs` and is never configurable — a settable
   *  manifest path is a redirect an agent could use to swap in an empty one.
   *  If `root` does not exist, that is a HARD ERROR, not a skip: this is what
   *  makes deleting a component's coverage claim impossible to do silently. */
  readonly root: RepoPath;
  readonly enabled?: boolean;
  /** Required when `enabled === false`. Surfaced in every report. */
  readonly disabledReason?: string;
  /** Required when `enabled === false`. Past this date the suppression itself
   *  becomes a finding, so disabling cannot quietly become permanent. */
  readonly disabledUntil?: IsoDate;
  /** Ordering edges. A component runs after everything it depends on. */
  readonly dependsOn?: readonly ComponentId[];
  /** Paths this component GENERATES rather than authors (codegen output).
   *  Changes here are attributed to the generator, not to a human edit. */
  readonly generates?: readonly Glob[];
  /** Submodule paths under this root. Gitlink changes are enriched from the
   *  submodule's own history rather than shown as an opaque one-line sha bump. */
  readonly submodules?: readonly RepoPath[];
}

/* ═══════════════ MANIFEST — <root>/vibes/vibes.manifest.mjs ════════════════
 * MECHANICS ONLY: how to produce, where it lands, how to compare, what it
 * claims to witness. Local and rename-churny by nature, so it lives next to
 * the code it measures.
 *
 * Extension MUST be .mjs. The repo root has no package.json, so a bare .js
 * manifest loads as CJS and `export default` is a SyntaxError.
 * ═══════════════════════════════════════════════════════════════════════════ */

export type ManifestModule =
  | VibesManifest
  | ((ctx: ManifestContext) => VibesManifest | Promise<VibesManifest>);

export interface VibesManifest {
  /** Must equal the registry id for the component whose root contains this
   *  file. A mismatch is an error — it would otherwise let one component's
   *  manifest answer for another. */
  readonly component: ComponentId;
  readonly producers: readonly Producer[];
  /** Source paths these snapshots CLAIM to cover. The honesty check joins
   *  changed source against this. Deliberately named `witnesses`, and the
   *  report must never upgrade "a producer claiming this path ran and its
   *  output moved" into "this file was executed". */
  readonly witnesses?: readonly Glob[];
  readonly ingest?: IngestSpec;
  readonly defaults?: SharedDefaults;
}

export interface Producer {
  readonly name: ProducerName;
  readonly description?: string;
  /** Shell command. Receives $VIBES_OUT_DIR pointing at a gitignored received
   *  directory — NEVER at the committed baseline. A producer writes; it must
   *  not assert, because an assertion failure marks it `failed`, which
   *  invalidates its whole out dir exactly when behaviour changed. */
  readonly cmd: string;
  /** Baseline location, relative to the manifest dir. Convention: 'snapshots/<name>'. */
  readonly out: VibesRelPath;
  readonly cwd?: RootRelPath;
  readonly env?: Readonly<Record<string, string | null>>;
  readonly timeoutMs?: number;
  readonly compare?: CompareSpec;
  readonly renderer?: RendererId;
  /** Exclusive resource tokens, e.g. 'sil-emulator', 'pty:/tmp/tty.rpi'.
   *  The SIL emulator is single-instance; two producers holding the same token
   *  never run concurrently, across worktrees on the same machine. */
  readonly resources?: readonly string[];
  /** Floor on emitted case count, monotonic against the baseline. Catches a
   *  producer quietly shrinking its own corpus to make a diff disappear. */
  readonly minCases?: number;
  readonly runWhen?: RunWhen;
  /** Wipe the received dir before running. Default true — without it a deleted
   *  corpus entry is never noticed, because its stale output lingers. */
  readonly clean?: boolean;
  /** Selection tier. v1 ships only producers that already run inside ci-gate. */
  readonly tier?: ProducerTier;
  /** REQUIRED: the CI job this producer runs in. A snapshot whose producer has
   *  never completed in CI renders `locally-accepted, never CI-verified`. */
  readonly ciJob?: string;
}

export type RunWhen = 'always' | 'changed';
export type ProducerTier = 'pr' | 'nightly' | 'manual';

/** The ONLY keys legal at both root and manifest level. */
export interface SharedDefaults {
  readonly compare?: CompareSpec;
  readonly renderer?: RendererId;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | null>>;
  readonly runWhen?: RunWhen;
  readonly clean?: boolean;
}

/* ───────────────────────────── comparison ────────────────────────────── */

/** A bare mode applies to every file; a rule array is first-match-wins. */
export type CompareSpec = CompareMode | readonly CompareRule[];

export type CompareMode =
  | { readonly kind: 'exact' }
  | {
      readonly kind: 'tolerance';
      readonly abs?: number;
      readonly rel?: number;
      readonly columns?: readonly string[];
      /** Mandatory. A loosened epsilon must carry a stated justification,
       *  because the epsilon is a number the same agent wrote in the same PR. */
      readonly reason: string;
    }
  | {
      readonly kind: 'pixel';
      readonly maxDiffRatio?: number;
      readonly threshold?: number;
      readonly reason: string;
    };

export interface CompareRule {
  readonly match: Glob;
  readonly use: CompareMode;
}

/* ─────────────────────────────── ingest ──────────────────────────────── */

export interface IngestSpec {
  readonly cmd?: string;
  readonly cwd?: RootRelPath;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | null>>;
  readonly junit?: Glob | readonly Glob[];
  readonly vitestJson?: Glob | readonly Glob[];
  readonly pioJson?: Glob | readonly Glob[];
  readonly lcov?: readonly IngestLcov[] | Glob | readonly Glob[];
  readonly required?: boolean;
}

export interface IngestLcov {
  readonly path: Glob;
  readonly sourceRoot?: RootRelPath;
}

/** Passed to a manifest exporting a factory function. */
export interface ManifestContext {
  readonly repoRoot: string;
  readonly root: string;
  readonly vibesDir: string;
  readonly component: ComponentId;
  readonly baseRef: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
}

/* ═══════════════════════ THE STATE VOCABULARY ══════════════════════════
 * These distinctions are the product. Every one of them exists because
 * collapsing it reintroduces a specific lie. No code path may merge two.
 * ═══════════════════════════════════════════════════════════════════════ */

/** A producer's execution outcome. Trust is DERIVED from it, never assigned. */
export type Outcome =
  | 'ok'
  | 'failed'
  | 'timedOut'
  | 'spawnError'
  | 'emptyOutput'
  | 'blocked'
  | 'cancelled'
  /** Deliberately not run this invocation (tier, --only, path filter). */
  | 'not-selected'
  /** Manifest present, component dir absent — e.g. uninitialised submodule. */
  | 'not-discovered';

export type Trust = 'verified' | 'unverified';

export const isTrusted = (o: Outcome): Trust =>
  o === 'ok' ? 'verified' : 'unverified';

/** Per-snapshot-file state. All SIX are distinct in the type, in report.json,
 *  in the markdown and in the HTML. */
export type SnapState =
  | 'verified-unchanged'
  | 'changed'
  | 'added'
  | 'deleted'
  /** Present in the baseline but outside this run's declared selection. */
  | 'not-selected'
  /** The producer did not run ok. This is NEVER reported as "unchanged". */
  | 'not-run';

export type ComponentState =
  | 'verified-unchanged'
  | 'changed'
  | 'not-run'
  | 'partial'
  | 'bootstrap'
  | 'not-configured';

/* ───────────────────────── resolved config ───────────────────────────── */

export interface ResolvedProducer extends Producer {
  readonly component: ComponentId;
  /** Absolute path to the committed baseline dir. */
  readonly baselineDir: string;
  /** Absolute path to the gitignored received dir this run writes into. */
  readonly receivedDir: string;
  readonly absCwd: string;
  readonly compareSpec: CompareSpec;
  readonly effectiveTimeoutMs: number;
  readonly effectiveClean: boolean;
  readonly effectiveRunWhen: RunWhen;
}

export interface ResolvedComponent {
  readonly entry: ComponentEntry;
  readonly manifest: VibesManifest | null;
  readonly producers: readonly ResolvedProducer[];
  readonly absRoot: string;
  readonly absVibesDir: string;
  readonly witnesses: readonly Glob[];
}

/* ──────────────────────────── run results ────────────────────────────── */

export interface ProducerResult {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  readonly outcome: Outcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdoutPath: string | null;
  readonly stderrPath: string | null;
  /** Files the producer wrote into its received dir, repo-relative-ish keys. */
  readonly emitted: readonly string[];
  /** Non-fatal notes: files written outside the out dir, ignored paths, etc. */
  readonly warnings: readonly string[];
  /** True only when this producer has completed successfully in CI at least
   *  once, per the committed policy lock. */
  readonly everCIVerified: boolean;
}

export type VerdictKind =
  | 'identical'
  | 'equivalent'
  | 'different'
  | 'structural'
  | 'added'
  | 'deleted'
  | 'not-run'
  | 'not-selected';

export interface Verdict {
  readonly kind: VerdictKind;
  readonly mode: CompareMode['kind'];
  /** Human-readable one-liner, e.g. "3 of 412 rows differ; worst |Δ| 0.04 mm". */
  readonly summary?: string;
  /** For tolerance mode: how much of the allowed epsilon was consumed, 0..1. */
  readonly epsilonUtilisation?: number;
}

export interface SnapshotResult {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  /** Path relative to the producer's out dir. */
  readonly file: string;
  readonly state: SnapState;
  readonly verdict: Verdict;
  readonly baselineSha256: string | null;
  readonly receivedSha256: string | null;
  /** Set when this file's current baseline content is vouched for by a receipt
   *  rather than by the base commit. */
  readonly receiptId: string | null;
  readonly renderer: RendererId | null;
  readonly bytes: number;
}

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly component?: ComponentId;
  readonly paths?: readonly RepoPath[];
  /** Findings that must never be rendered inside a collapsed section. */
  readonly alwaysExpanded?: boolean;
}

export interface ComponentResult {
  readonly component: ComponentId;
  readonly state: ComponentState;
  readonly producers: readonly ProducerResult[];
  readonly snapshots: readonly SnapshotResult[];
  readonly tests: TestSummary | null;
  readonly coverage: CoverageSummary | null;
  readonly findings: readonly Finding[];
  /** Witness globs that had a changed source file this diff. */
  readonly exercisedWitnessPaths: readonly RepoPath[];
  /** Changed source under this component matching NO witness glob. */
  readonly unclaimedPaths: readonly RepoPath[];
}

export interface RunReport {
  readonly version: 1;
  readonly baseRef: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly components: readonly ComponentResult[];
  readonly findings: readonly Finding[];
  /** every(declaredProducer => outcome === 'ok') over the COMMITTED policy-lock
   *  roster — not over what this invocation happened to discover. A component
   *  that vanished from discovery cannot make the run look complete.
   *  The emitter may not print the word "unchanged" in any headline unless
   *  this is true. */
  readonly fullyVerified: boolean;
  readonly exitCode: number;
}

/* ─────────────────── ingest normalised model ─────────────────────────── */

export interface TestCaseResult {
  readonly suite: string;
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly durationMs: number | null;
  readonly message?: string;
  readonly file?: RepoPath;
}

export interface TestSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs: number | null;
  readonly cases: readonly TestCaseResult[];
  readonly source: string;
  /** True when the artifact predates the run that produced it. */
  readonly stale: boolean;
}

export interface FileCoverage {
  readonly file: RepoPath;
  /** line number -> hit count. ABSENT means uninstrumented; 0 means uncovered.
   *  That distinction is load-bearing and most lcov libraries normalise it away. */
  readonly lines: ReadonlyMap<number, number>;
  readonly branchesTaken: number;
  readonly branchesTotal: number;
}

export interface CoverageSummary {
  readonly files: readonly FileCoverage[];
  readonly source: string;
  readonly stale: boolean;
}

/* ─────────────────────────── accept receipts ─────────────────────────── */

export type AcceptMode = 'reviewed' | 'bulk' | 'bootstrap';

export interface ReceiptEntry {
  readonly file: string;
  readonly sha256: string;
  readonly previousSha256: string | null;
  readonly verdict: VerdictKind;
}

/** Committed alongside the baselines it vouches for. The honesty check
 *  recomputes sha256 of every committed baseline file and cross-checks it
 *  against the union of receipts plus the baseline content at <base>. Content
 *  matching neither is `unreceipted-baseline`, error severity — so a bare
 *  `git add -A && git commit` cannot launder a snapshot change. */
export interface Receipt {
  readonly id: string;
  readonly version: 1;
  readonly component: ComponentId;
  readonly producer: ProducerName;
  readonly mode: AcceptMode;
  readonly acceptedBy: string;
  readonly reason: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
  readonly entries: readonly ReceiptEntry[];
  readonly counts: {
    readonly changed: number;
    readonly accepted: number;
    readonly skippedEquivalent: number;
    readonly acceptRatio: number;
  };
  /** Recorded when accepted despite the producer never having passed in CI. */
  readonly unverifiedProducer?: boolean;
  /** Bootstrap only: the doctor repeat count and the run shas that agreed. */
  readonly doctorRuns?: readonly string[];
}

/* ──────────────────────────── git port ───────────────────────────────── */

/** Injected so every module unit-tests without a real repo. Implemented over
 *  execFile + git plumbing: wrappers hide the exact byte-level behaviour this
 *  tool's correctness depends on (-z framing, check-ignore -q semantics,
 *  read-tree + add -N overlay, --abbrev=40). */
export interface GitPort {
  readonly repoRoot: string;
  revParse(rev: string): Promise<Sha | null>;
  mergeBase(a: string, b: string): Promise<Sha | null>;
  /** Tracked + untracked-not-ignored. The only path universe Vibes trusts:
   *  a filesystem walk would surface files git deliberately hides. */
  listFiles(pathspecs?: readonly string[]): Promise<readonly RepoPath[]>;
  lsTree(rev: Sha, prefix?: RepoPath): Promise<readonly RepoPath[]>;
  readBlob(rev: Sha, path: RepoPath): Promise<Buffer | null>;
  /** Raw name-status against a base, including gitlink (160000) rows. */
  diffNameStatus(base: Sha): Promise<readonly DiffEntry[]>;
  /** `check-ignore -q` semantics: exit 0 = ignored, 1 = not ignored. The `-v`
   *  form's exit status is unusable, since a matched negation also returns 0. */
  isIgnored(path: RepoPath): Promise<boolean>;
  /** True when `path` lies inside a submodule — `check-ignore` fatals there. */
  isInSubmodule(path: RepoPath): Promise<boolean>;
  isShallow(): Promise<boolean>;
}

export interface DiffEntry {
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  readonly path: RepoPath;
  readonly from?: RepoPath;
  /** Set for 160000 gitlink rows. */
  readonly submodule?: { readonly base: Sha; readonly head: Sha };
}
