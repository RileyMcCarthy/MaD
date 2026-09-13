/**
 * The behaviour ledger: what this repo says it does, derived from its tests.
 *
 * One record per behaviour, emitted by a language binding (see
 * bindings/SCHEMA.md) and joined to pass/fail by the collector. The committed
 * ledger doubles as documentation — it is a readable list of everything the
 * system claims, which a diff then makes reviewable.
 *
 * Nothing here knows any language. Bindings speak the languages; this speaks
 * one schema.
 */

/** Whether the behaviour held on the run that produced this record. */
export type Status = 'pass' | 'fail' | 'skip' | 'did-not-report';

export interface Behaviour {
  readonly v: 2;
  /** Short handle for citing this expectation — BH-42. Assigned on first
   *  collection, carried forever, never reused. NOT the identity. */
  readonly num: number;
  /** The TEST's stable id. Several expectations share it. */
  readonly id: string;
  /** This expectation's stable id, unique within the test. Identity is
   *  `suite/id/expect`, so rewording one expectation is a change to that
   *  expectation and not a reshuffle of its siblings. */
  readonly expect: string;
  readonly suite: string;
  readonly lang: string;
  /** Repo-relative, normalised by the collector from three path conventions. */
  readonly file: string;
  /** The runner's own name for the test. Only used to join status. */
  readonly test: string;
  /** The CONDITION the test sets up. Shared by every expectation of that test. */
  readonly given: string;
  /** One expectation for that condition, and nothing else. It does NOT restate
   *  the condition — the report shows both. */
  readonly then: string;
  /** `path#symbol` the behaviour exercises, so a reader can find the code. */
  readonly covers?: string;
  /** The standing requirement this expectation serves, when the claim does not
   *  already carry it. */
  readonly why?: string;
  readonly status: Status;
}


export function parseLedger(text: string): { ok: Behaviour[]; bad: string[] } {
  const ok: Behaviour[] = [];
  const bad: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const b = JSON.parse(line) as Behaviour;
      // v1 had one expectation per test, welded into `then`. It is not read
      // here: silently treating a v1 record as v2 would give every one of its
      // expectations the same identity.
      if (b.v !== 2) {
        bad.push(`schema v${String(b.v)} is not supported (expects v2): ${line.slice(0, 80)}`);
        continue;
      }
      if (typeof b.id !== 'string' || b.id === '') {
        bad.push(`record has no id: ${line.slice(0, 80)}`);
        continue;
      }
      if (typeof b.expect !== 'string' || b.expect === '') {
        bad.push(`record has no expect id: ${line.slice(0, 80)}`);
        continue;
      }
      ok.push(b);
    } catch (e) {
      bad.push(`unparseable line: ${(e as Error).message}`);
    }
  }
  return { ok, bad };
}

/** Bytewise stable, so two runs on the same tree write identical files. */
export function serializeLedger(items: readonly Behaviour[]): string {
  const sorted = [...items].sort((a, b) => {
    if (a.suite !== b.suite) return a.suite < b.suite ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.expect < b.expect ? -1 : a.expect > b.expect ? 1 : 0;
  });
  return sorted.map((b) => JSON.stringify(b)).join('\n') + (sorted.length > 0 ? '\n' : '');
}

/**
 * How a behaviour is cited outside the ledger, or '' for a record written
 * before numbering existed.
 *
 * The base side of a diff is whatever was committed then, so a behaviour
 * REMOVED against a pre-numbering ledger has no number to show. Rendering
 * "BH-undefined" beside a real claim would put an obvious defect in front of
 * every reviewer; showing nothing is honest and reads fine.
 */
export function handle(b: Behaviour): string {
  return typeof b.num === 'number' && Number.isFinite(b.num) && b.num > 0 ? `BH-${String(b.num)}` : '';
}

/**
 * Carry every number forward, and give anything new the next one that has
 * never been used.
 *
 * `highWater` is what makes a citation trustworthy. Numbering from the highest
 * number currently in the ledger would hand a deleted behaviour's number to the
 * next new one, and a review comment pointing at BH-42 would quietly start
 * meaning a different claim. So the counter only ever goes up, including past
 * numbers whose behaviours are gone.
 *
 * New behaviours are numbered in `suite/id` order so two runs on the same tree
 * agree on who got which.
 */
export function assignNumbers(
  committed: readonly Behaviour[],
  collected: readonly Behaviour[],
  highWater: number,
): { numbered: Behaviour[]; highWater: number } {
  const known = new Map<string, number>();
  for (const b of committed) if (typeof b.num === 'number') known.set(key(b), b.num);

  let next = Math.max(highWater, ...[...known.values()], 0) + 1;
  const ordered = [...collected].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const numbered = ordered.map((b) => {
    const existing = known.get(key(b));
    if (existing !== undefined) return { ...b, num: existing };
    const n = next;
    next += 1;
    return { ...b, num: n };
  });
  return { numbered, highWater: next - 1 };
}

/** Identity is `suite/id/expect`. Two suites may use the same local test id,
 *  and one test's expectations are told apart by their own ids. */
export function key(b: Behaviour): string {
  return `${b.suite}/${b.id}/${b.expect}`;
}

/** The test a behaviour belongs to, for grouping expectations in a report. */
export function testKey(b: Behaviour): string {
  return `${b.suite}/${b.id}`;
}
