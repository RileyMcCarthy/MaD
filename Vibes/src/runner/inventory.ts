/**
 * What the producer actually wrote.
 *
 * The received directory is AUTHORITATIVE, and it can be, because the runner
 * emptied it moments earlier. That single fact removes an entire family of
 * heuristics the earlier design needed: no mtime slack, no `.vibes-produced`
 * manifest a producer could lie in, no quarantine, and no restore-on-crash
 * (which would have made a crashed producer read as byte-identical).
 *
 * This is also the ONE place in Vibes that walks a filesystem rather than
 * asking git. That is legitimate exactly here: the received dir is private
 * scratch with no ignore semantics. Everywhere else, a filesystem walk would
 * surface files git deliberately hides, and the tool would report on bytes no
 * reviewer will ever see.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';

import type { GitPort, RepoPath, Sha } from '../types.js';
import { isAcceptWritten } from '../types.js';
import { looksBinary, sha256 } from '../git/index.js';
import { CENSUS_FILE, RESERVED_BASENAMES, SELECTION_FILE } from './constants.js';

export type Eol = 'lf' | 'crlf' | 'mixed' | 'none';

export interface EmittedFile {
  /** POSIX, relative to the received dir — the same key the baseline uses. */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly isBinary: boolean;
  readonly eol: Eol;
  readonly hasBom: boolean;
  readonly endsWithNewline: boolean;
  readonly oversize: boolean;
}

export interface Inventory {
  readonly files: readonly EmittedFile[];
  /** Symlinks are recorded and NEVER followed: a link is a way to make the
   *  comparator read bytes from outside the producer's own output. */
  readonly symlinks: readonly string[];
  /** Groups of paths that differ only by case. Harmless on ext4, fatal on
   *  APFS — one of them silently disappears when the baseline is checked out. */
  readonly caseCollisions: readonly (readonly string[])[];
  readonly totalBytes: number;
  /** Hit `maxFilesPerProducer`; the walk stopped. */
  readonly truncated: boolean;
}

export interface InventoryOptions {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
}

export async function inventoryDir(absDir: string, opts: InventoryOptions): Promise<Inventory> {
  const files: EmittedFile[] = [];
  const symlinks: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // the dir may not exist (producer never ran, or wrote nothing)
    }
    // Bytewise, never localeCompare: the report must be byte-identical between
    // two runs on the same tree, and locale collation is not stable across
    // machines or ICU versions.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (truncated) return;
      const rel = prefix === '' ? entry.name : posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue; // fifo, socket, device: not snapshot material
      if (files.length >= opts.maxFiles) {
        truncated = true;
        return;
      }
      const buf = await readFile(join(dir, entry.name));
      totalBytes += buf.length;
      files.push({
        file: rel,
        sha256: sha256(buf),
        bytes: buf.length,
        isBinary: looksBinary(buf),
        eol: detectEol(buf),
        hasBom: hasBom(buf),
        endsWithNewline: buf.length > 0 && buf[buf.length - 1] === 0x0a,
        oversize: buf.length > opts.maxFileBytes,
      });
    }
  };

  await walk(absDir, '');
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return {
    files,
    symlinks: symlinks.sort(),
    caseCollisions: findCaseCollisions(files.map((f) => f.file)),
    totalBytes,
    truncated,
  };
}

/** git's own rule: a NUL in the first 8000 bytes. Re-exported through the git
 *  module so there is exactly one definition of "binary" in the tool. */
export { looksBinary };

export function hasBom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

export function detectEol(buf: Buffer): Eol {
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0x0a) continue;
    if (i > 0 && buf[i - 1] === 0x0d) crlf += 1;
    else lf += 1;
  }
  if (lf === 0 && crlf === 0) return 'none';
  if (lf > 0 && crlf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

export function findCaseCollisions(paths: readonly string[]): readonly (readonly string[])[] {
  const byLower = new Map<string, string[]>();
  for (const p of paths) {
    const key = p.toLowerCase();
    const bucket = byLower.get(key);
    if (bucket === undefined) byLower.set(key, [p]);
    else bucket.push(p);
  }
  return [...byLower.values()].filter((g) => g.length > 1).sort((a, b) => ((a[0] ?? '') < (b[0] ?? '') ? -1 : 1));
}

/* ─────────────────────── census, selection, corpus floor ─────────────── */

export interface CensusResult {
  readonly present: boolean;
  readonly cases: readonly string[] | null;
  readonly error: string | null;
}

/**
 * `_vibes-census.json` is the producer's SELF-REPORTED corpus roster.
 *
 * It is snapshot-compared like any other file, so a removed id renders as a
 * named row rather than a silent absence. It is not a security boundary and the
 * report says so: a producer that shrinks its corpus *and* pads `cases[]`
 * defeats both this and `minCases`. What it cannot do is make the edit
 * invisible.
 */
export async function readCensus(absDir: string): Promise<CensusResult> {
  let raw: string;
  try {
    raw = await readFile(join(absDir, CENSUS_FILE), 'utf8');
  } catch {
    return { present: false, cases: null, error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { present: true, cases: null, error: `unparseable: ${(e as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { present: true, cases: null, error: 'not a JSON object' };
  }
  const cases = (parsed as { cases?: unknown }).cases;
  if (!Array.isArray(cases) || cases.some((c) => typeof c !== 'string')) {
    return { present: true, cases: null, error: '`cases` is not an array of strings' };
  }
  return { present: true, cases: cases as string[], error: null };
}

/**
 * `.vibes-selected` — the partial-corpus contract.
 *
 * MaD's smoke lane emits 18 of a 32-entry catalog. Without this, every CI run
 * would report 14 DELETIONS, and a permanent wall of false deletions is exactly
 * what disarms the real `corpus-shrank` signal.
 */
export async function readSelection(absDir: string): Promise<readonly string[] | null> {
  let raw: string;
  try {
    raw = await readFile(join(absDir, SELECTION_FILE), 'utf8');
  } catch {
    return null;
  }
  const ids = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  return ids;
}

export function isReserved(file: string): boolean {
  return RESERVED_BASENAMES.includes(basename(file));
}

/** Bookkeeping files are not cases. Counting them would let a producer pass
 *  `minCases` by emitting nothing but its own census. */
export function countCases(files: readonly EmittedFile[], census: CensusResult | null): number {
  if (census !== null && census.cases !== null) return census.cases.length;
  return files.filter((f) => !isReserved(f.file)).length;
}

/**
 * The same count over the COMMITTED baseline at `rev`.
 *
 * This is what makes `minCases` monotonic rather than a floor an author can
 * simply lower: a producer that shrinks its own corpus to make a diff vanish is
 * caught by comparing against what it emitted last time, not against a number
 * in the same PR's manifest.
 */
export async function baselineCaseCount(
  git: GitPort,
  rev: Sha,
  outRepo: RepoPath,
): Promise<{ readonly count: number | null; readonly fromCensus: boolean }> {
  let paths: readonly RepoPath[];
  try {
    paths = await git.lsTree(rev, outRepo);
  } catch {
    return { count: null, fromCensus: false };
  }
  if (paths.length === 0) return { count: null, fromCensus: false };

  const censusPath = `${outRepo}/${CENSUS_FILE}`;
  if (paths.includes(censusPath)) {
    try {
      const blob = await git.readBlob(rev, censusPath);
      if (blob !== null) {
        const v: unknown = JSON.parse(blob.toString('utf8'));
        const cases = typeof v === 'object' && v !== null ? (v as { cases?: unknown }).cases : undefined;
        if (Array.isArray(cases)) return { count: cases.length, fromCensus: true };
      }
    } catch {
      /* fall through to the file count — an unparseable baseline census is
       * itself reported by the compare layer, not swallowed here */
    }
  }
  // `isReserved` covers producer bookkeeping (census, provenance, selection).
  // Accept's own receipt and `.gitattributes` are a different category: the
  // producer never emits them, so counting them inflates the baseline and
  // every run reports `corpus-shrank`, which disqualifies the producer and
  // renders it `not-run`. This is the third module the same rule was needed
  // in; it now comes from one place.
  // NOTE the out-dir-relative path, NOT basename(): `isAcceptWritten` is
  // top-level-only by design, and basename() would strip the nesting and so
  // wrongly exclude a producer-emitted `cases/.gitattributes`.
  const prefix = `${outRepo.replace(/\/+$/, '')}/`;
  const rel = (p: RepoPath): string => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  return {
    count: paths.filter((p) => !isReserved(p) && !isAcceptWritten(rel(p))).length,
    fromCensus: false,
  };
}
