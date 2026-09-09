/**
 * Finding artifacts on disk.
 *
 * Ingest globs match the FILESYSTEM, not git (R-I1): these files are generated
 * by a test run and are almost always gitignored, so the git-tracked universe
 * — which is the only universe witnesses may use — would find nothing here.
 * Mixing the two universes gives a wrong answer in both directions.
 *
 * Hand-rolled rather than fast-glob: the literal prefix of every real ingest
 * glob ('vibes/artifacts/*.xml') makes the walk a single readdir, and a
 * dependency whose entire job is one readdir is not worth its supply chain.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import picomatch from 'picomatch';

import type { Glob } from '../types.js';
import { toPosix } from './paths.js';

export interface DiscoveredFile {
  readonly absPath: string;
  readonly mtimeMs: number;
  readonly bytes: number;
}

export interface DiscoverOptions {
  /** Directories never descended into unless the glob's literal prefix names them. */
  readonly skipDirs?: readonly string[];
  /** Guard against a pathological `**` at the repo root. */
  readonly maxEntries?: number;
}

const DEFAULT_SKIP = ['.git', 'node_modules'];

/**
 * Match one glob against the filesystem under `baseAbs`.
 *
 * picomatch options mirror the witness matcher: `nobrace` because git
 * pathspecs silently match NOTHING for `{a,b}`, so a brace pattern that worked
 * here and failed there would be the worst kind of inconsistency; `dot:false`
 * because an artifact in a dotdir must be named explicitly. Candidate paths
 * are POSIX-normalised before matching, so no slash option is needed.
 *
 * Symlinked directories are not followed (cycles, and a symlink out of the
 * repo is not this component's artifact); a symlinked FILE is accepted, since
 * that is how CI often stages a report.
 */
export async function globFiles(
  baseAbs: string,
  pattern: Glob,
  opts: DiscoverOptions = {},
): Promise<readonly DiscoveredFile[]> {
  const skip = new Set(opts.skipDirs ?? DEFAULT_SKIP);
  const maxEntries = opts.maxEntries ?? 200_000;

  const scan = picomatch.scan(pattern);
  const literalBase = typeof scan.base === 'string' ? scan.base : '';
  const rootAbs = isAbsolute(pattern) ? literalBase || '/' : resolve(baseAbs, literalBase);
  // Anything in the literal prefix is explicitly asked for, so a glob that
  // names node_modules gets node_modules.
  for (const part of literalBase.split('/')) skip.delete(part);

  if (!scan.isGlob) {
    const target = isAbsolute(pattern) ? pattern : resolve(baseAbs, pattern);
    const st = await statFile(target);
    return st === null ? [] : [st];
  }

  const matchRoot = isAbsolute(pattern) ? '/' : resolve(baseAbs);
  // No posixSlashes option: relOf() already emits POSIX separators, and
  // picomatch v4 does not accept that key.
  const isMatch = picomatch(pattern, { dot: false, nobrace: true });

  const out: DiscoveredFile[] = [];
  let visited = 0;
  const stack: string[] = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // missing or unreadable directory is simply "no match"
    }
    for (const e of entries) {
      visited += 1;
      if (visited > maxEntries) {
        throw new Error(`ingest glob '${pattern}' walked more than ${maxEntries} entries; narrow it`);
      }
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) stack.push(abs);
        continue;
      }
      if (e.isSymbolicLink()) {
        const st = await statFile(abs);
        if (st === null) continue;
        if (isMatch(relOf(matchRoot, abs))) out.push(st);
        continue;
      }
      if (!e.isFile()) continue;
      if (!isMatch(relOf(matchRoot, abs))) continue;
      const st = await statFile(abs);
      if (st !== null) out.push(st);
    }
  }

  // Bytewise sort: two runs on the same tree must merge artifacts in the same
  // order, or the case list — and the report bytes — depend on readdir order.
  return out.sort((a, b) => (a.absPath < b.absPath ? -1 : a.absPath > b.absPath ? 1 : 0));
}

function relOf(rootAbs: string, abs: string): string {
  if (rootAbs === '/') return toPosix(abs);
  const prefix = rootAbs.endsWith('/') ? rootAbs : `${rootAbs}/`;
  return abs.startsWith(prefix) ? toPosix(abs.slice(prefix.length)) : toPosix(abs);
}

async function statFile(abs: string): Promise<DiscoveredFile | null> {
  try {
    const st = await fs.stat(abs); // follows symlinks on purpose
    if (!st.isFile()) return null;
    return { absPath: abs, mtimeMs: st.mtimeMs, bytes: st.size };
  } catch {
    return null;
  }
}
