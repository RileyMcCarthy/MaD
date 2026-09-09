/**
 * Escape detection — what a producer touched OUTSIDE its received dir.
 *
 * `git status --porcelain=v1 -z -uall` before and after, and classify the
 * difference. Under the received/approved design the classification is
 * stricter than the original sketch: a write into a COMMITTED baseline dir is
 * now a violation whoever owns it, because `vibes accept` is the only writer
 * there. `git add -A` after a run must stage nothing under a baseline, and that
 * property is what restores the accept step.
 *
 * TWO STRUCTURAL BLIND SPOTS, disclosed rather than papered over:
 *   1. Writes under gitignored paths (`node_modules/`, `.pio/`, `target/`,
 *      `dist/`) are invisible by construction — and MUST be, because legitimate
 *      cargo and PlatformIO producers write there.
 *   2. Writes to absolute paths outside the repo (`~/.cargo`, `/tmp/tty.rpi`)
 *      are entirely undetected. There is no portable sandbox across macOS and
 *      Linux CI. Malicious-producer defence is out of scope; accidental-escape
 *      defence is in scope, and this is it.
 */

import type { RepoPath } from '../types.js';
import type { StatusEntry } from '../git/index.js';
import { STATE_DIR } from './constants.js';

export type EscapeKind =
  /** Wrote into a committed baseline dir. Only `vibes accept` may. */
  | 'baseline-write'
  /** Modified a tracked file anywhere else in the repo. */
  | 'mutated-source'
  /** Created an untracked, non-ignored file outside every out dir. */
  | 'stray-write'
  /** A submodule gitlink went dirty. */
  | 'submodule-dirty';

export interface Escape {
  readonly kind: EscapeKind;
  readonly path: RepoPath;
  readonly status: string;
  readonly detail: string;
}

export interface EscapeContext {
  /** Every producer's committed out dir, repo-relative POSIX. */
  readonly outRepos: readonly RepoPath[];
  /** The out dir belonging to the producer under scrutiny, when known. */
  readonly ownOutRepo?: RepoPath | null;
  readonly submodules: readonly RepoPath[];
  /** Repo-relative paths that were already dirty before the run and are not
   *  this producer's fault. */
  readonly preexisting?: ReadonlySet<RepoPath>;
}

export type StatusMap = ReadonlyMap<RepoPath, string>;

/** `XY` per path — the two porcelain-v1 status characters, joined. */
export function statusMap(entries: readonly StatusEntry[]): StatusMap {
  const m = new Map<RepoPath, string>();
  for (const e of entries) m.set(e.path, `${e.index}${e.worktree}`);
  return m;
}

export interface StatusDelta {
  readonly path: RepoPath;
  readonly status: string;
  readonly before: string | null;
}

/** Paths whose status appeared or changed between the two snapshots. */
export function statusDelta(before: StatusMap, after: StatusMap): readonly StatusDelta[] {
  const out: StatusDelta[] = [];
  for (const [path, status] of after) {
    const prior = before.get(path) ?? null;
    if (prior === status) continue;
    out.push({ path, status, before: prior });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function under(path: RepoPath, dir: RepoPath): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

export function classifyEscapes(deltas: readonly StatusDelta[], ctx: EscapeContext): readonly Escape[] {
  const escapes: Escape[] = [];
  const pre = ctx.preexisting ?? new Set<RepoPath>();

  for (const d of deltas) {
    if (pre.has(d.path)) continue;

    // `.vibes/` is gitignored scratch, so it should never appear here at all;
    // if a repo's ignore block is wrong it will, and that is a preflight
    // finding rather than a per-producer escape.
    if (under(d.path, STATE_DIR)) continue;

    const sub = ctx.submodules.find((s) => d.path === s);
    if (sub !== undefined) {
      escapes.push({
        kind: 'submodule-dirty',
        path: d.path,
        status: d.status,
        // The superproject collapses ALL dirt inside a submodule into one
        // ` M <sub>` line, so the remedy has to name the inner command.
        detail: `submodule pin or worktree went dirty; run \`git -C ${d.path} status --porcelain\` to see what`,
      });
      continue;
    }

    const outDir = ctx.outRepos.find((o) => under(d.path, o));
    if (outDir !== undefined) {
      const own = ctx.ownOutRepo !== null && ctx.ownOutRepo !== undefined && outDir === ctx.ownOutRepo;
      escapes.push({
        kind: 'baseline-write',
        path: d.path,
        status: d.status,
        detail: own
          ? `a producer wrote into its own committed baseline ${outDir}; write to $VIBES_OUT_DIR instead`
          : `a producer wrote into ${outDir}, another producer's committed baseline`,
      });
      continue;
    }

    const untracked = d.status === '??';
    escapes.push(
      untracked
        ? {
            kind: 'stray-write',
            path: d.path,
            status: d.status,
            detail: 'new untracked, non-ignored file created outside every declared out dir',
          }
        : {
            kind: 'mutated-source',
            path: d.path,
            status: d.status,
            detail: 'tracked file modified by a producer; the run measured a tree it also changed',
          },
    );
  }
  return escapes;
}

/** Submodule paths that are dirty right now. R-M4: a run that starts on a
 *  dirty submodule is measuring an unknown tree. */
export function dirtySubmodules(
  entries: readonly StatusEntry[],
  submodules: readonly RepoPath[],
): readonly RepoPath[] {
  const set = new Set(submodules);
  return entries
    .filter((e) => set.has(e.path) && `${e.index}${e.worktree}`.trim() !== '')
    .map((e) => e.path)
    .sort();
}
