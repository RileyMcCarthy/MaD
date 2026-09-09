/**
 * Attribution — changed source × declared witnesses.
 *
 * READ THIS BEFORE TRUSTING A VERDICT FROM THIS FILE:
 * the join is COMPONENT-GRANULAR. A component's witnesses claim a set of paths;
 * its producers either moved a pre-existing snapshot or they did not. Every
 * claimed path in that component therefore gets the SAME verdict. Change ten
 * files under one producer, move one snapshot, and all ten read `exercised`.
 * The naming is chosen to not over-claim (`exercised`, never `tested`), and
 * `ATTRIBUTION_DISCLOSURE` says it in the report in the reader's line of sight.
 *
 * Two rules keep the verdict from being worthless:
 *
 *  1. `added` snapshots are NOT evidence. A new corpus entry proves the corpus
 *     grew, not that existing code ran — otherwise adding one unrelated row
 *     marks every file under the producer as exercised, which is the exact hole
 *     the adversarial review found.
 *  2. Coverage is NOT a set union across claimants (R-W8). A file claimed by a
 *     healthy component and a failed one is NOT covered by the healthy one; the
 *     report names every claimant and its status. Otherwise a failing component
 *     launders its changed files through a passing neighbour.
 */

import picomatch from 'picomatch';

import type {
  ChangedPathKind,
  ChangedSourcePath,
  ChangeStatus,
} from '../git/index.js';
import type {
  ComponentId,
  Glob,
  IsoDate,
  Outcome,
  ProducerName,
  RepoPath,
  SnapshotResult,
} from '../types.js';
import type { Attribution, NotRunReason, SuppressionRef, UnknownReason } from './model.js';

/* ────────────────────────────── inputs ───────────────────────────────── */

export type ComponentStatus = 'active' | 'disabled' | 'skipped-cli' | 'unusable';

export interface AttributionProducer {
  readonly name: ProducerName;
  /** Committed baseline dir, repo-relative POSIX. */
  readonly outDir: RepoPath;
  readonly outcome: Outcome;
  /** git tracks ≥1 file under `outDir`. False ⇒ the next run is a bootstrap. */
  readonly hasBaseline: boolean;
  readonly everCIVerified: boolean;
  readonly ciJob: string | null;
  readonly snapshots: readonly SnapshotResult[];
  /** REQUIRED in spirit whenever `outcome` did not execute (V3). Optional in
   *  the type only because the runner narrows it and a caller that has not
   *  narrowed it yet must still be able to construct this — it then renders as
   *  the unspecific `not-selected`, which is visibly worse than the truth and
   *  therefore self-correcting. */
  readonly notRunReason?: NotRunReason | null;
  /** Set when the producer executed and failed in a way `outcome` cannot spell:
   *  output landed somewhere gitignored, a write escaped the out dir, the
   *  corpus floor was breached, the baseline is stale. */
  readonly unknownReason?: UnknownReason | null;
}

export interface AttributionComponent {
  readonly id: ComponentId;
  readonly root: RepoPath;
  readonly status: ComponentStatus;
  /** REPO-ANCHORED witness globs, negations kept as a leading `!`.
   *  `ComponentPlan.witnessMatches[].repoGlob` is exactly this. */
  readonly witnesses: readonly Glob[];
  /** REPO-ANCHORED `generates` globs — paths this component produces rather
   *  than authors. Changes there belong to the generator, not to a human edit. */
  readonly generates: readonly Glob[];
  readonly submodules: readonly RepoPath[];
  readonly producers: readonly AttributionProducer[];
  readonly disabledReason?: string | null;
  readonly disabledUntil?: IsoDate | null;
}

/* ────────────────────────────── outputs ──────────────────────────────── */

export interface ClaimantRef {
  readonly component: ComponentId;
  /** R-W7: the claim can support a verdict this run. */
  readonly covering: boolean;
  readonly reason: string;
}

export interface AttributedPath {
  readonly path: RepoPath;
  readonly oldPath: RepoPath | null;
  readonly status: ChangeStatus;
  readonly kind: ChangedPathKind;
  /** What the report says about this path. */
  readonly attribution: Attribution;
  /** What it would have said without suppression. Kept so a suppressed row can
   *  still be read for what it is, rather than becoming an opaque "suppressed". */
  readonly natural: Attribution;
  readonly claimants: readonly ClaimantRef[];
  /** Set when `attribution === 'derived'`: the component that generates it. */
  readonly generatedBy: ComponentId | null;
  readonly cosmeticReason: string | null;
  readonly suppressedBy: SuppressionRef | null;
}

export interface ComponentAttribution {
  readonly component: ComponentId;
  readonly covering: boolean;
  readonly coveringReason: string;
  /** Every changed source path this component's witnesses claim. This is the
   *  `ComponentResult.exercisedWitnessPaths` field — see the note below. */
  readonly claimedPaths: readonly RepoPath[];
  /** Changed paths under this component's root that its own witnesses do not
   *  claim (`ComponentResult.unclaimedPaths`). */
  readonly unclaimedPaths: readonly RepoPath[];
  /** Pre-existing snapshots that moved, repo-relative. The evidence, named. */
  readonly movedSnapshots: readonly RepoPath[];
  readonly movedPreExisting: boolean;
  readonly ranProducers: number;
  readonly totalProducers: number;
  /** The per-path verdict every claimed path in this component receives. */
  readonly verdict: Extract<Attribution, 'exercised' | 'unexercised' | 'not-run'> | null;
}

export interface AttributionResult {
  readonly paths: readonly AttributedPath[];
  readonly components: readonly ComponentAttribution[];
  /** Changed paths no component claims at all. */
  readonly unclaimed: readonly RepoPath[];
  /** Gitlink rows not declared in any component's `submodules`. */
  readonly undeclaredGitlinks: readonly RepoPath[];
  readonly counts: Readonly<Record<Attribution, number>>;
}

/* ═════════════════════════════ the join ═══════════════════════════════ */

const PM = { dot: false, nobrace: true } as const;

interface Compiled {
  readonly component: AttributionComponent;
  readonly claims: (p: string) => boolean;
  readonly generates: (p: string) => boolean;
  readonly covering: boolean;
  readonly coveringReason: string;
  readonly movedSnapshots: readonly RepoPath[];
}

/**
 * `witnesses` may contain negations. A negated glob claims nothing itself; it
 * subtracts from the positives — the same semantics `config/resolve.ts` uses to
 * expand them, so the honesty join and the validator agree about what a
 * component claims. They must, or a witness can pass validation and then quietly
 * claim a different set at report time.
 */
export function compileClaims(c: AttributionComponent): (p: string) => boolean {
  const positives = c.witnesses.filter((w) => !w.startsWith('!'));
  const negatives = c.witnesses.filter((w) => w.startsWith('!')).map((w) => w.slice(1));
  if (positives.length === 0) return () => false;
  const yes = picomatch(positives as string[], PM);
  const no = negatives.length === 0 ? () => false : picomatch(negatives as string[], PM);
  return (p) => yes(p) && !no(p);
}

/**
 * R-W7. `covering` is not "the component exists" — it is "a verdict from this
 * component means something this run". Every producer must have reached `ok`:
 * a component with one crashed producer cannot vouch for anything, because the
 * crashed producer is exactly the one whose output would have moved.
 */
export function coverage(c: AttributionComponent): { covering: boolean; reason: string } {
  if (c.status !== 'active') return { covering: false, reason: `component is ${c.status}` };
  if (c.producers.length === 0) {
    return { covering: false, reason: 'component declares no producers' };
  }
  const bad = c.producers.filter((p) => p.outcome !== 'ok');
  if (bad.length > 0) {
    const names = bad.map((p) => `${p.name} (${p.outcome})`).join(', ');
    return { covering: false, reason: `producer did not run ok: ${names}` };
  }
  return { covering: true, reason: 'every producer ran ok' };
}

/**
 * The evidence set: pre-existing snapshots whose bytes moved.
 *
 * `added` is excluded (§4.17). `equivalent` IS included even though its state
 * is `verified-unchanged`: the received bytes differed from the committed ones
 * and a comparator judged the difference immaterial — the producer did run the
 * code and did emit something new. That is the spec's resolved question on
 * within-tolerance evidence, and it is the one case where a `verified-unchanged`
 * row is evidence of execution.
 */
export function movedSnapshots(c: AttributionComponent): readonly RepoPath[] {
  const out: RepoPath[] = [];
  for (const p of c.producers) {
    if (p.outcome !== 'ok') continue;
    for (const s of p.snapshots) {
      const moved =
        s.state === 'changed' ||
        s.state === 'deleted' ||
        (s.state === 'verified-unchanged' && s.verdict.kind === 'equivalent');
      if (moved) out.push(`${p.outDir}/${s.file}`);
    }
  }
  return out;
}

const GOVERNANCE_KINDS: ReadonlySet<ChangedPathKind> = new Set<ChangedPathKind>([
  'vibes-manifest',
  'vibes-config',
  'vibes-lock',
  'vibes-ignore',
  'vibes-receipt',
]);

export interface AttributeOptions {
  readonly changed: readonly ChangedSourcePath[];
  readonly components: readonly AttributionComponent[];
  /** Treat a 100%-similarity rename as cosmetic. Default true — a pure move is
   *  not a behaviour change and warning about it drowns the ones that are. */
  readonly renameIsCosmetic?: boolean;
  /** Resolves a suppression for a single path; the finding-level suppression is
   *  applied separately in `findings.ts`. */
  readonly suppressionFor?: (path: RepoPath) => SuppressionRef | null;
}

export function attribute(opts: AttributeOptions): AttributionResult {
  const compiled: Compiled[] = opts.components.map((component) => {
    const cov = coverage(component);
    return {
      component,
      claims: compileClaims(component),
      generates:
        component.generates.length === 0
          ? () => false
          : picomatch(component.generates as string[], PM),
      covering: cov.covering,
      coveringReason: cov.reason,
      movedSnapshots: movedSnapshots(component),
    };
  });

  const submoduleOwners = new Map<RepoPath, ComponentId>();
  for (const c of opts.components) {
    for (const s of c.submodules) submoduleOwners.set(s.replace(/\/+$/, ''), c.id);
  }

  const claimedByComponent = new Map<ComponentId, RepoPath[]>();
  const unclaimedByComponent = new Map<ComponentId, RepoPath[]>();
  for (const c of opts.components) {
    claimedByComponent.set(c.id, []);
    unclaimedByComponent.set(c.id, []);
  }

  const paths: AttributedPath[] = [];
  const unclaimed: RepoPath[] = [];
  const undeclaredGitlinks: RepoPath[] = [];
  const counts: Record<Attribution, number> = {
    exercised: 0,
    unexercised: 0,
    'not-run': 0,
    unclaimed: 0,
    cosmetic: 0,
    derived: 0,
    governance: 0,
    suppressed: 0,
  };

  for (const cp of opts.changed) {
    // A rename is matched on BOTH ends. A file that moved OUT of a witness glob
    // is the silent-retreat case; attributing it to nobody is how it hides.
    const probes = cp.oldPath === null ? [cp.path] : [cp.path, cp.oldPath];
    const claimants: ClaimantRef[] = [];
    for (const c of compiled) {
      if (probes.some((p) => c.claims(p))) {
        claimants.push({
          component: c.component.id,
          covering: c.covering,
          reason: c.coveringReason,
        });
        claimedByComponent.get(c.component.id)?.push(cp.path);
      }
    }

    // Root-scoped bookkeeping for ComponentResult.unclaimedPaths.
    for (const c of compiled) {
      const inRoot = probes.some((p) => underRoot(p, c.component.root));
      const claims = probes.some((q) => c.claims(q));
      if (inRoot && !claims && !GOVERNANCE_KINDS.has(cp.kind)) {
        unclaimedByComponent.get(c.component.id)?.push(cp.path);
      }
    }

    const generator = compiled.find((c) => probes.some((p) => c.generates(p)));
    const cosmeticReason = cosmeticReasonOf(cp, opts.renameIsCosmetic !== false);

    let natural: Attribution;
    if (GOVERNANCE_KINDS.has(cp.kind)) {
      natural = 'governance';
    } else if (generator !== undefined) {
      natural = 'derived';
    } else if (cosmeticReason !== null) {
      natural = 'cosmetic';
    } else if (claimants.length === 0) {
      natural = 'unclaimed';
      if (cp.kind !== 'gitlink') unclaimed.push(cp.path);
    } else if (!claimants.some((c) => c.covering)) {
      natural = 'not-run';
    } else {
      const evidence = claimants.some(
        (c) =>
          c.covering &&
          (compiled.find((x) => x.component.id === c.component)?.movedSnapshots.length ?? 0) > 0,
      );
      natural = evidence ? 'exercised' : 'unexercised';
    }

    if (cp.kind === 'gitlink') {
      const owner = submoduleOwners.get(cp.path.replace(/\/+$/, ''));
      if (owner === undefined) undeclaredGitlinks.push(cp.path);
    }

    const suppressedBy = opts.suppressionFor?.(cp.path) ?? null;
    const attribution: Attribution =
      suppressedBy !== null && SUPPRESSIBLE_ATTRIBUTIONS.has(natural) ? 'suppressed' : natural;
    counts[attribution] += 1;

    paths.push({
      path: cp.path,
      oldPath: cp.oldPath,
      status: cp.status,
      kind: cp.kind,
      attribution,
      natural,
      claimants,
      generatedBy: generator?.component.id ?? null,
      cosmeticReason,
      suppressedBy,
    });
  }

  const components: ComponentAttribution[] = compiled.map((c) => {
    const claimed = dedupe(claimedByComponent.get(c.component.id) ?? []);
    const verdict = !c.covering
      ? claimed.length > 0
        ? ('not-run' as const)
        : null
      : c.movedSnapshots.length > 0
        ? ('exercised' as const)
        : claimed.length > 0
          ? ('unexercised' as const)
          : null;
    return {
      component: c.component.id,
      covering: c.covering,
      coveringReason: c.coveringReason,
      claimedPaths: claimed,
      unclaimedPaths: dedupe(unclaimedByComponent.get(c.component.id) ?? []),
      movedSnapshots: c.movedSnapshots,
      movedPreExisting: c.movedSnapshots.length > 0,
      ranProducers: c.component.producers.filter((p) => p.outcome === 'ok').length,
      totalProducers: c.component.producers.length,
      verdict,
    };
  });

  return { paths, components, unclaimed: dedupe(unclaimed), undeclaredGitlinks, counts };
}

/** Only these can be quieted by a path rule; the rest are not complaints. */
const SUPPRESSIBLE_ATTRIBUTIONS: ReadonlySet<Attribution> = new Set<Attribution>([
  'unexercised',
  'not-run',
  'unclaimed',
]);

function cosmeticReasonOf(cp: ChangedSourcePath, renameIsCosmetic: boolean): string | null {
  if (cp.cosmetic) return 'every changed line matched a declared cosmetic pattern';
  if (cp.status === 'mode-only') return 'file mode only, contents identical';
  if (renameIsCosmetic && cp.status === 'renamed' && cp.similarity === 100) {
    return 'pure rename, contents identical';
  }
  return null;
}

export function underRoot(p: RepoPath, root: RepoPath): boolean {
  const r = root.replace(/\/+$/, '');
  return r === '' || r === '.' ? true : p === r || p.startsWith(`${r}/`);
}

function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/* ───────────────────────── advisory breadth check ────────────────────── */

export interface WitnessBreadth {
  readonly component: ComponentId;
  readonly matched: number;
  readonly tracked: number;
  readonly fraction: number;
}

/**
 * How much of the repo a component claims. ADVISORY ONLY, never gating: the
 * 60% threshold is borrowed, not measured, and gating on a borrowed constant
 * teaches people to disable checks.
 */
export function witnessBreadth(
  components: readonly AttributionComponent[],
  tracked: readonly RepoPath[],
): readonly WitnessBreadth[] {
  if (tracked.length === 0) return [];
  return components.map((c) => {
    const claims = compileClaims(c);
    const matched = tracked.filter((p) => claims(p)).length;
    return {
      component: c.id,
      matched,
      tracked: tracked.length,
      fraction: matched / tracked.length,
    };
  });
}

export const OVERBROAD_FRACTION = 0.6;
