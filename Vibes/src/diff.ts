/**
 * What changed between two behaviour ledgers.
 *
 * The whole point of a stable `id` is that this can tell four things apart that
 * a diff of test NAMES cannot:
 *
 *   added     — a behaviour the repo did not claim before
 *   respecified — same id, different `then`. The claim itself changed. This is
 *                 the one a reviewer most needs to see and the one name-diffing
 *                 reports as "one deleted, one added".
 *   removed   — a behaviour the repo no longer claims
 *   broken    — the claim is unchanged but the test no longer holds it
 *
 * `broken` outranks everything when reporting: a behaviour that stopped holding
 * is the only category that means something is wrong right now.
 */

import type { Behaviour, Status } from './ledger.js';
import { key } from './ledger.js';

export interface Respecified {
  readonly before: Behaviour;
  readonly after: Behaviour;
  /** Which fields moved. `then` is the meaningful one; the rest are context. */
  readonly fields: readonly ('given' | 'then' | 'covers' | 'why' | 'file')[];
}

export interface StatusChange {
  readonly before: Status;
  readonly after: Behaviour;
}

export interface LedgerDiff {
  readonly added: readonly Behaviour[];
  readonly removed: readonly Behaviour[];
  readonly respecified: readonly Respecified[];
  /** Was passing, now is not. */
  readonly broken: readonly StatusChange[];
  /** Was not passing, now is. */
  readonly fixed: readonly StatusChange[];
  /** Present and passing on both sides, claim unchanged. */
  readonly unchanged: number;
  /** In the current ledger and not passing, regardless of the base. Includes
   *  `did-not-report`, which is NOT a pass and must never be counted as one. */
  readonly notHolding: readonly Behaviour[];
  /** In the base ledger, absent now, but their whole SUITE declared nothing
   *  this run. These have no verdict — the suite failed to produce one — and
   *  rendering them as `removed` would report a build failure as "this PR
   *  deleted N behaviours", which is the worst misreport available. */
  readonly unreported: readonly Behaviour[];
}

const FIELDS = ['given', 'then', 'covers', 'why', 'file'] as const;

export function diffLedgers(
  before: readonly Behaviour[],
  after: readonly Behaviour[],
  silentSuites: readonly string[] = [],
): LedgerDiff {
  const b = new Map(before.map((x) => [key(x), x]));
  const a = new Map(after.map((x) => [key(x), x]));

  const added: Behaviour[] = [];
  const removed: Behaviour[] = [];
  const respecified: Respecified[] = [];
  const broken: StatusChange[] = [];
  const fixed: StatusChange[] = [];
  let unchanged = 0;

  for (const [k, cur] of a) {
    const prev = b.get(k);
    if (prev === undefined) {
      added.push(cur);
      continue;
    }
    const fields = FIELDS.filter((f) => (prev[f] ?? '') !== (cur[f] ?? ''));
    if (fields.length > 0) respecified.push({ before: prev, after: cur, fields });

    const wasPassing = prev.status === 'pass';
    const isPassing = cur.status === 'pass';
    if (wasPassing && !isPassing) broken.push({ before: prev.status, after: cur });
    else if (!wasPassing && isPassing) fixed.push({ before: prev.status, after: cur });
    else if (isPassing && fields.length === 0) unchanged += 1;
  }

  const silent = new Set(silentSuites);
  const unreported: Behaviour[] = [];
  for (const [k, prev] of b) {
    if (a.has(k)) continue;
    // Absence means "removed" only when the suite actually spoke this run.
    if (silent.has(prev.suite)) unreported.push(prev);
    else removed.push(prev);
  }

  const notHolding = after.filter((x) => x.status !== 'pass' && x.status !== 'skip');

  const byId = (x: Behaviour, y: Behaviour): number => (key(x) < key(y) ? -1 : 1);
  return {
    added: added.sort(byId),
    removed: removed.sort(byId),
    respecified: [...respecified].sort((x, y) => byId(x.after, y.after)),
    broken: [...broken].sort((x, y) => byId(x.after, y.after)),
    fixed: [...fixed].sort((x, y) => byId(x.after, y.after)),
    unchanged,
    notHolding: notHolding.sort(byId),
    unreported: unreported.sort(byId),
  };
}

/** True when the diff contains something a reviewer must act on. */
export function hasRegression(d: LedgerDiff): boolean {
  return d.broken.length > 0 || d.removed.length > 0;
}
