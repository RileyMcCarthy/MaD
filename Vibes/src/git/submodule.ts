/**
 * Gitlink rows.
 *
 * A submodule pin bump is a real behaviour change with ZERO in-repo content:
 * the superproject diff is one `:160000 160000 <old> <new> M` record and
 * `git diff --unified=0` yields a single `-Subproject commit` / `+Subproject
 * commit` pair. Rendered raw that is an opaque sha swap, so we enrich it from
 * the submodule's OWN history where the objects are present.
 *
 * What we deliberately do NOT do is measure behaviour inside the submodule.
 * Vibes is superproject-only, so every enriched row carries the sentence
 * saying so — a count of upstream commits must never read as coverage.
 */

import type { RepoPath, Sha } from '../types.js';
import { splitLines } from './exec.js';
import type { GitRepo } from './repo.js';
import type { RawDiffEntry } from './rawParse.js';
import { GITLINK_MODE, NULL_OID } from './rawParse.js';

export function notMeasuredSentence(path: RepoPath): string {
  return `Behaviour inside ${path} is not measured by this run.`;
}

export type GitlinkDirection = 'forward' | 'backward' | 'unrelated' | 'unknown';

export interface GitlinkChange {
  readonly path: RepoPath;
  /** All-zeros when the gitlink was added or removed in this diff. */
  readonly base: Sha;
  readonly head: Sha;
  readonly added: boolean;
  readonly removed: boolean;
  /** The submodule is checked out here and both commits are present locally. */
  readonly enriched: boolean;
  readonly direction: GitlinkDirection;
  readonly commitCount: number | null;
  readonly filesChanged: number | null;
  readonly insertions: number | null;
  readonly deletions: number | null;
  readonly subjects: readonly string[];
  /** Why enrichment was not possible, when it was not. */
  readonly reason: string | null;
  /** Always present, always rendered. */
  readonly note: string;
}

export interface EnrichOptions {
  /** How many commit subjects to keep. Reports truncate; the count does not. */
  readonly maxSubjects?: number;
}

/** Pick the gitlink rows out of a raw diff. */
export function gitlinkEntries(entries: readonly RawDiffEntry[]): RawDiffEntry[] {
  return entries.filter(
    (e) => e.srcMode === GITLINK_MODE || e.dstMode === GITLINK_MODE,
  );
}

export async function enrichGitlink(
  repo: GitRepo,
  entry: { readonly path: RepoPath; readonly base: Sha; readonly head: Sha },
  opts: EnrichOptions = {},
): Promise<GitlinkChange> {
  const maxSubjects = opts.maxSubjects ?? 10;
  const dir = `${repo.repoRoot}/${entry.path}`;
  const added = NULL_OID === entry.base;
  const removed = NULL_OID === entry.head;

  const blank = (reason: string, direction: GitlinkDirection = 'unknown'): GitlinkChange => ({
    path: entry.path,
    base: entry.base,
    head: entry.head,
    added,
    removed,
    enriched: false,
    direction,
    commitCount: null,
    filesChanged: null,
    insertions: null,
    deletions: null,
    subjects: [],
    reason,
    note: notMeasuredSentence(entry.path),
  });

  if (added || removed) {
    return blank(
      added ? 'submodule added in this diff' : 'submodule removed in this diff',
    );
  }

  // An uninitialised submodule is an empty directory: `rev-parse` there walks
  // UP and answers for the superproject, which would silently enrich the pin
  // bump with the superproject's own history. Ask for the submodule's own
  // toplevel and require it to match.
  const top = await repo.exec(['rev-parse', '--show-toplevel'], {
    cwd: dir,
    allowCodes: [0, 1, 128],
    strictFatal: false,
  });
  const topPath = top.stdout.toString('utf8').trim();
  if (top.code !== 0 || topPath === '' || !topPath.endsWith(`/${entry.path}`)) {
    return blank(`${entry.path} is not initialised in this checkout`);
  }

  const bothPresent =
    (await objectPresent(repo, dir, entry.base)) &&
    (await objectPresent(repo, dir, entry.head));
  if (!bothPresent) {
    return blank(
      `one of the pinned commits is not present in ${entry.path} (fetch it to enrich this row)`,
    );
  }

  let direction: GitlinkDirection = 'unrelated';
  let count = await revListCount(repo, dir, entry.base, entry.head);
  if (count !== null && count > 0) {
    direction = 'forward';
  } else {
    const back = await revListCount(repo, dir, entry.head, entry.base);
    if (back !== null && back > 0) {
      direction = 'backward';
      count = back;
    } else if (count === 0) {
      direction = 'forward';
    }
  }

  const stat = await shortstat(repo, dir, entry.base, entry.head);
  const log = await repo.exec(
    [
      'log',
      '--no-color',
      '--format=%s',
      `--max-count=${String(maxSubjects)}`,
      direction === 'backward'
        ? `${entry.head}..${entry.base}`
        : `${entry.base}..${entry.head}`,
    ],
    { cwd: dir, allowCodes: [0, 1, 128], strictFatal: false },
  );

  return {
    path: entry.path,
    base: entry.base,
    head: entry.head,
    added: false,
    removed: false,
    enriched: true,
    direction,
    commitCount: count,
    filesChanged: stat.files,
    insertions: stat.insertions,
    deletions: stat.deletions,
    subjects: log.code === 0 ? splitLines(log.stdout) : [],
    reason: null,
    note: notMeasuredSentence(entry.path),
  };
}

export async function enrichGitlinks(
  repo: GitRepo,
  entries: readonly RawDiffEntry[],
  opts: EnrichOptions = {},
): Promise<GitlinkChange[]> {
  const out: GitlinkChange[] = [];
  for (const e of gitlinkEntries(entries)) {
    const sub = e.submodule;
    if (sub === undefined) continue;
    out.push(await enrichGitlink(repo, { path: e.path, base: sub.base, head: sub.head }, opts));
  }
  return out;
}

/** One-line render, e.g. `SIL/embsim 7c3db495 → 25782af8 — 5 commits, 11 files`. */
export function describeGitlink(g: GitlinkChange): string {
  const arrow = `${g.base.slice(0, 8)} → ${g.head.slice(0, 8)}`;
  if (!g.enriched) return `${g.path} ${arrow} — ${g.reason ?? 'not enriched'}`;
  const bits: string[] = [];
  if (g.commitCount !== null) {
    bits.push(`${String(g.commitCount)} commit${g.commitCount === 1 ? '' : 's'}`);
  }
  if (g.filesChanged !== null) {
    bits.push(`${String(g.filesChanged)} file${g.filesChanged === 1 ? '' : 's'} changed upstream`);
  }
  if (g.direction === 'backward') bits.push('PIN MOVED BACKWARD');
  if (g.direction === 'unrelated') bits.push('unrelated histories');
  return `${g.path} ${arrow} — ${bits.join(', ')}`;
}

/* ─────────────────────────────── internals ───────────────────────────────── */

async function objectPresent(repo: GitRepo, dir: string, sha: Sha): Promise<boolean> {
  const r = await repo.exec(['cat-file', '-e', `${sha}^{commit}`], {
    cwd: dir,
    allowCodes: [0, 1, 128],
    strictFatal: false,
  });
  return r.code === 0;
}

async function revListCount(
  repo: GitRepo,
  dir: string,
  from: Sha,
  to: Sha,
): Promise<number | null> {
  const r = await repo.exec(['rev-list', '--count', `${from}..${to}`], {
    cwd: dir,
    allowCodes: [0, 1, 128],
    strictFatal: false,
  });
  if (r.code !== 0) return null;
  const n = Number(r.stdout.toString('utf8').trim());
  return Number.isSafeInteger(n) ? n : null;
}

const SHORTSTAT_RE =
  /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

async function shortstat(
  repo: GitRepo,
  dir: string,
  from: Sha,
  to: Sha,
): Promise<{ files: number | null; insertions: number | null; deletions: number | null }> {
  const r = await repo.exec(['diff', '--shortstat', '--no-color', from, to], {
    cwd: dir,
    allowCodes: [0, 1, 128],
    strictFatal: false,
  });
  if (r.code !== 0) return { files: null, insertions: null, deletions: null };
  const m = SHORTSTAT_RE.exec(r.stdout.toString('utf8'));
  if (m === null) return { files: null, insertions: null, deletions: null };
  const num = (s: string | undefined): number | null =>
    s === undefined ? 0 : Number(s);
  return {
    files: Number(m[1]),
    insertions: num(m[2]),
    deletions: num(m[3]),
  };
}
