/**
 * Running the producers.
 *
 * The shape of this file is dictated by one rule from the state vocabulary:
 * ANY non-`ok` outcome invalidates a producer's ENTIRE output, including files
 * that look fine. There is no partial credit, because "some of these bytes are
 * trustworthy" is not a claim anyone can check.
 *
 * Three outcomes here are easy to collapse and must not be:
 *   - `emptyOutput` is NOT `ok`. Exit 0 with zero files is the "point a
 *     producer at an empty directory" move, and the alternative — reporting
 *     every baseline file as deleted — is the worst possible outcome for an
 *     honesty tool.
 *   - `blocked` is NOT a warning. A producer that could not take the lease on
 *     the resource it declared has not been verified.
 *   - `not-selected` is NOT `verified-unchanged`. It is a distinct state with a
 *     mandatory reason, printed above the fold.
 */

import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type {
  ComponentId,
  Outcome,
  ProducerName,
  ProducerResult,
  RepoPath,
  Sha,
  Trust,
} from '../types.js';
import { isTrusted } from '../types.js';
import type { GitRepo, StatusEntry } from '../git/index.js';
import {
  LOGS_DIR,
  STATE_DIR,
  resolveLimits,
  type RunnerLimits,
} from './constants.js';
import { buildProducerEnv, envDiff, type ProducerEnvContext } from './env.js';
import {
  classifyEscapes,
  statusDelta,
  statusMap,
  type Escape,
  type StatusMap,
} from './escapes.js';
import { runCommand, type RunCommand, type SpawnOutcome } from './exec.js';
import { finding, hasError, sortFindings, type RunnerFinding } from './findings.js';
import {
  baselineCaseCount,
  countCases,
  inventoryDir,
  readCensus,
  readSelection,
  type CensusResult,
  type EmittedFile,
  type Inventory,
} from './inventory.js';
import {
  acquireAll,
  lockDirFor,
  probeResource,
  releaseAll,
  type LockOptions,
  type ResourceProbe,
} from './locks.js';
import { runPool } from './pool.js';
import { prepareReceivedDir } from './receivedDir.js';
import type { ProducerTask, RunPlan } from './plan.js';

/** Post-conditions that invalidate an otherwise-successful producer. */
export type Disqualification =
  | 'ignored-output'
  | 'escaped-write'
  | 'symlink-output'
  | 'case-collision'
  | 'corpus-floor'
  | 'corpus-shrank'
  | 'output-budget';

export interface ProducerRun {
  readonly task: ProducerTask;
  /** The contract shape from ../types.ts. */
  readonly result: ProducerResult;
  readonly outcome: Outcome;
  readonly trust: Trust;
  /** Execution truth, kept separate from `outcome`: a producer that exited 0
   *  but wrote a gitignored file is `failed` for trust purposes while its exit
   *  code was still 0, and both facts belong in the report. */
  readonly spawn: SpawnOutcome | null;
  readonly inventory: Inventory | null;
  readonly files: readonly EmittedFile[];
  readonly census: CensusResult | null;
  readonly selectedIds: readonly string[] | null;
  readonly caseCount: number | null;
  readonly baselineCaseCount: number | null;
  readonly ignoredOutput: readonly RepoPath[];
  readonly escapes: readonly Escape[];
  readonly disqualifications: readonly Disqualification[];
  readonly findings: readonly RunnerFinding[];
  readonly leases: readonly string[];
  readonly envDiff: Readonly<Record<string, string>>;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface RunnerReport {
  readonly runId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly runs: readonly ProducerRun[];
  readonly findings: readonly RunnerFinding[];
  /**
   * Under `concurrency > 1` a stray write cannot be attributed to one producer,
   * so it is reported at run level and the report says which mode was used.
   * Degrading honestly beats inventing an attribution nobody can check.
   */
  readonly runLevelEscapes: readonly Escape[];
  readonly attribution: 'per-producer' | 'run-level';
  readonly aborted: boolean;
  /** Every selected producer reached `ok`. NOT a claim about the whole roster —
   *  `RunReport.fullyVerified` is computed against the committed policy lock,
   *  which this module deliberately does not read. */
  readonly allSelectedOk: boolean;
}

export interface RunProducersOptions {
  readonly repo: GitRepo;
  readonly plan: RunPlan;
  readonly runId: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
  readonly vibesVersion: string;
  readonly concurrency?: number | undefined;
  readonly limits?: Partial<RunnerLimits> | undefined;
  /** Machine-scoped. `null`/omitted → `$XDG_RUNTIME_DIR|tmpdir`/vibes-locks. */
  readonly lockDir?: string | null | undefined;
  /** Absolute. Default `<repoRoot>/.vibes/logs`. NEVER inside an out dir. */
  readonly logDir?: string | undefined;
  readonly sourceDateEpoch?: number | undefined;
  readonly baseEnv?: Readonly<Record<string, string | undefined>> | undefined;
  readonly submodules?: readonly RepoPath[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => number) | undefined;
  /** Injectable for tests; defaults to the real spawner. */
  readonly spawn?: RunCommand | undefined;
  readonly probe?: ResourceProbe | undefined;
  /**
   * From the committed policy lock. Defaults to `() => false`, which is the
   * safe direction: a snapshot renders `locally-accepted, never CI-verified`
   * until something proves otherwise.
   */
  readonly everCIVerified?: ((id: string) => boolean) | undefined;
}

export async function runProducers(opts: RunProducersOptions): Promise<RunnerReport> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const limits = resolveLimits(opts.limits);
  const repo = opts.repo;
  const repoRoot = repo.repoRoot;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const serial = concurrency === 1;
  const spawn = opts.spawn ?? runCommand;
  const probe = opts.probe ?? probeResource;
  const everCIVerified = opts.everCIVerified ?? ((): boolean => false);
  const logDir = opts.logDir ?? join(repoRoot, STATE_DIR, LOGS_DIR);
  const submodules = opts.submodules ?? (await safeSubmodules(repo));
  const sourceDateEpoch = opts.sourceDateEpoch ?? (await commitEpoch(repo, opts.headSha, startedAt));

  const lockOptions: LockOptions = {
    lockDir: lockDirFor(opts.lockDir ?? null),
    gitCommonDir: repo.gitCommonDir,
    runId: opts.runId,
    staleLockMs: limits.staleLockMs,
    waitMs: limits.lockWaitMs,
    pollMs: limits.lockPollMs,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };

  // Run-level status bracket. Under concurrency it is the ONLY honest
  // attribution available; under serial execution the per-producer brackets
  // below are strictly better and this one just backstops them.
  const runBefore = statusMap(await safeStatus(repo));

  const runOne = async (task: ProducerTask): Promise<ProducerRun> =>
    executeTask({
      task,
      repo,
      repoRoot,
      limits,
      logDir,
      spawn,
      probe,
      lockOptions,
      serial,
      submodules,
      outRepos: opts.plan.outRepos,
      baseSha: opts.baseSha,
      headSha: opts.headSha,
      runId: opts.runId,
      vibesVersion: opts.vibesVersion,
      sourceDateEpoch,
      everCIVerified,
      now,
      ...(opts.baseEnv === undefined ? {} : { baseEnv: opts.baseEnv }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });

  const pool = await runPool(opts.plan.tasks, runOne, {
    concurrency,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  const runAfter = statusMap(await safeStatus(repo));
  const runLevelEscapes = classifyEscapes(statusDelta(runBefore, runAfter), {
    outRepos: opts.plan.outRepos,
    submodules,
  });

  const findings: RunnerFinding[] = [];
  const runs: ProducerRun[] = [];

  for (const task of opts.plan.tasks) {
    const got = pool.results.get(task.id);
    if (got !== undefined) {
      runs.push(got);
      continue;
    }
    const err = pool.errors.get(task.id);
    if (err !== undefined) {
      runs.push(synthetic(task, 'spawnError', `runner error: ${err.message}`, everCIVerified, now()));
      continue;
    }
    const why = pool.deadlocked.includes(task.id) ? 'plan-deadlock' : 'cancelled';
    if (why === 'plan-deadlock') {
      findings.push(
        finding({
          code: 'V09B_PLAN_DEADLOCK',
          severity: 'error',
          file: task.manifestRepo,
          component: task.component,
          producer: task.name,
          message: 'producer was never schedulable; ordering edges or resource tokens conflict',
          evidence: [`after: ${task.after.join(', ') || '(none)'}`, `resources: ${task.resources.join(', ')}`],
          fix: 'break the dependsOn cycle, or drop the conflicting resource token',
        }),
      );
    }
    runs.push(synthetic(task, 'cancelled', why, everCIVerified, now()));
  }

  if (!serial && runLevelEscapes.length > 0) {
    findings.push(...escapeFindings(runLevelEscapes, null));
  }
  for (const r of runs) findings.push(...r.findings);

  const endedAt = now();
  return {
    runId: opts.runId,
    startedAt,
    endedAt,
    runs,
    findings: sortFindings(findings),
    runLevelEscapes,
    attribution: serial ? 'per-producer' : 'run-level',
    aborted: opts.signal?.aborted === true,
    allSelectedOk: runs.every((r) => !r.task.selected || r.outcome === 'ok'),
  };
}

/* ───────────────────────────── one producer ──────────────────────────── */

interface ExecuteInput {
  readonly task: ProducerTask;
  readonly repo: GitRepo;
  readonly repoRoot: string;
  readonly limits: RunnerLimits;
  readonly logDir: string;
  readonly spawn: RunCommand;
  readonly probe: ResourceProbe;
  readonly lockOptions: LockOptions;
  readonly serial: boolean;
  readonly submodules: readonly RepoPath[];
  readonly outRepos: readonly RepoPath[];
  readonly baseSha: Sha;
  readonly headSha: Sha;
  readonly runId: string;
  readonly vibesVersion: string;
  readonly sourceDateEpoch: number;
  readonly everCIVerified: (id: string) => boolean;
  readonly now: () => number;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

async function executeTask(input: ExecuteInput): Promise<ProducerRun> {
  const { task, repo, limits, now } = input;
  const startedAt = now();

  if (!task.selected) {
    return synthetic(task, 'not-selected', task.notSelectedReason ?? 'not selected', input.everCIVerified, startedAt);
  }
  // A registry entry whose root has vanished (an uninitialised submodule, a
  // stale checkout) is `not-discovered`, never `unchanged`.
  if (!existsSync(task.absRoot)) {
    return synthetic(task, 'not-discovered', `component root ${task.absRoot} does not exist`, input.everCIVerified, startedAt);
  }

  const findings: RunnerFinding[] = [];

  /* ── leases, then probes ─────────────────────────────────────────────
   * Order matters. We take the machine lease FIRST, so anything the probe
   * then finds holding the port or the PTY is outside Vibes' bookkeeping —
   * a hand-started emulator or an orphan from a killed run. */
  const lease = await acquireAll(task.resources, input.lockOptions);
  if (!lease.ok) {
    findings.push(
      finding({
        code: 'V095_RESOURCE_HELD',
        severity: 'error',
        file: task.manifestRepo,
        component: task.component,
        producer: task.name,
        message: `resource token '${lease.blockedToken ?? ''}' is held by another run`,
        evidence: [
          lease.blockedBy === null
            ? 'holder record unreadable'
            : `held by pid ${String(lease.blockedBy.pid)} on ${lease.blockedBy.host} (run ${lease.blockedBy.runId})`,
          `waited ${String(lease.waitedMs)}ms`,
        ],
        fix: 'wait for the other run to finish, or stop the process holding the resource',
      }),
    );
    return synthetic(task, 'blocked', `resource '${lease.blockedToken ?? ''}' held`, input.everCIVerified, startedAt, findings);
  }

  try {
    for (const token of task.resources) {
      const p = await input.probe(token);
      if (p.available) continue;
      findings.push(
        finding({
          code: 'V095_RESOURCE_HELD',
          severity: 'error',
          file: task.manifestRepo,
          component: task.component,
          producer: task.name,
          message: `declared resource '${token}' is already in use by a foreign holder`,
          evidence: [p.detail],
          fix: 'stop the process holding it, or remove the stale path/socket it left behind',
        }),
      );
      return synthetic(task, 'blocked', `resource '${token}' in use`, input.everCIVerified, startedAt, findings);
    }

    await prepareReceivedDir(input.repoRoot, task.receivedDir, task.clean);

    const before: StatusMap | null = input.serial ? statusMap(await safeStatus(repo)) : null;

    const ctx: ProducerEnvContext = {
      repoRoot: input.repoRoot,
      absRoot: task.absRoot,
      absVibesDir: task.absVibesDir,
      component: task.component,
      producer: task.name,
      receivedDir: task.receivedDir,
      baseSha: input.baseSha,
      headSha: input.headSha,
      runId: input.runId,
      vibesVersion: input.vibesVersion,
      sourceDateEpoch: input.sourceDateEpoch,
    };
    const built = buildProducerEnv(ctx, [task.env], input.baseEnv ?? process.env);
    for (const key of built.overridden) {
      findings.push(
        finding({
          code: 'V0A3_FIELD_TYPE',
          severity: 'warn',
          file: task.manifestRepo,
          locator: `producers[${task.name}].env.${key}`,
          component: task.component,
          producer: task.name,
          message: `env.${key} is injected by Vibes and cannot be overridden`,
          evidence: ['$VIBES_OUT_DIR is the write contract; a producer may not redirect it'],
          fix: `remove ${key} from the producer's env block`,
        }),
      );
    }

    const logs = logPathsFor(input.logDir, task.component, task.name);
    const spawned = await input.spawn({
      cmd: task.cmd,
      cwd: task.absCwd,
      env: built.env,
      timeoutMs: task.timeoutMs,
      idleTimeoutMs: input.limits.idleTimeoutMs,
      gracefulKillMs: input.limits.gracefulKillMs,
      killProbeMs: input.limits.killProbeMs,
      closeGraceMs: input.limits.closeGraceMs,
      maxOutputBytes: input.limits.maxOutputBytes,
      logTeeBytes: input.limits.logTeeBytes,
      stdoutLogPath: logs.stdout,
      stderrLogPath: logs.stderr,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const after: StatusMap | null = input.serial ? statusMap(await safeStatus(repo)) : null;
    const escapes: Escape[] =
      before !== null && after !== null
        ? [
            ...classifyEscapes(statusDelta(before, after), {
              outRepos: input.outRepos,
              ownOutRepo: task.outRepo,
              submodules: input.submodules,
            }),
          ]
        : [];
    findings.push(...escapeFindings(escapes, task));

    const inventory = await inventoryDir(task.receivedDir, {
      maxFiles: input.limits.maxFilesPerProducer,
      maxFileBytes: input.limits.maxFileBytes,
    });
    const census = await readCensus(task.receivedDir);
    const selectedIds = await readSelection(task.receivedDir);
    const caseCount = countCases(inventory.files, census);

    const ignoredOutput = await checkProducedIgnored(repo, task.outRepo, inventory.files);
    const base = task.hasBaseline
      ? await baselineCaseCount(repo, input.baseSha, task.outRepo)
      : { count: null, fromCensus: false };

    const disq: Disqualification[] = [];
    findings.push(...outputShapeFindings(task, inventory, input.limits, disq));

    if (ignoredOutput.length > 0) {
      disq.push('ignored-output');
      findings.push(
        finding({
          code: 'V046_OUT_IGNORED_FILE',
          severity: 'error',
          file: task.outRepo,
          component: task.component,
          producer: task.name,
          message: 'produced files are gitignored and would be invisible in the baseline',
          evidence: [
            ...ignoredOutput.slice(0, 20),
            ignoredOutput.length > 20 ? `… and ${String(ignoredOutput.length - 20)} more` : '',
            'a bare `*.log`/`*.tmp` pattern at the repo root reaches into a snapshot directory',
          ].filter((s) => s !== ''),
          fix: 'rename the produced files, or add a `!` re-include next to the pattern that matched',
        }),
      );
    }
    if (escapes.length > 0) disq.push('escaped-write');

    findings.push(...corpusFindings(task, caseCount, base.count, selectedIds, disq));

    if (spawned.orphanedGroup) {
      findings.push(
        finding({
          code: 'V096_ORPHANED_GROUP',
          severity: 'warn',
          file: task.manifestRepo,
          component: task.component,
          producer: task.name,
          message: 'the producer left a process group alive after SIGKILL',
          evidence: [`pid ${String(spawned.pid ?? -1)}`, 'the next producer declaring the same port or path will be blocked'],
          fix: 'have the producer reap its own children, or add a teardown step to the command',
        }),
      );
    }

    const outcome = decideOutcome(spawned, inventory.files, disq);
    const endedAt = now();

    return {
      task,
      outcome,
      trust: isTrusted(outcome),
      spawn: spawned,
      inventory,
      files: inventory.files,
      census,
      selectedIds,
      caseCount,
      baselineCaseCount: base.count,
      ignoredOutput,
      escapes,
      disqualifications: disq,
      findings: sortFindings(findings),
      leases: task.resources,
      envDiff: envDiff(built.env, input.baseEnv ?? process.env),
      startedAt,
      endedAt,
      result: {
        component: task.component,
        producer: task.name,
        outcome,
        exitCode: spawned.code,
        signal: spawned.signal,
        durationMs: endedAt - startedAt,
        stdoutPath: toRepoRel(input.repoRoot, spawned.stdoutPath),
        stderrPath: toRepoRel(input.repoRoot, spawned.stderrPath),
        emitted: inventory.files.map((f) => f.file),
        warnings: findings.filter((f) => f.severity !== 'error').map((f) => `${f.code}: ${f.message}`),
        everCIVerified: input.everCIVerified(task.id),
      },
    };
  } finally {
    await releaseAll(lease.leases);
  }
}

/* ─────────────────────────── decision helpers ────────────────────────── */

export function decideOutcome(
  spawned: SpawnOutcome,
  files: readonly EmittedFile[],
  disqualifications: readonly Disqualification[],
): Outcome {
  if (spawned.failure === 'spawn-error') return 'spawnError';
  if (spawned.failure === 'cancelled') return 'cancelled';
  if (spawned.failure === 'timeout' || spawned.failure === 'idle-timeout') return 'timedOut';
  if (spawned.code !== 0) return 'failed';
  // Exit 0 with nothing written is an ERROR, not a warning. Reporting every
  // baseline file as deleted instead would be the worst available outcome.
  if (files.length === 0) return 'emptyOutput';
  // `Outcome` carries no member for "ran fine but its output is disqualified",
  // and `isTrusted` derives trust from the outcome alone — so a disqualified
  // producer must map to a non-ok outcome or the contract would call it
  // verified. The precise reason survives in `disqualifications`.
  if (disqualifications.length > 0) return 'failed';
  return 'ok';
}

function outputShapeFindings(
  task: ProducerTask,
  inv: Inventory,
  limits: RunnerLimits,
  disq: Disqualification[],
): readonly RunnerFinding[] {
  const out: RunnerFinding[] = [];
  if (inv.symlinks.length > 0) {
    disq.push('symlink-output');
    out.push(
      finding({
        code: 'V098_SYMLINK_OUTPUT',
        severity: 'error',
        file: task.outRepo,
        component: task.component,
        producer: task.name,
        message: 'the producer wrote symlinks into its out dir',
        evidence: inv.symlinks.slice(0, 20),
        fix: 'write real files; a link lets the comparator read bytes the producer did not emit',
      }),
    );
  }
  if (inv.caseCollisions.length > 0) {
    disq.push('case-collision');
    out.push(
      finding({
        code: 'V099_CASE_COLLISION',
        severity: 'error',
        file: task.outRepo,
        component: task.component,
        producer: task.name,
        message: 'produced paths differ only by case; one of them dies on a case-insensitive checkout',
        evidence: inv.caseCollisions.slice(0, 10).map((g) => g.join(' ~ ')),
        fix: 'make the produced filenames differ by more than case',
      }),
    );
  }
  const oversize = inv.files.filter((f) => f.oversize);
  if (inv.truncated || oversize.length > 0) {
    disq.push('output-budget');
    out.push(
      finding({
        code: 'V09A_OUTPUT_BUDGET',
        severity: 'error',
        file: task.outRepo,
        component: task.component,
        producer: task.name,
        message: inv.truncated ? 'producer emitted more files than the budget allows' : 'produced file exceeds the size budget',
        evidence: [
          `files: ${String(inv.files.length)} (max ${String(limits.maxFilesPerProducer)})`,
          ...oversize.slice(0, 10).map((f) => `${f.file}: ${String(f.bytes)} bytes (max ${String(limits.maxFileBytes)})`),
        ],
        fix: 'reduce the corpus, or raise budget.maxFilesPerProducer / budget.maxFileBytes deliberately',
      }),
    );
  }
  return out;
}

/**
 * `minCases`, enforced BOTH ways.
 *
 * The declared floor alone is not a guard, because the same agent that shrinks
 * the corpus can lower the number in the same PR. The monotonic check against
 * the committed baseline is the one that bites: emitting fewer cases than last
 * time is a shrink whatever the manifest now says.
 *
 * A declared `.vibes-selected` legitimately narrows the expectation — MaD's
 * smoke lane emits 18 of 32 — so under a selection the comparison is against
 * the selection size, not the baseline. Without that, every CI run would report
 * 14 deletions and the real signal would be permanently disarmed.
 */
function corpusFindings(
  task: ProducerTask,
  caseCount: number,
  baseCount: number | null,
  selectedIds: readonly string[] | null,
  disq: Disqualification[],
): readonly RunnerFinding[] {
  const out: RunnerFinding[] = [];

  if (task.minCases !== null && caseCount < task.minCases) {
    disq.push('corpus-floor');
    out.push(
      finding({
        code: 'V088_CORPUS_FLOOR',
        severity: 'error',
        file: task.manifestRepo,
        locator: `producers[${task.name}].minCases`,
        component: task.component,
        producer: task.name,
        message: 'producer emitted fewer cases than its declared floor',
        evidence: [`emitted ${String(caseCount)}`, `minCases ${String(task.minCases)}`],
        fix: 'restore the missing cases, or lower minCases in a reviewable, separate commit',
      }),
    );
  }

  const expected = selectedIds !== null ? selectedIds.length : baseCount;
  if (expected !== null && caseCount < expected) {
    disq.push('corpus-shrank');
    out.push(
      finding({
        code: 'V097_CORPUS_SHRANK',
        severity: 'error',
        file: task.outRepo,
        component: task.component,
        producer: task.name,
        message:
          selectedIds !== null
            ? 'producer emitted fewer cases than its own declared selection'
            : 'producer emitted fewer cases than the committed baseline',
        evidence: [
          `emitted ${String(caseCount)}`,
          selectedIds !== null
            ? `.vibes-selected declares ${String(selectedIds.length)}`
            : `baseline holds ${String(expected)}`,
          'a shrinking corpus makes a diff disappear without anyone deciding it should',
        ],
        fix: 'restore the cases, or record the removal explicitly via the corpus source of truth',
      }),
    );
  }

  return out;
}

function escapeFindings(escapes: readonly Escape[], task: ProducerTask | null): readonly RunnerFinding[] {
  const codeFor = (kind: Escape['kind']): 'V085_CROSS_OUT' | 'V084_MUTATED_SOURCE' | 'V083_STRAY_WRITE' | 'V086_SUBMODULE_DIRTY' => {
    switch (kind) {
      case 'baseline-write':
        return 'V085_CROSS_OUT';
      case 'mutated-source':
        return 'V084_MUTATED_SOURCE';
      case 'submodule-dirty':
        return 'V086_SUBMODULE_DIRTY';
      default:
        return 'V083_STRAY_WRITE';
    }
  };
  return escapes.map((e) =>
    finding({
      code: codeFor(e.kind),
      severity: 'error',
      file: e.path,
      ...(task === null ? {} : { component: task.component, producer: task.name }),
      message:
        task === null
          ? 'a producer wrote outside its out dir (attribution is run-level under concurrency)'
          : 'producer wrote outside its out dir',
      evidence: [`git status: ${e.status}`, e.detail],
      fix: 'write only to $VIBES_OUT_DIR; the committed baseline is written by `vibes accept` alone',
    }),
  );
}

/**
 * Per-file `check-ignore` over the produced list, mapped onto where each file
 * WOULD land in the committed baseline.
 *
 * A directory-level probe is not enough and this is the check that matters:
 * `vibes/snapshots/` is not ignored anywhere, while `vibes/snapshots/run.log`,
 * `…/parse.bin` and `…/x.tmp` all are, through bare extension patterns in a
 * root `.gitignore`. Verified in a scratch repo, and it is invisible to every
 * directory-shaped check.
 */
export async function checkProducedIgnored(
  repo: GitRepo,
  outRepo: RepoPath,
  files: readonly EmittedFile[],
): Promise<readonly RepoPath[]> {
  if (files.length === 0) return [];
  const paths = files.map((f) => `${outRepo}/${f.file}`);
  try {
    const answers = await repo.checkIgnore(paths);
    return answers.filter((a) => a.ignored).map((a) => a.path);
  } catch {
    // check-ignore fatals inside a submodule; config rejects an out dir there,
    // so reaching this branch means something stranger. Do not invent an answer.
    return [];
  }
}

/* ──────────────────────────── small helpers ──────────────────────────── */

export function logPathsFor(
  logDir: string,
  component: ComponentId,
  producer: ProducerName,
): { readonly stdout: string; readonly stderr: string } {
  return {
    stdout: join(logDir, component, `${producer}.out.log`),
    stderr: join(logDir, component, `${producer}.err.log`),
  };
}

function toRepoRel(repoRoot: string, abs: string | null): string | null {
  if (abs === null) return null;
  const rel = relative(resolve(repoRoot), resolve(abs));
  // A report carries no absolute path except repoRoot itself.
  return rel.startsWith('..') ? abs : rel.split(/[\\/]/).join('/');
}

function synthetic(
  task: ProducerTask,
  outcome: Outcome,
  reason: string,
  everCIVerified: (id: string) => boolean,
  at: number,
  findings: readonly RunnerFinding[] = [],
): ProducerRun {
  return {
    task,
    outcome,
    trust: isTrusted(outcome),
    spawn: null,
    inventory: null,
    files: [],
    census: null,
    selectedIds: null,
    caseCount: null,
    baselineCaseCount: null,
    ignoredOutput: [],
    escapes: [],
    disqualifications: [],
    findings: sortFindings(findings),
    leases: [],
    envDiff: {},
    startedAt: at,
    endedAt: at,
    result: {
      component: task.component,
      producer: task.name,
      outcome,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdoutPath: null,
      stderrPath: null,
      emitted: [],
      // The reason is mandatory and it rides in the contract's `warnings`,
      // because `not-run` may never share a rendering with `verified-unchanged`
      // and the renderer needs the sentence to print.
      warnings: [`${outcome}: ${reason}`],
      everCIVerified: everCIVerified(task.id),
    },
  };
}

async function safeStatus(repo: GitRepo): Promise<readonly StatusEntry[]> {
  try {
    return await repo.status();
  } catch {
    return [];
  }
}

async function safeSubmodules(repo: GitRepo): Promise<readonly RepoPath[]> {
  try {
    return await repo.submodulePaths();
  } catch {
    return [];
  }
}

/**
 * `SOURCE_DATE_EPOCH` from the HEAD commit, not from the wall clock.
 *
 * A producer that stamps a date then emits the SAME bytes on every re-run of
 * the same commit, which is the difference between a snapshot that churns on
 * every CI run and one that only moves when behaviour does.
 */
async function commitEpoch(repo: GitRepo, headSha: Sha, fallbackMs: number): Promise<number> {
  try {
    const r = await repo.exec(['log', '-1', '--format=%ct', headSha]);
    const n = Number(r.stdout.toString('utf8').trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    /* unborn HEAD, or an unreachable sha on a shallow clone */
  }
  return Math.floor(fallbackMs / 1000);
}

export { hasError };
