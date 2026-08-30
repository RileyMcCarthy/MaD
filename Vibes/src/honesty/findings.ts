/**
 * The finding accumulator, and the false-positive budget it enforces.
 *
 * A check nobody reads is worth nothing, and the fastest way to make a check
 * unreadable is to emit it per file. A 300-file refactor must produce ONE
 * warning carrying a path list, not 300 warnings — so the bag is keyed on
 * `(code, component, producer)` and a second add on the same key merges paths
 * and evidence into the first rather than appending a row.
 *
 * Suppression is applied here, at the end, for one reason: a suppressed finding
 * must still be LISTED, with the rule that governs it. Filtering at the source
 * would make the suppressed set unobservable, and an unobservable suppression
 * is the thing this tool exists to prevent.
 */

import type { ComponentId, Finding, ProducerName, RepoPath } from '../types.js';
import type { IgnoreRule } from './ignore.js';
import { matchingRule } from './ignore.js';
import type { FindingCode, FindingInit, HonestyFinding, SuppressionRef } from './model.js';
import { NON_SUPPRESSIBLE, findingId, makeFinding } from './model.js';

export class FindingBag {
  readonly #order: string[] = [];
  readonly #byKey = new Map<string, HonestyFinding>();

  /** Returns the finding as stored — the merged one when the key repeats. */
  add(init: FindingInit): HonestyFinding {
    const key = findingId(init.code, init.component, init.producer);
    const prior = this.#byKey.get(key);
    if (prior === undefined) {
      const made = makeFinding(init);
      this.#byKey.set(key, made);
      this.#order.push(key);
      return made;
    }
    const merged = mergeFinding(prior, init);
    this.#byKey.set(key, merged);
    return merged;
  }

  has(code: FindingCode, component?: ComponentId, producer?: ProducerName): boolean {
    return this.#byKey.has(findingId(code, component, producer));
  }

  get items(): readonly HonestyFinding[] {
    return this.#order.map((k) => this.#byKey.get(k)).filter((f): f is HonestyFinding => !!f);
  }

  /** Stable across runs: severity, then code, then id. Never insertion order —
   *  two runs on the same tree must produce byte-identical reports. */
  sorted(): readonly HonestyFinding[] {
    return sortFindings(this.items);
  }
}

function mergeFinding(prior: HonestyFinding, init: FindingInit): HonestyFinding {
  const paths = dedupe([...(prior.paths ?? []), ...(init.paths ?? [])]);
  return {
    ...prior,
    // The louder severity wins: merging must never quiet an existing row.
    severity: worse(prior.severity, init.severity),
    evidence: dedupe([...prior.evidence, ...(init.evidence ?? [])]),
    ...(paths.length > 0 ? { paths } : {}),
  };
}

function worse(a: Finding['severity'], b: Finding['severity']): Finding['severity'] {
  const rank = { error: 0, warn: 1, info: 2 } as const;
  return rank[a] <= rank[b] ? a : b;
}

function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

export function sortFindings(items: readonly HonestyFinding[]): readonly HonestyFinding[] {
  const rank = { error: 0, warn: 1, info: 2 } as const;
  return [...items].sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/* ──────────────────────────── suppression ────────────────────────────── */

export interface SuppressionOutcome {
  /** Every finding, suppressed ones included, with `suppressedBy` set. */
  readonly all: readonly HonestyFinding[];
  /** Findings that count towards failure. */
  readonly effective: readonly HonestyFinding[];
  readonly suppressed: readonly HonestyFinding[];
  /** Rules that actually silenced something this run. */
  readonly usedRules: readonly IgnoreRule[];
}

export function applySuppressions(
  findings: readonly HonestyFinding[],
  active: readonly IgnoreRule[],
): SuppressionOutcome {
  const all: HonestyFinding[] = [];
  const effective: HonestyFinding[] = [];
  const suppressed: HonestyFinding[] = [];
  const used = new Map<string, IgnoreRule>();

  for (const f of findings) {
    const rule = NON_SUPPRESSIBLE.has(f.code) ? null : matchingRule(f.paths, active);
    if (rule === null) {
      all.push(f);
      effective.push(f);
      continue;
    }
    const marked: HonestyFinding = { ...f, suppressedBy: toRef(rule) };
    all.push(marked);
    suppressed.push(marked);
    used.set(`${rule.source}:${String(rule.line)}`, rule);
  }

  return { all, effective, suppressed, usedRules: [...used.values()] };
}

export function toRef(rule: IgnoreRule): SuppressionRef {
  return {
    glob: rule.glob,
    reason: rule.reason,
    until: rule.until,
    source: rule.source,
    line: rule.line,
  };
}

/** The types.ts shape, for `RunReport.findings` / `ComponentResult.findings`. */
export function toContractFinding(f: HonestyFinding): Finding {
  const detail =
    f.suppressedBy === null
      ? f.detail
      : `${f.detail} — suppressed by \`${f.suppressedBy.glob}\` in ${f.suppressedBy.source}:${String(f.suppressedBy.line)} ("${f.suppressedBy.reason}", until ${f.suppressedBy.until})`;
  return {
    id: f.id,
    severity: f.severity,
    title: f.title,
    detail,
    ...(f.component !== undefined ? { component: f.component } : {}),
    ...(f.paths !== undefined ? { paths: f.paths } : {}),
    ...(f.alwaysExpanded !== undefined ? { alwaysExpanded: f.alwaysExpanded } : {}),
  };
}

/** `n paths` with the first few named — the detail line, not a wall of text. */
export function describePaths(paths: readonly RepoPath[], show = 3): string {
  if (paths.length === 0) return 'no paths';
  const head = paths.slice(0, show).map((p) => `\`${p}\``).join(', ');
  const rest = paths.length - Math.min(show, paths.length);
  return rest > 0 ? `${head} and ${String(rest)} more` : head;
}
