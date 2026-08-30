/**
 * The git module's public surface.
 *
 * Composing modules should import from here, not from the files below it: the
 * split between `repo`/`base`/`categorize` is an implementation detail, and the
 * one thing that must stay stable is that nobody runs a git command outside
 * this directory. Every byte-level behaviour the tool's correctness depends on
 * — `-z` framing, `check-ignore -q` semantics, the read-tree + `add -N`
 * overlay, `--abbrev=40` — is encoded exactly once, here.
 */

export {
  createGitExec,
  splitZ,
  splitLines,
  sortPathsBytewise,
  GitError,
  GitTimeoutError,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  type GitExec,
  type GitRunOptions,
  type GitRunResult,
  type GitCommandRecord,
  type CreateGitExecOptions,
} from './exec.js';

export {
  openRepo,
  EMPTY_TREE_SHA,
  SubmodulePathError,
  UnmergedIndexError,
  type GitRepo,
  type OpenRepoOptions,
  type IgnoreCheck,
  type DiffRawOptions,
} from './repo.js';

export {
  parseRawDiffZ,
  parseLsTreeZ,
  parseCheckIgnoreVerboseZ,
  parseCatFileBatch,
  parseStatusZ,
  looksBinary,
  GITLINK_MODE,
  NULL_OID,
  type RawDiffEntry,
  type RawDiffParse,
  type LsTreeEntry,
  type CheckIgnoreRule,
  type StatusEntry,
} from './rawParse.js';

export {
  withIndexOverlay,
  diffRawWithUntracked,
  type OverlayOptions,
  type OverlayResult,
  type OverlayDiffOptions,
} from './indexOverlay.js';

export {
  resolveBase,
  describeBase,
  refCandidates,
  branchOf,
  BaseUnresolvableError,
  type BaseResolution,
  type BaseSource,
  type BaseConfidence,
  type BaseWarning,
  type LadderStep,
  type FetchPolicy,
  type ResolveBaseOptions,
} from './base.js';

export {
  categorizeChangedPaths,
  categorizeSnapshots,
  classifyKind,
  gitNormalizedPaths,
  sha256,
  DEFAULT_EXCLUDE_PATHSPECS,
  type ChangedSourcePath,
  type ChangeStatus,
  type ChangedPathKind,
  type CategorizeChangedOptions,
  type CategorizeChangedResult,
  type ReceivedFile,
  type SnapshotEntry,
  type SnapStatus,
  type CategorizeSnapshotsOptions,
  type SnapshotCategorization,
} from './categorize.js';

export {
  changedLinesFor,
  parseUnifiedDiff,
  isCosmetic,
  HUNK_RE,
  type LineChanges,
  type ChangedLine,
  type ChangedLinesOptions,
  type ParseDiffOptions,
} from './changedLines.js';

export {
  enrichGitlink,
  enrichGitlinks,
  gitlinkEntries,
  describeGitlink,
  notMeasuredSentence,
  type GitlinkChange,
  type GitlinkDirection,
  type EnrichOptions,
} from './submodule.js';
