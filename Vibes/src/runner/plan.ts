/**
 * ResolvedConfig → an executable plan.
 *
 * This is the only file in `runner/` that knows about `config/`. Everything
 * else takes a `ProducerTask`, which is why the exec, lock, inventory and pool
 * layers are unit-testable without a repo, a registry or a manifest.
 *
 * Selection is recorded, never elided. A producer that will not run this
 * invocation still appears in the plan with `selected: false` and a reason, so
 * the report can print `not-selected` by name. A plan that simply omitted it
 * would let a component vanish from a report and read as silence — and silence
 * reads as "fine".
 */

import { existsSync } from 'node:fs';

import type { ComponentId, ProducerTier, RepoPath, RunWhen, CompareSpec } from '../types.js';
import type { ComponentPlan, ProducerPlan, ResolvedConfig } from '../config/index.js';
import { applyProducer, mergeDefaults, raiseRunWhen } from '../config/index.js';
import type { EnvMap } from '../config/index.js';
import { defaultResourceTokens } from './constants.js';
import { finding, hasError, sortFindings, type RunnerFinding } from './findings.js';
import { shPortabilityHazards } from './exec.js';
import { findCycles, type PoolTask } from './pool.js';

export type NotSelectedReason =
  | 'component-disabled'
  | 'component-skipped-cli'
  | 'component-unusable'
  | 'component-root-missing'
  | 'tier-not-selected'
  | 'unchanged';

export interface ProducerTask extends PoolTask {
  /** `${component}/${name}`. Explicit, never derived from a test name. */
  readonly id: string;
  readonly component: ComponentId;
  readonly name: string;
  readonly cmd: string;
  readonly absCwd: string;
  readonly absRoot: string;
  readonly absVibesDir: string;
  /** GITIGNORED scratch. Becomes `$VIBES_OUT_DIR`. */
  readonly receivedDir: string;
  readonly receivedRepo: RepoPath;
  /** COMMITTED baseline. Opened O_RDONLY by `vibes run`, never for write. */
  readonly baselineDir: string;
  readonly outRepo: RepoPath;
  readonly env: EnvMap;
  readonly timeoutMs: number;
  readonly clean: boolean;
  readonly tier: ProducerTier;
  readonly ciJob: string | null;
  readonly minCases: number | null;
  readonly compare: CompareSpec;
  readonly runWhen: RunWhen;
  readonly forcedAlways: boolean;
  readonly hasBaseline: boolean;
  readonly selected: boolean;
  readonly notSelectedReason: NotSelectedReason | null;
  readonly manifestRepo: RepoPath;
}

export interface RunPlan {
  readonly tasks: readonly ProducerTask[];
  /** Every producer's committed out dir — the escape classifier needs all of
   *  them, not just the one being run. */
  readonly outRepos: readonly RepoPath[];
  readonly findings: readonly RunnerFinding[];
  readonly tierTotals: Readonly<Record<string, number>>;
  readonly ok: boolean;
}

export interface BuildPlanOptions {
  /**
   * Components with a changed witness/gitlink/generated input this diff.
   * OMITTED means "cannot tell" and everything runs — the safe direction. A
   * plan that skipped on an unknown change set would mint `unchanged` verdicts
   * for producers that never executed, which is the exact lie the state
   * vocabulary exists to prevent.
   */
  readonly changedComponents?: ReadonlySet<ComponentId> | undefined;
  /** Which tiers this invocation runs. Omitted = all tiers. */
  readonly tiers?: readonly ProducerTier[] | undefined;
  readonly tierBudgetMs?: Readonly<Partial<Record<ProducerTier, number>>> | undefined;
  /** Default mutual-exclusion tokens for a producer that declares none. */
  readonly defaultResources?: ((component: ComponentId, name: string) => readonly string[]) | undefined;
}

const DEFAULT_TIER: ProducerTier = 'pr';

export function buildPlan(config: ResolvedConfig, opts: BuildPlanOptions = {}): RunPlan {
  const findings: RunnerFinding[] = [];
  const tasks: ProducerTask[] = [];
  const outRepos: RepoPath[] = [];
  const defaultResources = opts.defaultResources ?? ((c: ComponentId) => defaultResourceTokens(c));

  for (const component of config.components) {
    for (const producer of component.producers) {
      outRepos.push(producer.outRepo);
      const task = buildTask(config, component, producer, opts, defaultResources);
      tasks.push(task);
      findings.push(...lintTask(task));
    }
  }

  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const cycle = findCycles(tasks);
  if (cycle.length > 0) {
    findings.push(
      finding({
        code: 'V029_DEPENDSON_CYCLE',
        severity: 'error',
        file: 'vibes.config.mjs',
        message: 'dependsOn ordering forms a cycle; these producers can never be scheduled',
        evidence: cycle,
        fix: 'break the cycle in components[].dependsOn',
      }),
    );
  }

  const tierTotals = totalsByTier(tasks);
  findings.push(...checkTierBudget(tierTotals, opts.tierBudgetMs));

  return {
    tasks,
    outRepos: [...new Set(outRepos)].sort(),
    findings: sortFindings(findings),
    tierTotals,
    ok: !hasError(findings),
  };
}

function buildTask(
  config: ResolvedConfig,
  component: ComponentPlan,
  producer: ProducerPlan,
  opts: BuildPlanOptions,
  defaultResources: (component: ComponentId, name: string) => readonly string[],
): ProducerTask {
  const p = producer.resolved;
  // Reuse config's own precedence chain rather than reimplementing it: the env
  // layering rules (merge key-by-key, `null` means unset) live in exactly one
  // place, and a second implementation would drift.
  const defaults = mergeDefaults([config.raw?.defaults, component.effective?.defaults]);
  const effective = applyProducer(defaults, p);
  const runWhen = raiseRunWhen(effective.runWhen, component.forcedAlways || producer.forcedAlways);

  const resources = [
    ...new Set(p.resources !== undefined && p.resources.length > 0 ? p.resources : defaultResources(component.id, p.name)),
  ].sort();

  // dependsOn is a COMPONENT-level edge in the registry; producers inherit it
  // as "run after every producer of every component in my closure".
  const after: string[] = [];
  for (const dep of component.closure) {
    const depComponent = config.components.find((c) => c.id === dep);
    if (depComponent === undefined) continue;
    for (const dp of depComponent.producers) after.push(`${dep}/${dp.resolved.name}`);
  }

  const selection = selectionFor(component, opts, runWhen);

  return {
    id: `${component.id}/${p.name}`,
    component: component.id,
    name: p.name,
    cmd: p.cmd,
    absCwd: p.absCwd,
    absRoot: component.resolved.absRoot,
    absVibesDir: component.resolved.absVibesDir,
    receivedDir: p.receivedDir,
    receivedRepo: producer.receivedRepo,
    baselineDir: p.baselineDir,
    outRepo: producer.outRepo,
    env: effective.env,
    timeoutMs: p.effectiveTimeoutMs,
    clean: p.effectiveClean,
    tier: p.tier ?? DEFAULT_TIER,
    ciJob: p.ciJob ?? null,
    minCases: p.minCases ?? null,
    compare: p.compareSpec,
    runWhen,
    forcedAlways: component.forcedAlways || producer.forcedAlways,
    hasBaseline: producer.hasBaseline,
    resources,
    after: after.sort(),
    selected: selection.selected,
    notSelectedReason: selection.reason,
    manifestRepo: component.manifestRepo,
  };
}

function selectionFor(
  component: ComponentPlan,
  opts: BuildPlanOptions,
  runWhen: RunWhen,
): { selected: boolean; reason: NotSelectedReason | null } {
  switch (component.status) {
    case 'disabled':
      return { selected: false, reason: 'component-disabled' };
    case 'skipped-cli':
      return { selected: false, reason: 'component-skipped-cli' };
    case 'unusable':
      return { selected: false, reason: 'component-unusable' };
    default:
      break;
  }
  if (!existsSync(component.resolved.absRoot)) {
    return { selected: false, reason: 'component-root-missing' };
  }
  // `changedComponents` omitted means "not computed" — run everything. Only an
  // explicitly-supplied set may cause a skip.
  if (runWhen === 'changed' && opts.changedComponents !== undefined) {
    if (!opts.changedComponents.has(component.id)) return { selected: false, reason: 'unchanged' };
  }
  return { selected: true, reason: null };
}

function lintTask(task: ProducerTask): readonly RunnerFinding[] {
  const out: RunnerFinding[] = [];
  const hazards = shPortabilityHazards(task.cmd);
  if (hazards.length > 0) {
    out.push(
      finding({
        code: 'V093_SH_PORTABILITY',
        severity: 'warn',
        file: task.manifestRepo,
        locator: `producers[${task.name}].cmd`,
        component: task.component,
        producer: task.name,
        message: 'cmd uses shell syntax /bin/sh (dash on Ubuntu) does not accept',
        evidence: [...hazards, `cmd: ${task.cmd}`],
        fix: 'rewrite in POSIX sh, or invoke bash explicitly: `bash -c "..."`',
      }),
    );
  }
  if (task.ciJob === null && task.selected) {
    out.push(
      finding({
        code: 'V04G_CIJOB_MISSING',
        severity: 'warn',
        file: task.manifestRepo,
        locator: `producers[${task.name}].ciJob`,
        component: task.component,
        producer: task.name,
        message: 'producer declares no CI job, so its snapshots can only ever be locally accepted',
        evidence: [],
        fix: 'set `ciJob` to the workflow job that runs this producer',
      }),
    );
  }
  return out;
}

export function totalsByTier(tasks: readonly ProducerTask[]): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const t of tasks) {
    if (!t.selected) continue;
    totals[t.tier] = (totals[t.tier] ?? 0) + t.timeoutMs;
  }
  return totals;
}

/**
 * The tier wall-clock budget, enforced BEFORE the first spawn.
 *
 * The failure mode this prevents is specific: an emulator producer lands on the
 * PR lane, and the team discovers at minute 55 of a 10-minute gate that the
 * whole thing cannot fit. A budget checked at preflight is a config error with
 * a name; a budget discovered at runtime is an outage.
 */
export function checkTierBudget(
  totals: Readonly<Record<string, number>>,
  budgets: Readonly<Partial<Record<ProducerTier, number>>> = {},
): readonly RunnerFinding[] {
  const out: RunnerFinding[] = [];
  for (const [tier, total] of Object.entries(totals)) {
    // OPT-IN, deliberately. `DEFAULT_TIER_BUDGET_MS.pr` (600 s) is exactly the
    // default per-producer `timeoutMs`, so applying it by default would fire on
    // every config with two producers — and `types.ts`'s `VibesRootConfig`
    // carries no `tiers` block, so in v1 there is no way to configure it away.
    // A check that always fires and cannot be silenced trains people to ignore
    // findings, which is the one failure mode this whole tool cannot afford.
    // `DEFAULT_TIER_BUDGET_MS` stays exported as the recommended value for
    // whoever wires the config surface.
    const budget = budgets[tier as ProducerTier];
    if (budget === undefined || !Number.isFinite(budget) || total <= budget) continue;
    out.push(
      finding({
        code: 'V092_TIER_BUDGET',
        severity: 'error',
        file: 'vibes.config.mjs',
        message: `selected ${tier}-tier producers exceed the tier wall-clock budget`,
        evidence: [
          `sum(timeoutMs) = ${String(total)}ms`,
          `budget = ${String(budget)}ms`,
        ],
        fix: `move a producer to a later tier, lower its timeoutMs, or raise the ${tier} budget`,
      }),
    );
  }
  return out;
}
