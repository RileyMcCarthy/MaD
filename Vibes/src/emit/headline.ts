/**
 * The headline, and the one invariant that governs it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE HEADLINE INVARIANT
 * The emitter may not print the word "unchanged" in ANY headline unless
 * `RunReport.fullyVerified === true`. Enforced by `assertHeadlineInvariant`,
 * called on every headline before it is written, and unit-tested.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY a sentence and not a badge or a count: six snapshot states
 * (verified-unchanged / changed / added / deleted / not-selected / not-run) are
 * more than a skimming reader will hold. Given a badge, they take away "green"
 * or "red" and nothing else — and the state a badge collapses hardest is
 * `not-run`, which is the one that means "this report does not know". So the
 * headline leads with the WORST state present, in words, and the count comes
 * after the claim rather than instead of it.
 *
 * WHY the worst state and not the most common: a run where 240 files are
 * unchanged and one producer crashed is a run that verified nothing about that
 * producer. Leading with 240 would be true and useless.
 */

import type { ComponentResult, RunReport, SnapState } from '../types.js';

/* ───────────────────────────── the tally ─────────────────────────────── */

export interface StateTally {
  readonly 'verified-unchanged': number;
  readonly changed: number;
  readonly added: number;
  readonly deleted: number;
  readonly 'not-selected': number;
  readonly 'not-run': number;
}

export interface ReportTally {
  readonly states: StateTally;
  readonly totalSnapshots: number;
  readonly producersTotal: number;
  readonly producersOk: number;
  readonly producersFailed: number;
  readonly producersNotSelected: number;
  readonly componentsNotConfigured: readonly string[];
  readonly componentsBootstrap: readonly string[];
  readonly errors: number;
  readonly warnings: number;
}

const EMPTY_STATES: StateTally = {
  'verified-unchanged': 0,
  changed: 0,
  added: 0,
  deleted: 0,
  'not-selected': 0,
  'not-run': 0,
};

export function tally(report: RunReport): ReportTally {
  const states: Record<SnapState, number> = { ...EMPTY_STATES };
  let producersTotal = 0;
  let producersOk = 0;
  let producersFailed = 0;
  let producersNotSelected = 0;
  const notConfigured: string[] = [];
  const bootstrap: string[] = [];

  for (const c of report.components) {
    if (c.state === 'not-configured') notConfigured.push(c.component);
    if (c.state === 'bootstrap') bootstrap.push(c.component);
    for (const s of c.snapshots) states[s.state] += 1;
    for (const p of c.producers) {
      producersTotal += 1;
      if (p.outcome === 'ok') producersOk += 1;
      else if (p.outcome === 'not-selected' || p.outcome === 'not-discovered') {
        producersNotSelected += 1;
      } else producersFailed += 1;
    }
  }

  const findings = [...report.findings, ...report.components.flatMap((c) => [...c.findings])];
  return {
    states,
    totalSnapshots: Object.values(states).reduce((a, b) => a + b, 0),
    producersTotal,
    producersOk,
    producersFailed,
    producersNotSelected,
    componentsNotConfigured: notConfigured,
    componentsBootstrap: bootstrap,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
  };
}

/* ─────────────────────────── the headline ────────────────────────────── */

/**
 * Worst-first. The order is the product: each state above another is one whose
 * presence makes the state below it an incomplete description of the run.
 */
export type HeadlineState =
  | 'producer-failed'
  | 'findings-error'
  | 'changed'
  | 'corpus-moved'
  | 'partial'
  | 'not-configured'
  | 'bootstrap'
  | 'all-verified'
  | 'nothing-measured';

export interface Headline {
  readonly state: HeadlineState;
  readonly sentence: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * Build the headline sentence.
 *
 * Every branch is written to survive the invariant test: the word "unchanged"
 * appears in exactly one branch, and that branch is unreachable unless
 * `fullyVerified` is true.
 */
export function headline(report: RunReport, t: ReportTally = tally(report)): Headline {
  if (t.producersFailed > 0) {
    return {
      state: 'producer-failed',
      sentence: `Not verified — ${t.producersFailed} of ${t.producersTotal} ${plural(t.producersTotal, 'producer')} did not complete, so ${t.states['not-run']} snapshot ${plural(t.states['not-run'], 'file')} in this report ${t.states['not-run'] === 1 ? 'has' : 'have'} no evidence behind ${t.states['not-run'] === 1 ? 'it' : 'them'} either way.`,
    };
  }

  if (t.errors > 0 && t.states.changed === 0) {
    return {
      state: 'findings-error',
      sentence: `Blocked — ${t.errors} ${plural(t.errors, 'finding')} at error severity ${t.errors === 1 ? 'needs' : 'need'} a decision before this run says anything about behaviour.`,
    };
  }

  if (t.states.changed > 0) {
    const components = report.components
      .filter((c) => c.snapshots.some((s) => s.state === 'changed'))
      .map((c) => c.component);
    const where = components.length === 0 ? '' : ` in ${humanList(components)}`;
    return {
      state: 'changed',
      sentence: `Behaviour moved — ${t.states.changed} snapshot ${plural(t.states.changed, 'file')}${where} produced different output than the committed baseline.`,
    };
  }

  if (t.states.added > 0 || t.states.deleted > 0) {
    const parts: string[] = [];
    if (t.states.added > 0) parts.push(`${t.states.added} new`);
    if (t.states.deleted > 0) parts.push(`${t.states.deleted} removed`);
    return {
      state: 'corpus-moved',
      sentence: `The corpus moved — ${parts.join(' and ')} snapshot ${plural(t.states.added + t.states.deleted, 'file')}, with no existing file producing different output.`,
    };
  }

  if (t.producersNotSelected > 0 || t.states['not-selected'] > 0 || !report.fullyVerified) {
    const skipped = t.producersNotSelected;
    const detail =
      skipped > 0
        ? `${skipped} of ${t.producersTotal} ${plural(t.producersTotal, 'producer')} did not run this invocation`
        : 'not every declared producer ran this invocation';
    return {
      state: 'partial',
      sentence: `Partially measured — ${detail}, so this run cannot speak for the whole baseline.`,
    };
  }

  if (t.producersTotal === 0) {
    return {
      state: 'nothing-measured',
      sentence:
        'Nothing was measured — no producer is configured, so this report says nothing about behaviour at all.',
    };
  }

  if (t.componentsBootstrap.length > 0) {
    return {
      state: 'bootstrap',
      sentence: `First baselines — ${humanList(t.componentsBootstrap)} recorded ${plural(t.componentsBootstrap.length, 'its', 'their')} first snapshot set, which nothing has reviewed yet.`,
    };
  }

  // The ONLY branch that may use the word. Guarded by the check below and by
  // the `partial` branch above, which catches `fullyVerified === false`.
  return {
    state: 'all-verified',
    sentence: `Every declared producer ran and all ${t.states['verified-unchanged']} snapshot ${plural(t.states['verified-unchanged'], 'file')} came out byte-for-byte unchanged from the baseline at ${report.baseSha.slice(0, 8)}.`,
  };
}

function humanList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  if (items.length <= 4) return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return `${items.slice(0, 3).join(', ')} and ${items.length - 3} other components`;
}

/**
 * THE INVARIANT. Called before any headline is written to any surface.
 *
 * It throws rather than sanitising: a headline that had to be edited to be
 * honest is a bug in `headline()`, and quietly rewriting it would hide the bug
 * until the day it produced a subtly-wrong sentence instead of a detectably
 * wrong one.
 */
export function assertHeadlineInvariant(sentence: string, fullyVerified: boolean): void {
  if (fullyVerified) return;
  if (/\bunchanged\b/i.test(sentence)) {
    throw new Error(
      `headline invariant violated: "unchanged" may not appear in a headline when fullyVerified is false.\n  headline: ${sentence}`,
    );
  }
}

/* ───────────────────── labels for rows, not headlines ────────────────── */

/**
 * Row labels. `verified-unchanged` deliberately does NOT render as the bare
 * word "verified": §4.18 — a snapshot comparing equal to a baseline the same
 * agent accepted last week is not independent verification of anything, and the
 * word implies an authority the mechanism does not have.
 */
export const SNAP_STATE_LABEL: Readonly<Record<SnapState, string>> = Object.freeze({
  'verified-unchanged': 'unchanged since base',
  changed: 'changed',
  added: 'added',
  deleted: 'deleted',
  'not-selected': 'not selected this run',
  'not-run': 'not run — no evidence',
});

export const COMPONENT_STATE_LABEL: Readonly<Record<ComponentResult['state'], string>> =
  Object.freeze({
    'verified-unchanged': 'ran, output identical',
    changed: 'ran, output moved',
    'not-run': 'did not run',
    partial: 'partially run',
    bootstrap: 'first baselines recorded',
    'not-configured': 'no producer configured',
  });

/**
 * THE DISCLOSURE. Required verbatim in every report, never inside a collapsed
 * section.
 *
 * Attribution here is component-granular: change ten files under one producer,
 * move one snapshot, and all ten read as exercised. Coverage instrumentation or
 * a producer-declared file→snapshot map would fix it; neither exists. Until one
 * does, the report says so in the reader's line of sight.
 */
export const DISCLOSURE_SENTENCE =
  'Vibes verifies that a producer claiming these paths ran and its committed output moved. It does not establish that any specific file was executed.';
