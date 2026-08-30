/**
 * Turning paths inside artifacts into RepoPaths.
 *
 * Artifacts are written by other tools, in their own cwd, with their own idea
 * of what a path means. Three shapes show up in real files:
 *
 *   /Users/ci/work/repo/Software/Control/src/x.ts   vitest JSON `name`
 *   src/domain/gcode.ts                             lcov SF, run from the component
 *   Software/Control/src/domain/gcode.ts            lcov SF, run with --root ../..
 *
 * The last two are indistinguishable without knowing where the tool ran, which
 * is why the anchor is declared (`sourceRoot`) and why the tracked-path set is
 * consulted before accepting a mapping.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { RepoPath } from '../types.js';

/** POSIX-ify. Report bytes must be identical on every platform. */
export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function realpathSafe(p: string): string {
  try {
    return existsSync(p) ? realpathSync.native(p) : p;
  } catch {
    return p;
  }
}

export interface Relativizer {
  /** Absolute path → RepoPath, or null when it is outside the repo. */
  (abs: string): RepoPath | null;
}

/**
 * Build a relativizer for `repoRoot`.
 *
 * It tries the literal root AND its realpath, because on macOS `/tmp` is a
 * symlink to `/private/tmp` — verified in this session's own scratchpad path —
 * so a tool launched via `/tmp/x` reports `/private/tmp/x` and a naive
 * `relative()` yields `../../../private/tmp/x`, i.e. "outside the repo", i.e.
 * every path silently unmapped.
 */
export function createRelativizer(repoRoot: string): Relativizer {
  const roots = [resolve(repoRoot)];
  const real = realpathSafe(resolve(repoRoot));
  if (real !== roots[0]) roots.push(real);

  return (abs: string): RepoPath | null => {
    const direct = under(roots, resolve(abs));
    if (direct !== null) return direct;
    // Only pay for a realpath syscall when the cheap answer failed.
    const viaReal = realpathSafe(resolve(abs));
    return viaReal === resolve(abs) ? null : under(roots, viaReal);
  };
}

function under(roots: readonly string[], abs: string): RepoPath | null {
  for (const root of roots) {
    const rel = relative(root, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    return toPosix(rel);
  }
  return null;
}

export type MapOutcome =
  | { readonly ok: true; readonly path: RepoPath; readonly viaRepoRootFallback: boolean }
  | { readonly ok: false; readonly resolved: string | null; readonly reason: 'outside-repo' | 'untracked' };

export interface MapPathOptions {
  readonly relativize: Relativizer;
  readonly repoRoot: string;
  /** Absolute anchor for RELATIVE paths found inside the artifact. */
  readonly anchorAbs: string;
  /** When present, a mapping that is not tracked is rejected, not guessed at. */
  readonly trackedPaths?: ReadonlySet<RepoPath> | undefined;
}

/**
 * Map one path out of an artifact onto a RepoPath.
 *
 * The monorepo trap (R-I4): with `sourceRoot: '.'` at `Software/Control`, an
 * `SF:` of `src/domain/gcode.ts` is correct, but the SAME tool run with
 * `--root ../..` emits `Software/Control/src/domain/gcode.ts`, which anchoring
 * would double-prefix into a path that does not exist. When a tracked-path set
 * is available we detect exactly that case and fall back — evidence-based, not
 * a guess. Without the set we cannot tell, so we take the anchored answer and
 * say so via `viaRepoRootFallback: false`.
 */
export function mapArtifactPath(raw: string, opts: MapPathOptions): MapOutcome {
  const cleaned = raw.trim();
  if (cleaned === '') return { ok: false, resolved: null, reason: 'outside-repo' };

  if (isAbsolute(cleaned)) {
    const rel = opts.relativize(cleaned);
    if (rel === null) return { ok: false, resolved: cleaned, reason: 'outside-repo' };
    if (opts.trackedPaths !== undefined && !opts.trackedPaths.has(rel)) {
      return { ok: false, resolved: rel, reason: 'untracked' };
    }
    return { ok: true, path: rel, viaRepoRootFallback: false };
  }

  const anchored = opts.relativize(resolve(opts.anchorAbs, cleaned));
  const tracked = opts.trackedPaths;
  if (tracked === undefined) {
    return anchored === null
      ? { ok: false, resolved: resolve(opts.anchorAbs, cleaned), reason: 'outside-repo' }
      : { ok: true, path: anchored, viaRepoRootFallback: false };
  }

  if (anchored !== null && tracked.has(anchored)) {
    return { ok: true, path: anchored, viaRepoRootFallback: false };
  }
  const asRepoRelative = opts.relativize(resolve(opts.repoRoot, cleaned));
  if (asRepoRelative !== null && tracked.has(asRepoRelative)) {
    return { ok: true, path: asRepoRelative, viaRepoRootFallback: true };
  }
  return anchored === null
    ? { ok: false, resolved: resolve(opts.anchorAbs, cleaned), reason: 'outside-repo' }
    : { ok: false, resolved: anchored, reason: 'untracked' };
}
