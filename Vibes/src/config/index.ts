/**
 * `src/config/` — public surface.
 *
 * The composing modules need exactly three things from here:
 *   `resolveConfig()` for a run, `validateAll()` for `vibes doctor` / `check`,
 *   and the Diagnostic vocabulary to print either one.
 *
 * Everything below is pure or git-only. Nothing in this directory spawns a
 * producer, and nothing imports from any project being measured.
 */

export {
  BUILTIN_DEFAULTS,
  COMPONENT_KEYS,
  DEFAULT_CONCURRENCY,
  DEFAULT_FAIL_ON,
  DEFAULT_MAX_INLINE_DIFF_LINES,
  DEFAULT_TIMEOUT_MS,
  FAIL_ON_KEYS,
  IGNORE_PROBE_NAMES,
  INGEST_KEYS,
  MANIFEST_BASENAME,
  MANIFEST_KEYS,
  MAX_CONCURRENCY,
  PIXEL_MAX_DIFF_RATIO_MAX,
  PRODUCER_KEYS,
  RECEIVED_DIRNAME,
  REGISTRY_ONLY_KEYS,
  REJECTED_CONFIG_EXTENSIONS,
  REPORT_FORMATS,
  REPORT_KEYS,
  ROOT_CONFIG_PATH,
  ROOT_KEYS,
  RUN_WHEN_VALUES,
  SHARED_DEFAULT_KEYS,
  STATE_DIRNAME,
  TIER_VALUES,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  TOLERANCE_ABS_MAX,
  TOLERANCE_REL_MAX,
  VIBES_DIRNAME,
} from './constants.js';
export type { EffectiveDefaults } from './constants.js';

export {
  DiagnosticBag,
  diag,
  formatDiagnostic,
  formatGithubAnnotation,
  sortDiagnostics,
} from './diagnostics.js';
export type { Diagnostic, DiagnosticCode, DiagnosticInit, DiagnosticSpan } from './diagnostics.js';

export {
  actualCaseMismatch,
  anchorGlob,
  checkGlob,
  checkRelPath,
  globIntersectsDir,
  globLiteralPrefix,
  hasBraces,
  isStrictDescendant,
  isSameOrDescendant,
  isSymlink,
  joinRepo,
  normalizeRel,
  pathsOverlap,
  realpathDeepest,
  repoRelative,
  toPosix,
} from './paths.js';
export type { PathProblem } from './paths.js';

export { applyProducer, mergeDefaults, mergeEnv, raiseRunWhen } from './precedence.js';
export type { EnvMap } from './precedence.js';

export { MJS_REASON, describeNearestPackageJson, loadManifest, loadRootConfig } from './load.js';
export type { ManifestLoad, ManifestLoadRequest, RootLoad } from './load.js';

export { isIsoDate, validateManifest, validateRootConfig } from './validate.js';
export type { ManifestValidation, RootValidation } from './validate.js';

export {
  allProducers,
  componentById,
  insideSubmodule,
  readSubmodulePaths,
  resolveConfig,
  selectableProducers,
  validateAll,
} from './resolve.js';
export type {
  ComponentPlan,
  ComponentStatus,
  ProducerPlan,
  ResolveOptions,
  ResolvedConfig,
  ResolvedIngest,
  ResolvedReport,
  ValidationSummary,
  WitnessMatch,
} from './resolve.js';
