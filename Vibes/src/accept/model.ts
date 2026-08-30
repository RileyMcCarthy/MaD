/**
 * `vibes accept` — the vocabulary.
 *
 * This module exists to make one claim honest: committed baseline bytes change
 * only through an act that is visible, attributable and expensive. Blind
 * acceptance cannot be prevented — an agent with a shell can write any bytes it
 * likes — so the design goal is that every acceptance leaves a signed statement
 * in the same diff a reviewer is already reading.
 *
 * Two structural rules drive everything below:
 *
 * 1. REFUSALS ARE COMPUTED BEFORE ANY WRITE. `accept` either writes its whole
 *    plan or writes nothing. A refusal discovered halfway through would leave
 *    baselines that no receipt vouches for, which the honesty check reports as
 *    `unreceipted-baseline` — a real error caused by our own partial failure.
 *
 * 2. `identical` AND `equivalent` ARE NEVER WRITTEN. A tolerance producer that
 *    emits a fresh sample of noise every run would otherwise commit that noise
 *    on every accept, and the snapshot would stop being a baseline and become a
 *    changelog of randomness.
 */

import type {
  AcceptMode,
  ComponentId,
  Outcome,
  ProducerName,
  RepoPath,
  Sha,
  SnapState,
  SnapshotResult,
  Verdict,
  VerdictKind,
} from '../types.js';

/* ─────────────────────────── on-disk constants ───────────────────────── */

/** Committed, inside the producer's baseline dir, next to what it vouches for. */
export const RECEIPT_BASENAME = '.vibes-accept.json';
export const RECEIPT_SCHEMA = 'vibes-accept/1';
export const GITATTRIBUTES_BASENAME = '.gitattributes';

/**
 * Every filename the receipt reader will pick up.
 *
 * `accept` only ever writes `RECEIPT_BASENAME`, merging prior statements
 * forward into it (see `receipt.ts`). The pattern is wider because the honesty
 * check reads the UNION of `.vibes-accept*.json` in an out dir, so a
 * hand-rotated sibling must be excluded from snapshot comparison here too —
 * otherwise the reader vouches for a file the comparer reports as an
 * unexplained addition.
 */
export const RECEIPT_FILE_RE = /^\.vibes-accept(?:\.[A-Za-z0-9_-]+)?\.json$/;

/**
 * Files that live in a baseline dir but are NOT snapshots.
 *
 * This set is exported because the snapshot categorizer has to subtract it. A
 * baseline roster comes from `git ls-tree <base> -- <outDir>`, which happily
 * lists the receipt; the producer never emits one, so set arithmetic would
 * report `.vibes-accept.json` as a DELETED snapshot on every single run, and
 * the deletion guard below would then demand `--accept-deletions` forever.
 *
 * `_vibes-census.json` and `_vibes-provenance.json` ARE producer-emitted, so
 * they are deliberately absent: the census is snapshot-compared like any other
 * file, because a removed case id is exactly the CORPUS SHRANK signal.
 */
export const RESERVED_BASELINE_FILES: ReadonlySet<string> = new Set([
  RECEIPT_BASENAME,
  GITATTRIBUTES_BASENAME,
]);

/** Reserved names live at the TOP LEVEL of the out dir only — a producer that
 *  legitimately emits `cases/.gitattributes` is emitting a snapshot. */
export function isReservedBaselineFile(relPath: string): boolean {
  if (relPath.includes('/')) return false;
  return RESERVED_BASELINE_FILES.has(relPath) || RECEIPT_FILE_RE.test(relPath);
}

/**
 * The `.gitattributes` bootstrap writes beside a new baseline corpus.
 *
 * `-diff` is the point: the diff of a snapshot is not the review surface, the
 * report is. The receipt is exempted on the next line — it is precisely the
 * thing a human is meant to read in the PR file list, and marking it
 * `linguist-generated` would collapse it in the GitHub UI.
 */
export const GITATTRIBUTES_CONTENT = [
  '# Written by `vibes accept --bootstrap`.',
  '# Snapshots are generated. They are reviewed through the Vibes report, never',
  '# by reading this diff, and they must never be auto-merged.',
  '* -merge -diff linguist-generated=true',
  '# The receipt is the exception: it is the statement a reviewer should read.',
  '.vibes-accept*.json merge diff -linguist-generated',
  '',
].join('\n');

/* ───────────────────────────── verdict rules ─────────────────────────── */

/** Verdicts whose received bytes replace the baseline. */
const WRITABLE: ReadonlySet<VerdictKind> = new Set<VerdictKind>([
  'different',
  'structural',
  'added',
]);

/** Verdicts that are counted and skipped — see rule 2 in the file header. */
const EQUIVALENT: ReadonlySet<VerdictKind> = new Set<VerdictKind>(['identical', 'equivalent']);

export function isWritableVerdict(k: VerdictKind): boolean {
  return WRITABLE.has(k);
}
export function isEquivalentVerdict(k: VerdictKind): boolean {
  return EQUIVALENT.has(k);
}

/* ──────────────────────────────── targets ────────────────────────────── */

export interface AcceptTarget {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  readonly outcome: Outcome;
  /** From the committed policy lock, not from this invocation's optimism. */
  readonly everCIVerified: boolean;
  readonly ciJob: string | null;
  /** Absolute path to the COMMITTED baseline dir. Only accept writes here. */
  readonly baselineDir: string;
  /** Absolute path to the gitignored received dir the run wrote. */
  readonly receivedDir: string;
  /** Repo-relative POSIX form of `baselineDir`, for report rows and receipts. */
  readonly outRepo: RepoPath;
  readonly files: readonly SnapshotResult[];
  /**
   * Source paths this component CLAIMS to witness that changed in this diff.
   *
   * NOT `ComponentResult.exercisedWitnessPaths`, and the difference is
   * load-bearing twice over. `exercised` means "a claiming producer ran ok AND
   * a pre-existing snapshot of its moved" — during a bootstrap there are no
   * pre-existing snapshots, so `exercised` is empty BY CONSTRUCTION and
   * refusal 6 would never fire. And after any accept the baseline matches the
   * received output, so on the next run nothing moves and every claimed path
   * reads unexercised, which would make §5.7 fire on every legitimate accept.
   *
   * The honest question both checks ask is "did any source this producer
   * claims to cover change at all", and that is the CLAIMED changed set.
   */
  readonly changedWitnessPaths: readonly RepoPath[];
  /**
   * `ComponentResult.exercisedWitnessPaths`, carried into the receipt as
   * provenance. Never used to decide a refusal — see above.
   */
  readonly exercisedWitnessPaths: readonly RepoPath[];
  /**
   * Producer INPUT corpus paths that changed in this diff. Empty means a
   * deletion has no declared cause and needs `--accept-deletions`.
   */
  readonly corpusChangedPaths: readonly RepoPath[];
  /** False when git tracks no file under `outRepo` — i.e. this is a bootstrap. */
  readonly hasBaseline: boolean;
}

export function targetId(t: { component: ComponentId; producer: ProducerName }): string {
  return `${t.component}/${t.producer}`;
}

/* ──────────────────────────────── plan ───────────────────────────────── */

export type CandidateAction = 'write' | 'delete';

export interface Candidate {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  /** Path relative to the producer's out dir, POSIX. */
  readonly file: string;
  readonly action: CandidateAction;
  readonly state: SnapState;
  readonly verdict: Verdict;
  readonly baselineSha256: string | null;
  readonly receivedSha256: string | null;
  readonly bytes: number;
  /** Absolute source path. Null for a deletion. */
  readonly absReceived: string | null;
  /** Absolute destination path inside the committed baseline dir. */
  readonly absBaseline: string;
  /** Repo-relative committed path — the one path universe reports use. */
  readonly repoPath: RepoPath;
}

export interface TargetPlan {
  readonly target: AcceptTarget;
  /** Offered to the reviewer, in bytewise file order. */
  readonly candidates: readonly Candidate[];
  /** Files whose verdict was `identical`/`equivalent`. Counted, never written. */
  readonly skippedEquivalent: readonly string[];
  /** `not-run` / `not-selected`. Never touched, and never deletable. */
  readonly untouched: readonly string[];
  /** Reserved names that appeared in the snapshot roster; excluded from all of
   *  the above and reported so a mis-categorising runner is visible. */
  readonly reserved: readonly string[];
  /** Files whose out-dir-relative path is unsafe (absolute, `..`, backslash). */
  readonly unsafe: readonly string[];
}

export interface AcceptPlan {
  readonly targets: readonly TargetPlan[];
  readonly candidates: readonly Candidate[];
  readonly deletions: readonly Candidate[];
  readonly writes: readonly Candidate[];
  readonly skippedEquivalent: number;
}

/* ─────────────────────────────── options ─────────────────────────────── */

export interface AcceptOptions {
  /** Restrict to these component ids. Empty means every component. */
  readonly components: readonly ComponentId[];
  /** `component/producer` or a bare producer name. Empty means every producer. */
  readonly producers: readonly string[];
  /** Non-interactive. Forces `mode: 'bulk'` unless `--bootstrap` is also set. */
  readonly yes: boolean;
  /** Implies `yes`; additionally stamps `acceptedBy: '--all'` on the receipt. */
  readonly all: boolean;
  readonly bootstrap: boolean;
  readonly reason: string | null;
  /** Exact expected deletion count. A mismatch refuses — you must have looked. */
  readonly acceptDeletions: number | null;
  readonly unverifiedProducer: boolean;
  /** Compute and print the plan, write nothing, exit 0. */
  readonly dryRun: boolean;
  /** Override for the `vibes doctor --repeat=N` attestation path. */
  readonly doctorAttestation: string | null;
  /** `--base <rev>`: an explicit comparison point, highest precedence. */
  readonly baseRef: string | null;
}

export const DEFAULT_ACCEPT_OPTIONS: AcceptOptions = Object.freeze({
  components: Object.freeze([]) as readonly ComponentId[],
  producers: Object.freeze([]) as readonly string[],
  yes: false,
  all: false,
  bootstrap: false,
  reason: null,
  acceptDeletions: null,
  unverifiedProducer: false,
  dryRun: false,
  doctorAttestation: null,
  baseRef: null,
});

export function acceptModeOf(o: AcceptOptions): AcceptMode {
  if (o.bootstrap) return 'bootstrap';
  if (o.yes || o.all) return 'bulk';
  return 'reviewed';
}

/** `'cli' | '--yes' | '--all'` — the receipt's attribution field. */
export function acceptedByOf(o: AcceptOptions): string {
  if (o.all) return '--all';
  if (o.yes) return '--yes';
  return 'cli';
}

/* ─────────────────────────────── refusals ────────────────────────────── */

export type RefusalCode =
  /* The eight from the spec, in its order. */
  | 'ci-environment'
  | 'producer-not-ok'
  | 'base-not-exact'
  | 'deletions-unauthorized'
  | 'never-ci-verified'
  | 'bootstrap-touches-witnesses'
  | 'baseline-dir-dirty'
  | 'reason-required'
  /* Additions. Each is documented at its check site in `guards.ts`. */
  | 'non-interactive-requires-yes'
  | 'run-stale'
  | 'received-missing'
  | 'received-mismatch'
  | 'unsafe-path'
  | 'bootstrap-not-attested'
  | 'bootstrap-has-baseline'
  | 'unknown-target'
  | 'unmerged-index'
  | 'receipt-corrupt';

export interface Refusal {
  readonly code: RefusalCode;
  /** `component/producer`, or null when the refusal is about the invocation. */
  readonly target: string | null;
  readonly message: string;
  readonly remediation: string;
  readonly paths?: readonly string[];
}

export function formatRefusal(r: Refusal): string {
  const where = r.target === null ? '' : ` [${r.target}]`;
  const paths =
    r.paths === undefined || r.paths.length === 0
      ? ''
      : `\n    ${r.paths.slice(0, 20).join('\n    ')}${
          r.paths.length > 20 ? `\n    … and ${r.paths.length - 20} more` : ''
        }`;
  return `REFUSED ${r.code}${where}: ${r.message}${paths}\n    fix: ${r.remediation}`;
}

/* ──────────────────────────────── result ────────────────────────────── */

export type AcceptDecision = 'accept' | 'reject' | 'skip';

export interface AcceptedFile {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  readonly file: string;
  readonly repoPath: RepoPath;
  readonly action: CandidateAction;
  readonly sha256: string | null;
  readonly previousSha256: string | null;
}

/**
 * Exit codes. `accept` is a gate; its exit code is read by scripts.
 *
 * These are accept-specific and deliberately finer than the CLI's global
 * 0-clean / 1-findings / 2-tool-error scale: a wrapper needs to tell "the tool
 * refused" (fix the invocation) from "the operator quit" (nothing is wrong)
 * from "a write failed halfway" (the tree may need `git checkout --`). The CLI
 * layer collapses them; nothing here may collapse them into a bare `1`,
 * because "accept exited non-zero" is the one signal a `|| true` swallows.
 */
export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_QUIT = 2;
export const EXIT_APPLY_FAILED = 3;

export interface AcceptSummaryCounts {
  readonly offered: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly skippedEquivalent: number;
  readonly deleted: number;
}

export interface RunAcceptResult {
  readonly exitCode: number;
  readonly refusals: readonly Refusal[];
  readonly counts: AcceptSummaryCounts;
  readonly accepted: readonly AcceptedFile[];
  /** Repo-relative receipt paths written. */
  readonly receiptsWritten: readonly RepoPath[];
  readonly mode: AcceptMode;
  readonly acceptedBy: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
  readonly summary: string;
  readonly dryRun: boolean;
}
