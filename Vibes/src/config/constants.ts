/**
 * Vibes config — the fixed vocabulary.
 *
 * Every filename here is EXACT and is never searched for:
 *   - `<repoRoot>/vibes.config.mjs` is the registry.
 *   - `<root>/vibes/vibes.manifest.mjs` is DERIVED from the registry entry.
 *
 * WHY derived and not configurable: a settable manifest path is a redirect an
 * agent can use to point Vibes at an empty file, and a discovery glob would
 * ingest this repo's 18 worktrees plus Vibes' own self-hosting fixtures. The
 * cost is one line per component rename; the benefit is that deleting a
 * component's coverage claim is impossible to do silently.
 */

import type {
  CompareSpec,
  FailPolicy,
  RendererId,
  RepoPath,
  ReportFormat,
  RunWhen,
} from '../types.js';

/* ─────────────────────────── exact filenames ─────────────────────────── */

export const ROOT_CONFIG_PATH: RepoPath = 'vibes.config.mjs';
export const MANIFEST_BASENAME = 'vibes.manifest.mjs';
export const VIBES_DIRNAME = 'vibes';

/** Runtime state dir at the repo root. Producers write into `<state>/received`. */
export const STATE_DIRNAME = '.vibes';
export const RECEIVED_DIRNAME = 'received';

/**
 * Extensions that are NOT accepted for either config file, with the reason the
 * error message must carry. The repo root has no package.json anywhere up to
 * `/`, so Node resolves a root-level `.js` as CommonJS and `export default` is
 * a SyntaxError. Local node 23 hides nothing here — CI pins node 20 and both
 * behave the same way; what hides it is a component that happens to sit under
 * a `"type": "module"` package.json (only `Software/Control/` does).
 */
export const REJECTED_CONFIG_EXTENSIONS = ['.js', '.cjs', '.mts', '.cts', '.ts', '.json'] as const;

/* ───────────────────────────── key sets ──────────────────────────────── */
/* Unknown keys are ERRORS at both levels (R-L6). A tool whose product is a
 * trustworthy claim cannot silently ignore its own configuration. These lists
 * mirror the interfaces in ../types.ts exactly; adding a field there without
 * adding it here makes the field a hard error, which is the safe direction. */

export const ROOT_KEYS = [
  'version', 'baseRef', 'report', 'components', 'defaults', 'concurrency', 'failOn',
] as const;

export const REPORT_KEYS = ['out', 'formats', 'title', 'maxInlineDiffLines'] as const;

export const FAIL_ON_KEYS = [
  'producerError', 'ingestMissing', 'honestyViolation', 'governanceWeakened', 'snapshotDrift',
] as const;

export const COMPONENT_KEYS = [
  'id', 'title', 'root', 'enabled', 'disabledReason', 'disabledUntil',
  'dependsOn', 'generates', 'submodules',
] as const;

export const MANIFEST_KEYS = ['component', 'producers', 'witnesses', 'ingest', 'defaults'] as const;

export const PRODUCER_KEYS = [
  'name', 'description', 'cmd', 'out', 'cwd', 'env', 'timeoutMs', 'compare',
  'renderer', 'resources', 'minCases', 'runWhen', 'clean', 'tier', 'ciJob',
] as const;

export const INGEST_KEYS = [
  'cmd', 'cwd', 'timeoutMs', 'env', 'junit', 'vitestJson', 'pioJson', 'lcov', 'required',
] as const;

/** The ONLY keys legal at both root and manifest level. */
export const SHARED_DEFAULT_KEYS = [
  'compare', 'renderer', 'timeoutMs', 'env', 'runWhen', 'clean',
] as const;

/**
 * Keys legal ONLY in the registry. Appearing in a manifest is V037.
 * This list is the enforcement of the split: `root`, `enabled`, `disabledReason`
 * and `dependsOn` are exactly the fields an agent would reach for to narrow or
 * silence its own component, so they may only exist in the one file a reviewer
 * reads as a single hunk.
 */
export const REGISTRY_ONLY_KEYS = [
  'root', 'enabled', 'disabledReason', 'disabledUntil',
  'dependsOn', 'generates', 'submodules', 'baseRef', 'report',
  'components', 'concurrency', 'failOn', 'version',
] as const;

/* ───────────────────────────── value ranges ──────────────────────────── */

export const TIMEOUT_MIN_MS = 1_000;
export const TIMEOUT_MAX_MS = 3_600_000;
export const DEFAULT_TIMEOUT_MS = 600_000;

/** An unbounded tolerance is "compare nothing", so both bounds are capped. */
export const TOLERANCE_ABS_MAX = 1;
export const TOLERANCE_REL_MAX = 1e-3;
export const PIXEL_MAX_DIFF_RATIO_MAX = 0.05;

export const REPORT_FORMATS: readonly ReportFormat[] = ['md', 'html', 'json'];
export const RUN_WHEN_VALUES: readonly RunWhen[] = ['always', 'changed'];
export const TIER_VALUES = ['pr', 'nightly', 'manual'] as const;

export const DEFAULT_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 64;
export const DEFAULT_MAX_INLINE_DIFF_LINES = 200;

/* ───────────────────────────── defaults ──────────────────────────────── */

/**
 * Lowest layer of the precedence chain. `renderer` is `null` rather than the
 * empty string: an empty RendererId would be a real key into the renderer
 * registry and would resolve to "unknown renderer" instead of "no renderer".
 */
export interface EffectiveDefaults {
  readonly compare: CompareSpec;
  readonly renderer: RendererId | null;
  readonly timeoutMs: number;
  /** `null` means "unset this variable in the child", not "empty string". */
  readonly env: Readonly<Record<string, string | null>>;
  readonly runWhen: RunWhen;
  readonly clean: boolean;
}

export const BUILTIN_DEFAULTS: EffectiveDefaults = {
  compare: { kind: 'exact' },
  renderer: null,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  env: {},
  runWhen: 'changed',
  /**
   * clean defaults TRUE: without wiping the received dir first, a corpus entry
   * that was deleted is never noticed, because its stale output lingers and
   * compares equal.
   */
  clean: true,
};

export const DEFAULT_FAIL_ON: Required<FailPolicy> = {
  producerError: true,
  ingestMissing: true,
  /** Defaults TRUE. False makes the honesty section decorative. */
  honestyViolation: true,
  /** Defaults TRUE. This is the anti-gaming gate; turning it off is itself a
   *  registry diff, which is the point. */
  governanceWeakened: true,
  /** Defaults FALSE — drift is the product, not an error. */
  snapshotDrift: false,
};

/**
 * Synthetic names probed inside every producer `out` at load time. A
 * directory-level ignore probe is INSUFFICIENT: `snapshots/` is not ignored
 * anywhere in this repo, but `snapshots/run.log`, `snapshots/parse.bin`,
 * `snapshots/x.tmp` and `snapshots/x.bak` all are, via bare extension patterns
 * in the root `.gitignore` and two component `.gitignore`s.
 */
export const IGNORE_PROBE_NAMES = [
  '.vibes-probe', '.vibes-probe.log', '.vibes-probe.bin',
  '.vibes-probe.tmp', '.vibes-probe.bak',
] as const;
