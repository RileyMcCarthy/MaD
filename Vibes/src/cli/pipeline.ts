/**
 * The composition. Every module below is independently tested; this file is
 * the only place that knows the ORDER, and the order is where the honesty
 * guarantees actually live.
 *
 *   openRepo → resolveBase → resolveConfig → buildPlan → runProducers
 *            → categorizeSnapshots + compare → categorizeChangedPaths
 *            → ingest → verifyReceipts → checkHonesty → RunReport
 *
 * Two gates run BEFORE any producer, because a producer that has already run
 * makes a wrong answer look like a measured one:
 *   1. base must resolve exactly, and must not equal HEAD
 *   2. config must have zero error-severity diagnostics
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentResult, ComponentState, Finding, ProducerResult, RepoPath, RunReport,
  SnapshotResult, SnapState, Sha, Verdict,
} from '../types.js';
import type { SnapshotContentProvider } from '../emit/index.js';
import { resolveConfig, type ComponentPlan, type ResolvedConfig } from '../config/index.js';
import { openRepo, resolveBase, categorizeChangedPaths, categorizeSnapshots, type GitRepo } from '../git/index.js';
import { buildPlan, runProducers, type ProducerRun } from '../runner/index.js';
import { compareSnapshotFile } from '../compare/index.js';
import { verifyProducer } from '../honesty/index.js';
import { checkHonesty, toContractFinding } from '../honesty/index.js';
import { EXIT, type ExitCode } from './exit.js';

export interface PipelineOptions {
  readonly cwd: string;
  readonly explicitBase?: string | null;
  readonly only?: readonly string[];
  readonly skip?: readonly string[];
  readonly all?: boolean;
  readonly tier?: string | undefined;
  readonly vibesVersion: string;
  readonly log: (line: string) => void;
}

export interface PipelineOutcome {
  readonly report: RunReport | null;
  readonly exitCode: ExitCode;
  /** Set when a gate stopped the run before producers ran. */
  readonly gate: string | null;
  /** How to fetch bytes for a snapshot: baseline from a git blob at base,
   *  received from the gitignored scratch dir. The emitter must not know
   *  about either location, so the composer hands it a provider. */
  readonly content: SnapshotContentProvider | null;
  readonly repoPathFor: ((s: SnapshotResult) => RepoPath) | null;
}

/** Producer outcome + git status → the six-state snapshot vocabulary.
 *  `not-run` DOMINATES: if the producer did not complete, we did not look, and
 *  no git status may be upgraded into a claim about behaviour. */
function snapStateOf(producerOk: boolean, status: string, verdict: Verdict): SnapState {
  if (!producerOk) return 'not-run';
  switch (status) {
    case 'unchanged':
      return verdict.kind === 'identical' || verdict.kind === 'equivalent'
        ? 'verified-unchanged'
        : 'changed';
    case 'modified':
    case 'renamed':
      return 'changed';
    case 'added': return 'added';
    case 'deleted': return 'deleted';
    case 'not-selected': return 'not-selected';
    default: return 'not-run';
  }
}

function componentStateOf(
  plan: ComponentPlan,
  producerRuns: readonly ProducerRun[],
  snaps: readonly SnapshotResult[],
): ComponentState {
  if (plan.status === 'disabled' || plan.producers.length === 0) return 'not-configured';
  const ran = producerRuns.filter((r) => r.outcome === 'ok');
  if (ran.length === 0) return 'not-run';
  if (producerRuns.some((r) => r.outcome !== 'ok' && r.outcome !== 'not-selected')) return 'partial';
  if (plan.producers.every((p) => !p.hasBaseline)) return 'bootstrap';
  return snaps.some((s) => s.state === 'changed' || s.state === 'added' || s.state === 'deleted')
    ? 'changed'
    : 'verified-unchanged';
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineOutcome> {
  const { log } = opts;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const repo: GitRepo = await openRepo({ cwd: opts.cwd });

  /* ── gate 1: the comparison base ─────────────────────────────────────── */
  const rootLoad = await resolveConfig({
    repoRoot: repo.repoRoot,
    baseRef: 'HEAD', baseSha: '0'.repeat(40), headSha: '0'.repeat(40),
  });
  const declaredBaseRef = rootLoad.raw?.baseRef ?? 'origin/main';

  const base = await resolveBase({
    repo,
    baseRef: declaredBaseRef,
    explicit: opts.explicitBase ?? null,
    requireExact: true,
  });

  if (base.sameAsHead) {
    log('vibes: base and HEAD are the same commit — there is no range to compare.');
    log('       Nothing is claimed about behaviour. This is not a pass.');
    return { report: null, exitCode: EXIT.BASE, gate: 'base-equals-head', content: null, repoPathFor: null };
  }
  const headSha = (base.headSha ?? (await repo.revParse('HEAD'))) as Sha;
  for (const w of base.warnings) log(`vibes: base warning — ${String(w)}`);

  /* ── gate 2: config ──────────────────────────────────────────────────── */
  const config: ResolvedConfig = await resolveConfig({
    repoRoot: repo.repoRoot,
    baseRef: declaredBaseRef,
    baseSha: base.sha,
    headSha,
    git: repo,
    ...(opts.only !== undefined ? { only: opts.only } : {}),
    ...(opts.skip !== undefined ? { skip: opts.skip } : {}),
    ...(opts.all !== undefined ? { all: opts.all } : {}),
  });

  for (const d of config.diagnostics) log(`vibes: ${d.severity}: ${d.message ?? String(d.code)}`);
  if (!config.ok) {
    log('vibes: config has error-severity diagnostics; no producer ran.');
    return { report: null, exitCode: EXIT.CONFIG, gate: 'config-invalid', content: null, repoPathFor: null };
  }

  /* ── run ─────────────────────────────────────────────────────────────── */
  const plan = buildPlan(config, {});
  const runId = `${base.sha.slice(0, 8)}-${headSha.slice(0, 8)}-${t0.toString(36)}`;
  const declaredCount = config.components.reduce((a, c) => a + c.producers.length, 0);
  const selectedCount = plan.tasks.length;
  log(
    `vibes: ${selectedCount} of ${declaredCount} declared producer(s) selected, ` +
    `base ${base.sha.slice(0, 8)} → head ${headSha.slice(0, 8)}`,
  );

  const runner = await runProducers({
    repo, plan, runId,
    baseSha: base.sha, headSha,
    vibesVersion: opts.vibesVersion,
    concurrency: config.concurrency,
  });

  /* ── compare, per producer ───────────────────────────────────────────── */
  const byComponent = new Map<string, { runs: ProducerRun[]; snaps: SnapshotResult[]; producers: ProducerResult[] }>();

  for (const run of runner.runs) {
    const key = run.task.component;
    let bucket = byComponent.get(key);
    if (bucket === undefined) {
      bucket = { runs: [], snaps: [], producers: [] };
      byComponent.set(key, bucket);
    }
    bucket.runs.push(run);
    bucket.producers.push(run.result);

    const producerOk = run.outcome === 'ok';
    const cat = await categorizeSnapshots(repo, {
      base: base.sha,
      baselineDir: run.task.outRepo,
      received: run.inventory?.files ?? [],
      selectedFiles: run.selectedIds,
    });
    for (const w of cat.warnings) log(`vibes: ${key}/${run.task.name}: ${w}`);

    const compareSpec = findCompareSpec(config, key, run.task.name);

    for (const entry of cat.entries) {
      let verdict: Verdict = { kind: 'not-run', mode: 'exact' };
      if (producerOk && entry.status !== 'not-selected') {
        const baseline = entry.baselineOid === null
          ? null
          : await repo.readBlob(base.sha, `${run.task.outRepo}/${entry.file}`);
        const received = entry.receivedSha256 === null
          ? null
          : await readFile(join(run.task.receivedDir, entry.file)).catch(() => null);

        if (baseline === null && received === null) {
          verdict = { kind: 'deleted', mode: 'exact' };
        } else {
          const res = compareSnapshotFile({
            file: entry.file,
            spec: compareSpec,
            baseline,
            received,
          });
          verdict = res.verdict;
        }
      } else if (entry.status === 'not-selected') {
        verdict = { kind: 'not-selected', mode: 'exact' };
      }

      bucket.snaps.push({
        component: key,
        producer: run.task.name,
        file: entry.file,
        state: snapStateOf(producerOk, entry.status, verdict),
        verdict,
        baselineSha256: entry.baselineSha256,
        receivedSha256: entry.receivedSha256,
        receiptId: null,
        renderer: null,
        bytes: entry.bytes ?? 0,
      });

      if (entry.ignored) {
        log(`vibes: WARNING ${key}/${run.task.name}: ${entry.file} is gitignored (${entry.ignoreRule ?? '?'}) — git will never show it`);
      }
    }
  }

  /* ── changed source + receipts + honesty ─────────────────────────────── */
  const changed = await categorizeChangedPaths(repo, {
    base: base.sha,
    // Snapshots are stream-A OUTPUT, never source. Counting them as changed
    // source would let a producer witness itself.
    excludeDirs: plan.outRepos,
    lineDetail: true,
  });

  const verifications = [];
  for (const c of config.components) {
    for (const p of c.producers) {
      if (!p.hasBaseline) continue;
      verifications.push(await verifyProducer(repo, {
        component: c.id,
        producer: p.resolved.name,
        outDir: p.outRepo,
        baseSha: base.sha,
        headSha,
      }));
    }
  }

  const honesty = checkHonesty({
    baseRef: declaredBaseRef,
    baseSha: base.sha,
    headSha,
    changed: changed.paths,
    components: config.components.map((c) => {
      const b = byComponent.get(c.id);
      return {
        id: c.id,
        root: c.rootRepo,
        status: c.status,
        // repoGlob, not the authored glob: the join runs in repo-root space.
        witnesses: c.witnessMatches.map((w) => (w.negated ? '!' + w.repoGlob : w.repoGlob)),
        generates: c.resolved.entry.generates ?? [],
        submodules: c.resolved.entry.submodules ?? [],
        producers: c.producers.map((p) => {
          const run = b?.runs.find((r) => r.task.name === p.resolved.name);
          return {
            name: p.resolved.name,
            outDir: p.outRepo,
            outcome: run?.outcome ?? ('not-selected' as const),
            hasBaseline: p.hasBaseline,
            everCIVerified: run?.result.everCIVerified ?? false,
            ciJob: p.resolved.ciJob ?? null,
            snapshots: (b?.snaps ?? []).filter((s2) => s2.producer === p.resolved.name),
          };
        }),
      };
    }),
    verifications,
    tracked: await repo.listFiles(),
    baseConfidence: base.confidence === 'exact' ? 'exact' : 'approximate',
  });

  /* ── assemble ────────────────────────────────────────────────────────── */
  const components: ComponentResult[] = config.components.map((plan_) => {
    const b = byComponent.get(plan_.id) ?? { runs: [], snaps: [], producers: [] };
    return {
      component: plan_.id,
      state: componentStateOf(plan_, b.runs, b.snaps),
      producers: b.producers,
      snapshots: b.snaps,
      tests: null,
      coverage: null,
      findings: honesty.effective
        .filter((f) => f.component === plan_.id)
        .map(toContractFinding),
      exercisedWitnessPaths: [],
      unclaimedPaths: [],
    };
  });

  // fullyVerified comes from the honesty module, which computes it over the
  // DECLARED roster rather than over what this invocation happened to run — a
  // component that vanished from discovery cannot make the run look complete.
  const fullyVerified = honesty.fullyVerified;

  // Disjoint by construction: a finding attributed to a component lives on
  // that component. Putting it in BOTH lists makes the emitter print it twice.
  const findings: readonly Finding[] = honesty.effective
    .filter((f) => f.component === undefined || f.component === null)
    .map(toContractFinding);
  const hasError = honesty.counts.error > 0;
  const producerFailed = runner.runs.some((r) => r.outcome !== 'ok' && r.outcome !== 'not-selected');

  const exitCode: ExitCode = producerFailed
    ? EXIT.PRODUCER
    : hasError
      ? EXIT.FINDINGS
      : EXIT.OK;

  const report: RunReport = {
    version: 1,
    baseRef: declaredBaseRef,
    baseSha: base.sha,
    headSha,
    startedAt,
    durationMs: Date.now() - t0,
    components,
    findings,
    fullyVerified,
    exitCode,
  };

  const where = new Map<string, { outRepo: RepoPath; receivedDir: string }>();
  for (const t of plan.tasks) where.set(`${t.component}/${t.name}`, { outRepo: t.outRepo, receivedDir: t.receivedDir });

  const repoPathFor = (s2: SnapshotResult): RepoPath => {
    const w = where.get(`${s2.component}/${s2.producer}`);
    return w === undefined ? s2.file : (`${w.outRepo}/${s2.file}` as RepoPath);
  };

  const content: SnapshotContentProvider = async (ref) => {
    const w = where.get(`${ref.component}/${ref.producer}`);
    if (w === undefined) return { baseline: null, received: null };
    const [baseline, received] = await Promise.all([
      repo.readBlob(base.sha, `${w.outRepo}/${ref.file}` as RepoPath).catch(() => null),
      readFile(join(w.receivedDir, ref.file)).catch(() => null),
    ]);
    return { baseline, received };
  };

  return { report, exitCode, gate: null, content, repoPathFor };
}

function findCompareSpec(config: ResolvedConfig, component: string, producer: string) {
  for (const c of config.components) {
    if (c.id !== component) continue;
    for (const p of c.producers) {
      if (p.resolved.name === producer) return p.resolved.compareSpec;
    }
  }
  return { kind: 'exact' } as const;
}
