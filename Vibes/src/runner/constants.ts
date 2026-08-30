/**
 * Runner vocabulary and limits.
 *
 * NOTE ON BUDGETS: core-spec §4.13 wants a single `Budget` object built in
 * `cli/main.ts` and threaded through every stage. Every number below is an
 * explicit field of `RunnerLimits`, and every entry point takes a
 * `Partial<RunnerLimits>`, so threading one object is a call-site change and
 * not a rewrite. `DEFAULT_RUNNER_LIMITS` exists so a unit test does not have to
 * restate nine numbers; it is not a second authority.
 */

import type { ProducerTier } from '../types.js';

export interface RunnerLimits {
  /** Per stream, captured head 25% / tail 75% — errors live at the end. */
  readonly maxOutputBytes: number;
  /**
   * The raw log tee is bounded too. An uncapped sink defeats the point of
   * capping the capture and can fill a runner disk during a 60-minute producer.
   */
  readonly logTeeBytes: number;
  /** SIGTERM → wait → SIGKILL, applied to the process GROUP. */
  readonly gracefulKillMs: number;
  /** After SIGKILL, wait this long before probing for an orphaned group. */
  readonly killProbeMs: number;
  /**
   * 0 = off, and that is the default. A quiet build phase (`cargo build`,
   * `pio run`) legitimately emits nothing for minutes; an idle timeout that
   * fires there converts a slow producer into a false regression.
   */
  readonly idleTimeoutMs: number;
  /** A lease older than this whose holder is gone is reclaimed. */
  readonly staleLockMs: number;
  /** How long to wait for a foreign holder to release before `blocked`. */
  readonly lockWaitMs: number;
  readonly lockPollMs: number;
  /** After `exit`, how long to wait for `close` before declaring an orphan. */
  readonly closeGraceMs: number;
  readonly maxFilesPerProducer: number;
  /** Files above this are inventoried and hashed but flagged; the compare
   *  layer refuses to diff them. */
  readonly maxFileBytes: number;
}

export const DEFAULT_RUNNER_LIMITS: RunnerLimits = Object.freeze({
  maxOutputBytes: 2 * 1024 * 1024,
  logTeeBytes: 8 * 1024 * 1024,
  gracefulKillMs: 5_000,
  killProbeMs: 500,
  idleTimeoutMs: 0,
  staleLockMs: 3_600_000,
  lockWaitMs: 30_000,
  lockPollMs: 250,
  closeGraceMs: 500,
  maxFilesPerProducer: 20_000,
  maxFileBytes: 8 * 1024 * 1024,
});

export function resolveLimits(overrides?: Partial<RunnerLimits>): RunnerLimits {
  return { ...DEFAULT_RUNNER_LIMITS, ...(overrides ?? {}) };
}

/**
 * Wall-clock budget per tier, checked at PREFLIGHT against the sum of selected
 * `timeoutMs` values. Discovering at minute 55 that the PR lane cannot fit is
 * not a check, it is an outage.
 *
 * types.ts's `VibesRootConfig` carries no `tiers` block, so this is a runner
 * option rather than config. Flagged for the integration pass.
 */
export const DEFAULT_TIER_BUDGET_MS: Readonly<Record<ProducerTier, number>> = Object.freeze({
  pr: 600_000,
  nightly: 7_200_000,
  manual: Number.POSITIVE_INFINITY,
});

/* ────────────────────────────── env policy ───────────────────────────── */

/**
 * Removed from the child's environment.
 *
 * `ELECTRON_RUN_AS_NODE` leaks out of the VS Code integrated terminal and
 * silently breaks Node-spawning test suites — a documented, reproduced failure
 * in this repo. `INIT_CWD` and `npm_*` are stripped because Vibes is usually
 * launched through `npm run`, and a producer that reads them gets the *parent*
 * invocation's paths rather than its own.
 */
export const ENV_DENY_EXACT: readonly string[] = Object.freeze([
  'ELECTRON_RUN_AS_NODE',
  'INIT_CWD',
  'NODE_ENV_FILE',
]);

export const ENV_DENY_PREFIX: readonly string[] = Object.freeze(['npm_']);

/**
 * Determinism floor. Applied before manifest/producer env, so a producer can
 * still override any of them deliberately.
 *
 * `CI` is deliberately ABSENT in both directions. Setting it flips vitest,
 * insta and jest into their never-write-snapshots mode; unsetting it changes
 * what a project's own scripts do. Either way the runner would be changing the
 * thing it is measuring.
 */
export const ENV_DETERMINISM: Readonly<Record<string, string>> = Object.freeze({
  TZ: 'UTC',
  LC_ALL: 'C',
  LANG: 'C.UTF-8',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  TERM: 'dumb',
});

/** Injected last and NOT overridable — a producer must not be able to lie
 *  about which producer it is or where its out dir lives. */
export const INJECTED_ENV_KEYS: readonly string[] = Object.freeze([
  'VIBES',
  'VIBES_VERSION',
  'VIBES_RUN_ID',
  'VIBES_REPO_ROOT',
  'VIBES_MANIFEST_DIR',
  'VIBES_COMPONENT',
  'VIBES_PRODUCER',
  'VIBES_OUT_DIR',
  'VIBES_BASE_SHA',
  'VIBES_HEAD_SHA',
  'SOURCE_DATE_EPOCH',
]);

/* ─────────────────────────── reserved filenames ──────────────────────── */

/** Self-reported corpus roster. Snapshot-compared like any other file, so a
 *  removed id renders as a CORPUS SHRANK row naming it. */
export const CENSUS_FILE = '_vibes-census.json';
export const PROVENANCE_FILE = '_vibes-provenance.json';
/** Partial-corpus contract: the ids this invocation actually covered. */
export const SELECTION_FILE = '.vibes-selected';

/** Excluded from case counting — the bookkeeping files are not cases. */
export const RESERVED_BASENAMES: readonly string[] = Object.freeze([
  CENSUS_FILE,
  PROVENANCE_FILE,
  SELECTION_FILE,
]);

/* ──────────────────────────── repo-state paths ───────────────────────── */

export const STATE_DIR = '.vibes';
export const RECEIVED_DIR = 'received';
export const LOGS_DIR = 'logs';
export const POLICY_LOCK_PATH = '.vibes/policy.lock.json';

/**
 * The one correct form, verified: `.vibes/` + `!.vibes/policy.lock.json` does
 * NOT work — git never descends into an excluded directory, so `git add`
 * silently no-ops and `git show <base>:.vibes/policy.lock.json` fails forever,
 * which disables the whole self-governance layer without a single error.
 */
export const GITIGNORE_BLOCK = [
  '# --- vibes (managed block; `vibes init` writes this, `vibes run` verifies it) ---',
  '.vibes/*',
  '!.vibes/policy.lock.json',
  '.vibes-reports/',
].join('\n');

/** Default mutual-exclusion token when a producer declares none.
 *
 *  NOT the empty set. A default of "parallel with everything" means the first
 *  author who adds an emulator producer silently corrupts every concurrent run;
 *  serialising within a component is cheap and wrong-in-the-safe-direction. */
export function defaultResourceTokens(component: string): readonly string[] {
  return [`component:${component}`];
}
