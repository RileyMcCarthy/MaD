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
  readonly v: 1;
  /** Stable across rewording. THE identity — a reworded behaviour is a change
   *  to `then`, not one behaviour deleted and another added. */
  readonly id: string;
  readonly suite: string;
  readonly lang: string;
  /** Repo-relative, normalised by the collector from three path conventions. */
  readonly file: string;
  /** The runner's own name for the test. Only used to join status. */
  readonly test: string;
  readonly given: string;
  readonly then: string;
  /** `path#symbol` the behaviour exercises. Optional; joins to coverage. */
  readonly covers?: string;
  /** Why it matters — a pinned defect, a requirement. */
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
      if (b.v !== 1) {
        bad.push(`schema v${String(b.v)} is not supported (expects v1): ${line.slice(0, 80)}`);
        continue;
      }
      if (typeof b.id !== 'string' || b.id === '') {
        bad.push(`record has no id: ${line.slice(0, 80)}`);
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
  const sorted = [...items].sort((a, b) =>
    a.suite !== b.suite ? (a.suite < b.suite ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return sorted.map((b) => JSON.stringify(b)).join('\n') + (sorted.length > 0 ? '\n' : '');
}

/** Identity is `suite/id`. Two suites may legitimately use the same local id. */
export function key(b: Behaviour): string {
  return `${b.suite}/${b.id}`;
}
