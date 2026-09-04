/**
 * Partial-run semantics — the states, and the arithmetic that may not lie.
 *
 * ONE RULE GOVERNS THIS FILE: `unchanged` is a claim about a producer's
 * EXECUTION, never about a path. Only that producer's own successful run, this
 * run, can license it. Everything below is that rule spelled out at three
 * levels — file, producer, component — plus the run-level completeness number
 * the emitter is forbidden from printing "unchanged" without.
 *
 * Two derivations here are not the obvious implementation:
 *
 *  1. `fullyVerified` is computed over the COMMITTED policy-lock roster, not
 *     over what this invocation happened to discover. Using the live roster
 *     means deleting a component makes the run MORE complete, which inverts the
 *     incentive the whole tool exists to create. With no committed lock there
 *     is no roster, and the answer is `false` — see `verificationCoverage`.
 *
 *  2. A producer that did not run ok contributes ZERO green. Its files are
 *     stamped `not-run` before git is ever consulted (V2, asserted by
 *     `unrunSnapshotViolations` below), and its component can at best be
 *     `partial`. There is no arithmetic anywhere in this file that can turn a
 *     failed producer into a quiet one.
 */

import type {
  ComponentId,
  ComponentState,
  Outcome,
  ProducerName,
  SnapState,
  SnapshotResult,
} from '../types.js';
import type { AttributionComponent, AttributionProducer } from './attribution.js';
import type { NotRunReason, ProducerState, UnknownReason } from './model.js';

/* ─────────────────────────── per-producer ────────────────────────────── */

export interface ProducerStateResult {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  readonly outcome: Outcome;
  readonly state: ProducerState;
  readonly notRunReason: NotRunReason | null;
  readonly unknownReason: UnknownReason | null;
  /** V3: rendered inline next to the state. Never empty for a non-green state. */
  readonly reason: string;
  readonly snapshots: Readonly<Record<SnapState, number>>;
  /** Nothing committed under `out` yet — first recording, not a regression. */
  readonly bootstrap: boolean;
  readonly everCIVerified: boolean;
  readonly ciJob: string | null;
}

const EMPTY_SNAP_COUNTS: Readonly<Record<SnapState, number>> = Object.freeze({
  'verified-unchanged': 0,
  changed: 0,
  added: 0,
  deleted: 0,
  'not-selected': 0,
  'not-run': 0,
});

export function countSnapStates(
  snapshots: readonly SnapshotResult[],
): Readonly<Record<SnapState, number>> {
  const counts: Record<SnapState, number> = { ...EMPTY_SNAP_COUNTS };
  for (const s of snapshots) counts[s.state] += 1;
  return counts;
}

/**
 * `blocked` is `not-run`, `cancelled` is `unknown`, and the asymmetry is on
 * purpose. A blocked producer never started — a lease was held — so nothing
 * about its out dir is in question. A cancelled one may have been half way
 * through writing when the pool shut down, and its out dir may hold a partial
 * corpus that would compare as a shrink. When the outcome cannot distinguish
 * "never started" from "died mid-write", the loud state is the correct one.
 */
export function stateOfOutcome(outcome: Outcome): ProducerState | 'ok' {
  switch (outcome) {
    case 'ok':
      return 'ok';
    case 'not-selected':
    case 'not-discovered':
    case 'blocked':
      return 'not-run';
    default:
      return 'unknown';
  }
}

const NOT_RUN_TEXT: Readonly<Record<NotRunReason, string>> = {
  'skipped-unchanged': 'skipped — Vibes computed no change in this component',
  'component-disabled': 'component disabled in the registry',
  'skipped-cli': 'excluded by --only/--skip on this invocation',
  'component-unusable': 'component configuration is unusable',
  'not-discovered': 'component directory absent — an uninitialised submodule?',
  'tier-excluded': 'producer tier is outside this invocation',
  blocked: 'a resource lease was held by another run; it never started',
  'not-selected': 'not selected this invocation (reason not narrowed by the runner)',
};

const UNKNOWN_TEXT: Readonly<Record<UnknownReason, string>> = {
  failed: 'producer exited non-zero',
  timedOut: 'producer timed out',
  spawnError: 'producer could not be spawned',
  emptyOutput: 'producer wrote no files',
  cancelled: 'producer was cancelled mid-run; its output may be partial',
  'output-ignored': 'producer output landed on a gitignored path',
  'output-escaped': 'producer wrote outside its declared out dir',
  'corpus-floor': 'producer emitted fewer cases than its declared floor',
  'stale-baseline': 'the committed baseline is older than the source it claims',
};

/** Best-effort narrowing when the runner supplied no `unknownReason`. */
function unknownFromOutcome(outcome: Outcome): UnknownReason {
  switch (outcome) {
    case 'failed':
    case 'timedOut':
    case 'spawnError':
    case 'emptyOutput':
    case 'cancelled':
      return outcome;
    default:
      return 'failed';
  }
}

export function producerState(
  component: ComponentId,
  p: AttributionProducer,
): ProducerStateResult {
  const snapshots = countSnapStates(p.snapshots);
  const base = stateOfOutcome(p.outcome);
  const common = {
    component,
    producer: p.name,
    outcome: p.outcome,
    snapshots,
    bootstrap: !p.hasBaseline,
    everCIVerified: p.everCIVerified,
    ciJob: p.ciJob,
  } as const;

  if (base === 'not-run') {
    const reason: NotRunReason =
      p.notRunReason ?? (p.outcome === 'not-discovered' ? 'not-discovered' : p.outcome === 'blocked' ? 'blocked' : 'not-selected');
    return {
      ...common,
      state: 'not-run',
      notRunReason: reason,
      unknownReason: null,
      reason: NOT_RUN_TEXT[reason],
    };
  }
  if (base === 'unknown') {
    const reason = p.unknownReason ?? unknownFromOutcome(p.outcome);
    return {
      ...common,
      state: 'unknown',
      notRunReason: null,
      unknownReason: reason,
      reason: UNKNOWN_TEXT[reason],
    };
  }

  // Ran ok. An `unknownReason` supplied anyway wins: the runner learned
  // something after the exit code (ignored output, escaped write, corpus floor)
  // and that discovery is exactly the kind a green exit code hides.
  if (p.unknownReason != null) {
    return {
      ...common,
      state: 'unknown',
      notRunReason: null,
      unknownReason: p.unknownReason,
      reason: UNKNOWN_TEXT[p.unknownReason],
    };
  }
  const moved = snapshots.changed + snapshots.added + snapshots.deleted;
  if (moved > 0) {
    return {
      ...common,
      state: 'changed',
      notRunReason: null,
      unknownReason: null,
      reason: `${String(moved)} of ${String(p.snapshots.length)} snapshot files moved`,
    };
  }
  return {
    ...common,
    state: 'verified-unchanged',
    notRunReason: null,
    unknownReason: null,
    reason: `${String(p.snapshots.length)} snapshot files compared byte-for-byte`,
  };
}

/**
 * V2, as an executable assertion.
 *
 * For every producer that did not run ok, every one of its snapshot files must
 * be stamped `not-run`. If a `verified-unchanged` file appears under a producer
 * that never executed, some code path compared the committed baseline to
 * itself, which is the exact lie this tool exists to prevent. Cheap to run on
 * every invocation, and it catches the regression the moment it is introduced.
 */
export interface UnrunViolation {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  readonly file: string;
  readonly state: SnapState;
}

export function unrunSnapshotViolations(
  components: readonly AttributionComponent[],
): readonly UnrunViolation[] {
  const out: UnrunViolation[] = [];
  for (const c of components) {
    for (const p of c.producers) {
      if (p.outcome === 'ok') continue;
      for (const s of p.snapshots) {
        if (s.state === 'not-run') continue;
        out.push({ component: c.id, producer: p.name, file: s.file, state: s.state });
      }
    }
  }
  return out;
}

/* ─────────────────────────── per-component ───────────────────────────── */

export interface ComponentTally {
  readonly component: ComponentId;
  readonly state: ComponentState;
  readonly producers: readonly ProducerStateResult[];
  readonly counts: Readonly<Record<ProducerState, number>>;
  readonly snapshots: Readonly<Record<SnapState, number>>;
  /** Why this state, in one sentence. Rendered; never omitted. */
  readonly reason: string;
}

/**
 * The roll-up.
 *
 * V5 says a report has no sentence available to it asserting that a COMPONENT
 * behaved identically — a component is a tally of producers, not a verdict. The
 * contract nevertheless names the all-green rollup `verified-unchanged`, and
 * that internal name is kept; what is forbidden is the emitter rendering the
 * bare word "unchanged" from it. The tally is the thing meant to be rendered,
 * which is why it is returned alongside the state rather than replaced by it.
 */
export function componentTally(c: AttributionComponent): ComponentTally {
  const producers = c.producers.map((p) => producerState(c.id, p));
  const counts: Record<ProducerState, number> = {
    'verified-unchanged': 0,
    changed: 0,
    'not-run': 0,
    unknown: 0,
  };
  for (const p of producers) counts[p.state] += 1;

  const snapshots: Record<SnapState, number> = { ...EMPTY_SNAP_COUNTS };
  for (const p of producers) {
    for (const k of Object.keys(snapshots) as SnapState[]) snapshots[k] += p.snapshots[k];
  }

  const tally = (state: ComponentState, reason: string): ComponentTally => ({
    component: c.id,
    state,
    producers,
    counts,
    snapshots,
    reason,
  });

  // Order matters. A disabled component is `not-run` even if it somehow has
  // producer results attached, because the reason it produced nothing is a
  // policy decision and that is what a reader needs to see first.
  if (c.status !== 'active') {
    return tally('not-run', `component is ${c.status}`);
  }
  if (producers.length === 0) {
    return tally('not-configured', 'component declares no producers — no behaviour snapshots');
  }
  const ran = counts.changed + counts['verified-unchanged'];
  const missing = counts['not-run'] + counts.unknown;

  // Bootstrap only when EVERY producer is recording for the first time and none
  // of them failed. One bootstrapping producer beside a broken one is a partial
  // run that happens to contain a bootstrap, and the broken half is the story.
  if (counts.unknown === 0 && producers.every((p) => p.bootstrap) && ran > 0) {
    return tally('bootstrap', 'no committed baseline yet — this run records the first one');
  }
  if (missing > 0) {
    return ran > 0
      ? tally(
          'partial',
          `${String(ran)} of ${String(producers.length)} producers evaluated; ${String(missing)} did not`,
        )
      : tally('not-run', `none of ${String(producers.length)} producers were evaluated`);
  }
  if (counts.changed > 0) {
    return tally('changed', `${String(counts.changed)} of ${String(producers.length)} producers changed`);
  }
  return tally(
    'verified-unchanged',
    `all ${String(producers.length)} producers ran and every snapshot matched`,
  );
}

/* ────────────────────────── run completeness ─────────────────────────── */

export interface RosterEntry {
  readonly component: ComponentId;
  readonly producer: ProducerName;
}

export interface RosterMiss extends RosterEntry {
  readonly outcome: Outcome | null;
  readonly detail: string;
}

export interface VerificationCoverage {
  /** `RunReport.fullyVerified`. The emitter may not print "unchanged" in a
   *  headline unless this is true. */
  readonly fullyVerified: boolean;
  readonly rosterSource: 'policy-lock' | 'none';
  readonly declared: number;
  readonly evaluated: number;
  /** In the committed lock, absent from this run entirely. The cheapest
   *  total-silencing edit, and the lock is the only thing that can see it. */
  readonly missing: readonly RosterMiss[];
  /** In the lock and in this run, but did not reach `ok`. */
  readonly notOk: readonly RosterMiss[];
  /** Ran but is not in the lock — the lock was not regenerated. */
  readonly extra: readonly RosterEntry[];
  readonly reason: string;
}

const key = (component: ComponentId, producer: ProducerName): string => `${component}/${producer}`;

/**
 * WHY NO COMMITTED LOCK MEANS `fullyVerified === false`:
 *
 * the roster's whole job is to be a set that cannot be shrunk from inside this
 * run. Falling back to the live roster restores exactly the property being
 * defended against — delete a component and the run gets MORE complete. Being
 * unable to assert completeness on the one run before a lock is committed is a
 * true statement with an obvious fix, and it is strictly better than an
 * assertable-but-meaningless "all verified".
 */
export function verificationCoverage(
  roster: readonly RosterEntry[],
  components: readonly AttributionComponent[],
): VerificationCoverage {
  const live = new Map<string, { component: ComponentId; producer: AttributionProducer }>();
  for (const c of components) {
    for (const p of c.producers) live.set(key(c.id, p.name), { component: c.id, producer: p });
  }

  if (roster.length === 0) {
    return {
      fullyVerified: false,
      rosterSource: 'none',
      declared: 0,
      evaluated: [...live.values()].filter((x) => x.producer.outcome === 'ok').length,
      missing: [],
      notOk: [],
      extra: [...live.values()].map((x) => ({ component: x.component, producer: x.producer.name })),
      reason:
        'no committed .vibes/policy.lock.json, so there is no roster this run can be complete against',
    };
  }

  const missing: RosterMiss[] = [];
  const notOk: RosterMiss[] = [];
  let evaluated = 0;
  const seen = new Set<string>();

  for (const entry of roster) {
    const k = key(entry.component, entry.producer);
    seen.add(k);
    const found = live.get(k);
    if (found === undefined) {
      missing.push({
        ...entry,
        outcome: null,
        detail: 'declared in the committed policy lock, absent from this run',
      });
      continue;
    }
    if (found.producer.outcome === 'ok') {
      evaluated += 1;
      continue;
    }
    notOk.push({
      ...entry,
      outcome: found.producer.outcome,
      detail: `declared in the committed policy lock, outcome ${found.producer.outcome}`,
    });
  }

  const extra = [...live.entries()]
    .filter(([k]) => !seen.has(k))
    .map(([, v]) => ({ component: v.component, producer: v.producer.name }));

  const fullyVerified = missing.length === 0 && notOk.length === 0;
  return {
    fullyVerified,
    rosterSource: 'policy-lock',
    declared: roster.length,
    evaluated,
    missing,
    notOk,
    extra,
    reason: fullyVerified
      ? `all ${String(roster.length)} producers in the committed policy lock ran ok`
      : `${String(evaluated)} of ${String(roster.length)} producers in the committed policy lock ran ok`,
  };
}

/**
 * V4: the headline is a COVERAGE FRACTION, not a verdict, and the string
 * "all unchanged" is forbidden unless every declared producer was evaluated,
 * nothing is unknown, and nothing is suppressed. This produces the fraction;
 * the emitter owns the words.
 */
export interface RunCoverageLine {
  readonly evaluated: number;
  readonly declared: number;
  readonly changed: number;
  readonly notRun: number;
  readonly unknown: number;
  readonly componentsSuppressed: number;
  readonly componentsTotal: number;
  readonly mayClaimAllUnchanged: boolean;
  readonly text: string;
}

export function runCoverage(
  tallies: readonly ComponentTally[],
  coverage: VerificationCoverage,
): RunCoverageLine {
  let changed = 0;
  let notRun = 0;
  let unknown = 0;
  for (const t of tallies) {
    changed += t.counts.changed;
    notRun += t.counts['not-run'];
    unknown += t.counts.unknown;
  }
  const componentsSuppressed = tallies.filter((t) => t.state === 'not-run').length;
  const declared = coverage.rosterSource === 'policy-lock' ? coverage.declared : coverage.evaluated;
  const mayClaimAllUnchanged =
    coverage.fullyVerified && unknown === 0 && notRun === 0 && componentsSuppressed === 0 && changed === 0;
  return {
    evaluated: coverage.evaluated,
    declared,
    changed,
    notRun,
    unknown,
    componentsSuppressed,
    componentsTotal: tallies.length,
    mayClaimAllUnchanged,
    text:
      `${String(coverage.evaluated)} of ${String(declared)} producers evaluated; ` +
      `${String(changed)} changed; ${String(notRun)} not run; ${String(unknown)} unknown; ` +
      `${String(componentsSuppressed)} of ${String(tallies.length)} components suppressed`,
  };
}
