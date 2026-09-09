/**
 * `src/runner/` — public surface.
 *
 * The runner is the only module in Vibes that starts a process the tool did not
 * write. Everything it exports is arranged around one structural rule:
 *
 *   a producer writes to `$VIBES_OUT_DIR`, a GITIGNORED received directory,
 *   and never to the committed baseline.
 *
 * That separation is what makes `vibes accept` the only writer of a baseline,
 * and it is the structural half of the anti-gaming design — the half that does
 * not depend on anybody being honest. `receivedDir.ts` owns the only `rm -rf`
 * in the tool and refuses any path that is not exactly a producer scratch dir.
 *
 * Composers should import from here rather than from the files below: the split
 * between plan / pool / exec / locks is an implementation detail, while the
 * guarantees (process-group kill, machine-scoped leases, per-file ignore
 * checks, monotonic corpus floors) are the contract.
 */

export {
  CENSUS_FILE,
  DEFAULT_RUNNER_LIMITS,
  DEFAULT_TIER_BUDGET_MS,
  ENV_DENY_EXACT,
  ENV_DENY_PREFIX,
  ENV_DETERMINISM,
  GITIGNORE_BLOCK,
  INJECTED_ENV_KEYS,
  LOGS_DIR,
  POLICY_LOCK_PATH,
  PROVENANCE_FILE,
  RECEIVED_DIR,
  RESERVED_BASENAMES,
  SELECTION_FILE,
  STATE_DIR,
  defaultResourceTokens,
  resolveLimits,
  type RunnerLimits,
} from './constants.js';

export {
  buildProducerEnv,
  envDiff,
  injectedEnv,
  producerPath,
  type BuildEnvResult,
  type EnvLayer,
  type ProducerEnvContext,
} from './env.js';

export {
  BoundedCapture,
  decodeCapture,
  runCommand,
  shPortabilityHazards,
  type RunCommand,
  type SpawnFailure,
  type SpawnOutcome,
  type SpawnRequest,
} from './exec.js';

export {
  finding,
  formatFinding,
  hasError,
  sortFindings,
  type RunnerCode,
  type RunnerFinding,
  type RunnerFindingInit,
} from './findings.js';

export {
  groupAlive,
  killTree,
  signalGroup,
  type GroupSignal,
  type KillTreeOptions,
  type KillTreeResult,
  type SignalResult,
} from './killtree.js';

export {
  acquireAll,
  acquireLease,
  isStale,
  lockDirFor,
  lockKey,
  lockPathFor,
  parseToken,
  probeResource,
  releaseAll,
  type AcquireAllResult,
  type AcquireResult,
  type Lease,
  type LockHolder,
  type LockOptions,
  type ParsedToken,
  type ProbeResult,
  type ResourceProbe,
  type TokenKind,
} from './locks.js';

export {
  assertSafeReceivedDir,
  prepareReceivedDir,
  receivedDirFor,
  receivedRepoPath,
  UnsafeReceivedDirError,
  type PrepareResult,
} from './receivedDir.js';

export {
  baselineCaseCount,
  countCases,
  detectEol,
  findCaseCollisions,
  hasBom,
  inventoryDir,
  isReserved,
  looksBinary,
  readCensus,
  readSelection,
  type CensusResult,
  type EmittedFile,
  type Eol,
  type Inventory,
  type InventoryOptions,
} from './inventory.js';

export {
  classifyEscapes,
  dirtySubmodules,
  statusDelta,
  statusMap,
  type Escape,
  type EscapeContext,
  type EscapeKind,
  type StatusDelta,
  type StatusMap,
} from './escapes.js';

export { findCycles, runPool, type PoolOptions, type PoolResult, type PoolTask } from './pool.js';

export {
  buildPlan,
  checkTierBudget,
  totalsByTier,
  type BuildPlanOptions,
  type NotSelectedReason,
  type ProducerTask,
  type RunPlan,
} from './plan.js';

export { preflight, type PreflightInput, type PreflightResult } from './preflight.js';

export {
  checkProducedIgnored,
  decideOutcome,
  logPathsFor,
  runProducers,
  type Disqualification,
  type ProducerRun,
  type RunProducersOptions,
  type RunnerReport,
} from './run.js';
