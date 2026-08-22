/**
 * `vibes.ignore` — suppressions that EXPIRE and carry a stated reason.
 *
 *     <glob> :: <reason> :: until=<YYYY-MM-DD>
 *
 * WHY `::` and not `#`: a glob may legitimately contain `#`, so `#` as a field
 * separator is ambiguous exactly where ambiguity is expensive. `#` is still a
 * whole-line comment (a glob starting with `#` is not something anyone writes).
 *
 * WHY reason AND until are BOTH mandatory: an unexplained suppression is
 * indistinguishable from a mistake six weeks later, and a suppression that
 * never expires is how a repo accumulates a permanent backlog it has stopped
 * seeing. This repo has already demonstrated both failure modes — a frozen
 * `.layering-baseline` with "burn these down" in its header, and a clippy job
 * pinned to `continue-on-error: true` against a named list. Decay is the whole
 * mechanism; without it this file is an off switch with a comment on it.
 *
 * A missing reason or a missing/invalid `until` is a PARSE ERROR that drops the
 * rule and raises a finding. It is never a silently-ignored line: an author who
 * believes a suppression is in force and is wrong will not look again.
 */

import picomatch from 'picomatch';

import { isIsoDate } from '../config/index.js';
import type { Glob, IsoDate, RepoPath } from '../types.js';

/** The conventional location. Nothing forces it; the CLI passes the path in. */
export const IGNORE_FILENAME = 'vibes.ignore';

export const IGNORE_GRAMMAR = '<glob> :: <reason> :: until=YYYY-MM-DD';

export interface IgnoreRule {
  readonly glob: Glob;
  readonly reason: string;
  readonly until: IsoDate;
  /** 1-based, for the annotation. */
  readonly line: number;
  readonly source: RepoPath;
  readonly raw: string;
}

export interface IgnoreParseError {
  readonly line: number;
  readonly raw: string;
  readonly message: string;
  readonly fix: string;
}

export interface IgnoreFile {
  readonly source: RepoPath;
  readonly rules: readonly IgnoreRule[];
  readonly errors: readonly IgnoreParseError[];
}

export const EMPTY_IGNORE: IgnoreFile = { source: IGNORE_FILENAME, rules: [], errors: [] };

/** Globs that match the entire path universe. Structural, not a tuned constant. */
const UNIVERSAL_GLOBS: ReadonlySet<string> = new Set(['**', '**/*', '*', '**/**']);

export function parseIgnoreFile(text: string, source: RepoPath = IGNORE_FILENAME): IgnoreFile {
  const rules: IgnoreRule[] = [];
  const errors: IgnoreParseError[] = [];

  // Strip a BOM: a UTF-8 BOM would otherwise become part of the first glob and
  // silently make rule 1 match nothing.
  const body = text.replace(/^\uFEFF/, '');

  for (const [i, rawLine] of body.split(/\r?\n/).entries()) {
    const line = i + 1;
    const raw = rawLine.trim();
    if (raw === '' || raw.startsWith('#')) continue;

    const parts = raw.split('::').map((p) => p.trim());
    if (parts.length !== 3) {
      errors.push({
        line,
        raw,
        message:
          parts.length < 3
            ? `expected three \`::\`-separated fields, found ${String(parts.length)}`
            : `expected three \`::\`-separated fields, found ${String(parts.length)} — a reason containing \`::\` splits the line`,
        fix: `write \`${IGNORE_GRAMMAR}\``,
      });
      continue;
    }

    const [glob = '', reason = '', untilField = ''] = parts;
    if (glob === '') {
      errors.push({ line, raw, message: 'empty glob', fix: `write \`${IGNORE_GRAMMAR}\`` });
      continue;
    }
    // Braces are rejected everywhere else in this tool because git pathspecs
    // silently match nothing with them; allowing them here would be a trap of
    // exactly the same shape, in the file whose job is to be understood.
    if (/[{}]/.test(glob)) {
      errors.push({
        line,
        raw,
        message: 'brace expansion is not supported in a vibes.ignore glob',
        fix: 'write one rule per alternative',
      });
      continue;
    }
    if (reason === '') {
      errors.push({
        line,
        raw,
        message: 'a suppression with no stated reason is not reviewable',
        fix: `write \`${IGNORE_GRAMMAR}\``,
      });
      continue;
    }
    const m = /^until\s*=\s*(\S+)$/.exec(untilField);
    if (m === null) {
      errors.push({
        line,
        raw,
        message: 'missing `until=` field — a suppression that never expires is permanent',
        fix: `write \`${IGNORE_GRAMMAR}\``,
      });
      continue;
    }
    const until = m[1] ?? '';
    if (!isIsoDate(until)) {
      errors.push({
        line,
        raw,
        message: `\`until=${until}\` is not a YYYY-MM-DD calendar date`,
        fix: 'use an ISO date, e.g. until=2026-12-31',
      });
      continue;
    }

    rules.push({ glob, reason, until, line, source, raw });
  }

  return { source, rules, errors };
}

/* ───────────────────────────── evaluation ────────────────────────────── */

export interface IgnoreEvaluation {
  readonly file: IgnoreFile;
  readonly active: readonly IgnoreRule[];
  readonly expired: readonly IgnoreRule[];
  /** Active rules that matched nothing in this run's path universe. */
  readonly stale: readonly IgnoreRule[];
  /** Active rules whose glob matches the whole universe, or that between them
   *  match every candidate path. Either neutralises the honesty check. */
  readonly matchesAll: readonly IgnoreRule[];
  readonly suppressesEverything: boolean;
  /** True when the rule set covers every path in the universe (≥3 paths). */
  readonly universeSize: number;
}

/**
 * ISO dates compare correctly as strings, which is why `until` is stored as one
 * and never as a `Date`. `new Date('2026-12-31')` parses as UTC midnight and
 * then renders in local time, so a machine in UTC-8 expires a suppression a day
 * early — a bug that only shows up for people west of Greenwich.
 *
 * A suppression is in force THROUGH the named day: expired iff today > until.
 */
export function isExpired(rule: IgnoreRule, now: Date): boolean {
  return utcDay(now) > rule.until;
}

export function utcDay(now: Date): IsoDate {
  return now.toISOString().slice(0, 10);
}

export function daysExpired(rule: IgnoreRule, now: Date): number {
  const then = Date.parse(`${rule.until}T00:00:00.000Z`);
  const today = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

export function compileRule(rule: IgnoreRule): (p: string) => boolean {
  return picomatch(rule.glob, { dot: false, nobrace: true });
}

/**
 * `universe` is every path this run could have raised a finding about: changed
 * source paths plus snapshot paths. A rule matching none of them is stale — it
 * is silencing nothing, and it will keep silencing nothing until someone reads
 * the file, which is what `suppression-stale` exists to cause.
 */
export function evaluateIgnore(
  file: IgnoreFile,
  now: Date,
  universe: readonly RepoPath[],
): IgnoreEvaluation {
  const active: IgnoreRule[] = [];
  const expired: IgnoreRule[] = [];
  for (const rule of file.rules) (isExpired(rule, now) ? expired : active).push(rule);

  const stale: IgnoreRule[] = [];
  const matchesAll: IgnoreRule[] = [];
  const covered = new Set<RepoPath>();

  for (const rule of active) {
    if (UNIVERSAL_GLOBS.has(rule.glob)) matchesAll.push(rule);
    const match = compileRule(rule);
    const hits = universe.filter((p) => match(p));
    if (hits.length === 0) stale.push(rule);
    for (const h of hits) covered.add(h);
  }

  // The other shape of the same move: no single glob is universal, but between
  // them the rules cover every candidate. Reported only at ≥3 paths, because
  // covering the one file you are working on is ordinary and honest.
  const suppressesEverything =
    active.length > 0 && universe.length >= 3 && covered.size === universe.length;

  return {
    file,
    active,
    expired,
    stale,
    matchesAll,
    suppressesEverything,
    universeSize: universe.length,
  };
}

/**
 * The first active rule that matches EVERY path of a finding, or null.
 *
 * Every, not some: a finding listing ten paths of which one is suppressed still
 * describes nine unsuppressed problems, and hiding it would hide those nine.
 * A finding with no paths cannot be targeted by a path glob and is therefore
 * never suppressible — stated here rather than discovered later.
 */
export function matchingRule(
  paths: readonly RepoPath[] | undefined,
  active: readonly IgnoreRule[],
): IgnoreRule | null {
  if (paths === undefined || paths.length === 0) return null;
  for (const rule of active) {
    const match = compileRule(rule);
    if (paths.every((p) => match(p))) return rule;
  }
  return null;
}
