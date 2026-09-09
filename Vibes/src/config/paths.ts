/**
 * Path and glob primitives.
 *
 * TWO ANCHORS, ONE MNEMONIC:
 *   things Vibes CREATES anchor at `<root>/vibes/`   → `producers[].out`
 *   things the project ALREADY HAS anchor at `<root>/` → `cwd`, witnesses, ingest
 *   and the registry's own `root` anchors at the repo root.
 *
 * Getting this wrong is silent: a mis-anchored `out` resolves to a real
 * directory that simply never matches a baseline, and the report reads
 * "everything added".
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { Glob, RepoPath } from '../types.js';

/* ─────────────────────────── string form ─────────────────────────────── */

/** Absolute OS path → POSIX. Repo paths are POSIX everywhere in Vibes. */
export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Collapse `./`, duplicate and trailing slashes. Does NOT resolve `..`. */
export function normalizeRel(p: string): string {
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  return parts.join('/');
}

export interface PathProblem {
  readonly reason: string;
  readonly evidence: string;
}

/**
 * Reject anything that is not a plain relative POSIX path. Each of these has
 * bitten a real tool: a backslash silently becomes a literal filename segment
 * on Linux, a leading `/` makes `resolve()` ignore its anchor entirely, and a
 * `..` segment escapes the containment guard it is being checked against.
 */
export function checkRelPath(p: unknown, opts: { readonly allowDot?: boolean } = {}): PathProblem | null {
  if (typeof p !== 'string') return { reason: 'must be a string', evidence: `got ${typeof p}` };
  if (p === '') return { reason: 'must not be empty', evidence: "got ''" };
  if (p.includes('\0')) return { reason: 'must not contain NUL', evidence: JSON.stringify(p) };
  if (p.includes('\\')) {
    return { reason: 'must use POSIX separators', evidence: `${JSON.stringify(p)} contains a backslash` };
  }
  if (isAbsolute(p) || p.startsWith('/')) {
    return { reason: 'must be relative', evidence: `${JSON.stringify(p)} is absolute` };
  }
  if (/^[A-Za-z]:/.test(p)) {
    return { reason: 'must be relative', evidence: `${JSON.stringify(p)} looks like a drive letter path` };
  }
  const parts = p.split('/');
  if (parts.includes('..')) {
    return { reason: 'must not contain a ".." segment', evidence: JSON.stringify(p) };
  }
  if (!opts.allowDot && normalizeRel(p) === '') {
    return { reason: 'must name a path, not the anchor itself', evidence: JSON.stringify(p) };
  }
  return null;
}

/* ─────────────────────────── containment ─────────────────────────────── */

/** True when `child` is strictly inside `parent` (never equal). */
export function isStrictDescendant(parentAbs: string, childAbs: string): boolean {
  const rel = relative(parentAbs, childAbs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function isSameOrDescendant(parentAbs: string, childAbs: string): boolean {
  return parentAbs === childAbs || isStrictDescendant(parentAbs, childAbs);
}

/** Equal, or one strictly inside the other. Used for root/out nesting checks. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || isStrictDescendant(a, b) || isStrictDescendant(b, a);
}

/**
 * realpath the deepest EXISTING ancestor and re-append the missing tail.
 * Containment must be checked on real paths, not lexical ones: this repo has a
 * live in-repo symlink (`SIL/build/MaDControl` → `Software/MaDControl`), and a
 * lexical check through it would let an `out` escape its vibes dir.
 */
export function realpathDeepest(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(head)) {
      try {
        return [realpathSync(head), ...tail].join(sep);
      } catch {
        return abs;
      }
    }
    const parent = dirname(head);
    if (parent === head) return abs;
    tail.unshift(head.slice(parent.length + 1));
    head = parent;
  }
}

/** True when `abs` exists and is a symlink (lstat, not stat). */
export function isSymlink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Case check for an existing path. macOS sets `core.ignorecase=true` and APFS
 * is case-insensitive, so `out: 'Snapshots'` works on a laptop and breaks on
 * the ubuntu runner. Returns the on-disk spelling when it differs.
 */
export function actualCaseMismatch(abs: string): string | null {
  const parent = dirname(abs);
  const want = abs.slice(parent.length + 1);
  if (!existsSync(abs) || !existsSync(parent)) return null;
  let entries: readonly string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return null;
  }
  if (entries.includes(want)) return null;
  const ci = entries.find((e) => e.toLowerCase() === want.toLowerCase());
  return ci ?? null;
}

/** Absolute path → repo-relative POSIX. Throws only on a path outside the repo. */
export function repoRelative(repoRoot: string, abs: string): RepoPath {
  const rel = relative(repoRoot, abs);
  return toPosix(rel);
}

export function joinRepo(repoRoot: string, ...rel: readonly string[]): string {
  return resolve(repoRoot, ...rel);
}

/* ───────────────────────────── globs ─────────────────────────────────── */

/** picomatch magic characters, minus `{}` which is rejected outright. */
const GLOB_MAGIC = /[*?[\]()!+@]/;

export function hasBraces(g: string): boolean {
  return g.includes('{') || g.includes('}');
}

/**
 * Validate a glob as a relative POSIX pattern. A LEADING `!` (negation) is
 * stripped before the path checks; braces are rejected everywhere.
 *
 * WHY braces are rejected rather than expanded: `git ls-files -- '**\/x.{ts,tsx}'`
 * exits 0 and matches NOTHING. A witness that silently matches nothing reads in
 * the report as "this source did not change", which is the exact lie this tool
 * exists to prevent. Accepting braces in one field while git eats them in
 * another is a trap, so no field accepts them.
 */
export function checkGlob(g: unknown): PathProblem | null {
  if (typeof g !== 'string') return { reason: 'must be a string', evidence: `got ${typeof g}` };
  if (hasBraces(g)) {
    return {
      reason: 'must not use brace expansion',
      evidence: `${JSON.stringify(g)} contains { or } — git pathspecs match nothing with braces`,
    };
  }
  const body = g.startsWith('!') ? g.slice(1) : g;
  return checkRelPath(body);
}

/**
 * Leading literal segments, i.e. everything before the first magic character.
 * `src/domain/**` → `src/domain`; `**` → `''`; `!src/x/**` → `src/x`.
 * Used to decide whether a glob can possibly reach into a given directory
 * without enumerating the filesystem.
 */
export function globLiteralPrefix(g: Glob): string {
  const body = g.startsWith('!') ? g.slice(1) : g;
  const out: string[] = [];
  for (const seg of body.split('/')) {
    if (seg === '**' || GLOB_MAGIC.test(seg)) break;
    out.push(seg);
  }
  return out.join('/');
}

/**
 * True when a glob and a directory could share paths — either the glob's
 * literal prefix is inside the directory, or the directory is inside the
 * prefix (in which case the trailing `**` may still reach down into it).
 * Both directions matter: `generates: 'Software/Control/src/generated/**'`
 * must intersect the component rooted at `Software/Control`.
 */
export function globIntersectsDir(g: Glob, dir: RepoPath): boolean {
  const prefix = globLiteralPrefix(g);
  const a = normalizeRel(prefix);
  const b = normalizeRel(dir);
  if (a === '' || b === '') return true;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Re-anchor a root-relative glob (or negation) to the repo root. */
export function anchorGlob(prefix: RepoPath, g: Glob): Glob {
  const neg = g.startsWith('!');
  const body = neg ? g.slice(1) : g;
  const anchored = prefix === '' ? normalizeRel(body) : `${normalizeRel(prefix)}/${normalizeRel(body)}`;
  return neg ? `!${anchored}` : anchored;
}
