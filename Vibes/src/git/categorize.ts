/**
 * Categorization — turning git's raw output into the states the report speaks.
 *
 * Two independent jobs live here and they use DIFFERENT machinery on purpose:
 *
 *  A. Changed SOURCE paths use a real `git diff --raw`, with rename detection
 *     turned up and turned on FIRST. Fact 26: the real `Software/MaDWasmControl
 *     → Software/Control` move detects at R100/R099, and without rename
 *     detection ahead of per-file compare it reads as a delete plus an add —
 *     hundreds of phantom rows, and a corpus entry that "vanished".
 *
 *  B. Snapshot files do NOT use `git diff` at all. The baseline roster comes
 *     from `ls-tree` at the base and the current side comes from the received
 *     inventory, because the received directory is gitignored scratch that git
 *     cannot see. Set arithmetic gives added/deleted/present, and renames are a
 *     post-pass on content hash — which is strictly MORE correct here than
 *     `git diff -M`, since a content-hash rename has no `diff.renameLimit`
 *     (default 1000) to silently exceed.
 */

import { createHash } from 'node:crypto';

import type { RepoPath, Sha } from '../types.js';
import { splitZ } from './exec.js';
import type { GitRepo } from './repo.js';
import type { RawDiffEntry } from './rawParse.js';
import { GITLINK_MODE } from './rawParse.js';
import { changedLinesFor, isCosmetic, type LineChanges } from './changedLines.js';

/* ══════════════════════════ A. changed source paths ═══════════════════════ */

export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'mode-only';

export type ChangedPathKind =
  | 'file'
  | 'gitlink'
  | 'vibes-manifest'
  | 'vibes-config'
  | 'vibes-lock'
  | 'vibes-ignore'
  | 'vibes-receipt';

export interface ChangedSourcePath {
  readonly path: RepoPath;
  /** Source path of a rename or copy. */
  readonly oldPath: RepoPath | null;
  readonly status: ChangeStatus;
  /** Governance edits get their own kind so the honesty check can escalate them. */
  readonly kind: ChangedPathKind;
  readonly similarity: number | null;
  /** Never in the index — invisible to a plain `git diff <base>`. */
  readonly isUntracked: boolean;
  /** null when line detail was not computed for this path, NOT "text". */
  readonly isBinary: boolean | null;
  readonly submodule: { readonly base: Sha; readonly head: Sha } | null;
  readonly lines: LineChanges | null;
  /**
   * Every changed line matched a declared cosmetic pattern. Always false when
   * `lines` is null: we cannot claim a file is comments-only without looking.
   */
  readonly cosmetic: boolean;
}

/**
 * Excluded by default.
 *
 * `.claude/worktrees/**` is MANDATORY here, not hygiene: this repo carries 18
 * registered worktrees, 11 of them nested under the repo root, and they are
 * hidden today only by `.git/info/exclude` — which is machine-local and will
 * not exist in a CI clone.
 *
 * NOTE what is deliberately NOT excluded: `.vibes/policy.lock.json`. Only the
 * scratch subtrees of `.vibes/` are dropped. Excluding all of `.vibes/**` would
 * make the committed policy lock — the one file that can prove a manifest was
 * narrowed — invisible to change detection.
 */
export const DEFAULT_EXCLUDE_PATHSPECS: readonly string[] = [
  ':(exclude,top,glob).vibes/received/**',
  ':(exclude,top,glob).vibes/report/**',
  ':(exclude,top,glob).vibes/logs/**',
  ':(exclude,top,glob).vibes/shards/**',
  ':(exclude,top,glob).claude/worktrees/**',
  ':(exclude,top,glob)**/node_modules/**',
];

export interface CategorizeChangedOptions {
  readonly base: string;
  /** Producer baseline dirs. Snapshots are stream A output, never source. */
  readonly excludeDirs?: readonly RepoPath[];
  readonly excludePathspecs?: readonly string[];
  /** Restrict to these pathspecs (in addition to the excludes). */
  readonly pathspecs?: readonly string[];
  /** Default true. Untracked files are invisible to `git diff` — see indexOverlay. */
  readonly includeUntracked?: boolean;
  /** Compute per-file added/removed lines. Needed for cosmetic classification. */
  readonly lineDetail?: boolean;
  /** Beyond this many files, line detail is skipped and a warning is emitted. */
  readonly maxLineDetailFiles?: number;
  readonly cosmeticPatterns?: readonly RegExp[];
  readonly findRenames?: string | false;
}

export interface CategorizeChangedResult {
  readonly paths: readonly ChangedSourcePath[];
  /** Gitlink rows, also present in `paths` with `kind: 'gitlink'`. */
  readonly gitlinks: readonly ChangedSourcePath[];
  readonly unmerged: readonly RepoPath[];
  readonly warnings: readonly string[];
}

export async function categorizeChangedPaths(
  repo: GitRepo,
  opts: CategorizeChangedOptions,
): Promise<CategorizeChangedResult> {
  const warnings: string[] = [];
  const excludes = [
    ...(opts.excludePathspecs ?? DEFAULT_EXCLUDE_PATHSPECS),
    ...(opts.excludeDirs ?? []).map(
      (d) => `:(exclude,top,literal)${d.replace(/\/+$/, '')}`,
    ),
  ];
  const pathspecs = [...(opts.pathspecs ?? []), ...excludes];

  const raw = await repo.diffRaw(opts.base, {
    pathspecs,
    ...(opts.findRenames !== undefined ? { findRenames: opts.findRenames } : {}),
  });
  if (raw.unknown.length > 0) {
    warnings.push(
      `git reported ${String(raw.unknown.length)} path(s) with unknown status; they are excluded`,
    );
  }

  // A mode flip against the WORKTREE cannot be recognised from the raw record
  // alone: the destination oid is all-zeros because the file has not been
  // hashed into any index, so "same oid, different mode" never fires. Ask
  // numstat for the candidates — 0 added / 0 removed means only the bit moved.
  const modeCandidates = raw.entries
    .filter(
      (e) =>
        e.status === 'M' &&
        e.srcMode !== e.dstMode &&
        e.srcMode !== GITLINK_MODE &&
        e.dstMode !== GITLINK_MODE,
    )
    .map((e) => e.path);
  const contentUnchanged = await pathsWithNoLineChanges(repo, opts.base, modeCandidates);

  const out: ChangedSourcePath[] = [];
  for (const e of raw.entries) {
    out.push(fromRawEntry(e, contentUnchanged.has(e.path)));
  }

  if (opts.includeUntracked !== false) {
    const seen = new Set(out.map((p) => p.path));
    for (const p of await repo.listUntracked(pathspecs)) {
      if (seen.has(p)) continue;
      out.push({
        path: p,
        oldPath: null,
        status: 'added',
        kind: classifyKind(p, false),
        similarity: null,
        isUntracked: true,
        isBinary: null,
        submodule: null,
        lines: null,
        cosmetic: false,
      });
    }
  }

  out.sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')),
  );

  let final: ChangedSourcePath[] = out;
  if (opts.lineDetail === true) {
    const cap = opts.maxLineDetailFiles ?? 200;
    const eligible = out.filter((p) => p.kind !== 'gitlink' && p.status !== 'deleted');
    if (eligible.length > cap) {
      warnings.push(
        `line detail skipped: ${String(eligible.length)} changed files exceeds the cap of ${String(cap)}; ` +
          `cosmetic classification is unavailable for this run`,
      );
    } else {
      const patterns = opts.cosmeticPatterns ?? [];
      final = [];
      for (const p of out) {
        if (p.kind === 'gitlink' || p.status === 'deleted') {
          final.push(p);
          continue;
        }
        const lines = await changedLinesFor(repo, opts.base, p.path, {
          untracked: p.isUntracked,
        });
        final.push({
          ...p,
          lines,
          isBinary: lines.binary,
          cosmetic: isCosmetic(lines, patterns),
        });
      }
    }
  }

  return {
    paths: final,
    gitlinks: final.filter((p) => p.kind === 'gitlink'),
    unmerged: raw.unmerged,
    warnings,
  };
}

/** Paths whose content is byte-identical to the base, per `--numstat` 0/0. */
async function pathsWithNoLineChanges(
  repo: GitRepo,
  base: string,
  paths: readonly RepoPath[],
): Promise<Set<RepoPath>> {
  const out = new Set<RepoPath>();
  if (paths.length === 0) return out;
  const r = await repo.exec([
    'diff',
    '--numstat',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
    base,
    '--',
    ...paths.map((p) => `:(top,literal)${p}`),
  ]);
  // Framing (verified): `<added> TAB <deleted> TAB <path>` NUL.
  for (const rec of splitZ(r.stdout)) {
    const parts = rec.split('\t');
    if (parts.length < 3) continue;
    if (parts[0] === '0' && parts[1] === '0') out.add(parts.slice(2).join('\t'));
  }
  return out;
}

function fromRawEntry(e: RawDiffEntry, contentUnchanged: boolean): ChangedSourcePath {
  const isGitlink = e.srcMode === GITLINK_MODE || e.dstMode === GITLINK_MODE;
  let status: ChangeStatus;
  switch (e.status) {
    case 'A':
      status = 'added';
      break;
    case 'D':
      status = 'deleted';
      break;
    case 'R':
      status = 'renamed';
      break;
    case 'C':
      status = 'copied';
      break;
    case 'T':
      status = 'typechange';
      break;
    default:
      // A permission flip carries status M. Calling that "modified" sends a
      // reviewer looking for content that did not change.
      status =
        e.srcMode !== e.dstMode && (e.srcOid === e.dstOid || contentUnchanged)
          ? 'mode-only'
          : 'modified';
      break;
  }
  return {
    path: e.path,
    oldPath: e.from ?? null,
    status,
    kind: classifyKind(e.path, isGitlink),
    similarity: e.score,
    isUntracked: false,
    isBinary: null,
    submodule: e.submodule ?? null,
    lines: null,
    cosmetic: false,
  };
}

/** Written by `vibes accept`, never by a producer. */
const ACCEPT_GITATTRIBUTES = '.gitattributes';
const ACCEPT_RECEIPT_RE = /^\.vibes-accept(?:-\d+)?\.json$/;

const MANIFEST_RE = /(^|\/)vibes\/vibes\.manifest\.[cm]?js$/;
const RECEIPT_RE = /(^|\/)\.vibes-accept\.json$/;

/** Governance files get their own kind. Editing them is not a source change. */
export function classifyKind(path: RepoPath, isGitlink: boolean): ChangedPathKind {
  if (isGitlink) return 'gitlink';
  if (path === 'vibes.config.mjs' || path === 'vibes.config.js') return 'vibes-config';
  if (path === '.vibes/policy.lock.json') return 'vibes-lock';
  if (path === 'vibes.ignore') return 'vibes-ignore';
  if (RECEIPT_RE.test(path)) return 'vibes-receipt';
  if (MANIFEST_RE.test(path)) return 'vibes-manifest';
  return 'file';
}

/* ═══════════════════════════ B. snapshot files ════════════════════════════ */

/** The runner's inventory of what a producer actually wrote. */
export interface ReceivedFile {
  /** Path relative to the producer's received dir, POSIX. */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

export type SnapStatus =
  | 'unchanged'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'not-selected';

export interface SnapshotEntry {
  /** Path relative to the producer's out dir. */
  readonly file: string;
  readonly status: SnapStatus;
  readonly baselineOid: Sha | null;
  readonly baselineMode: string | null;
  readonly baselineSha256: string | null;
  readonly receivedSha256: string | null;
  readonly bytes: number | null;
  readonly renamedFrom: string | null;
  readonly similarity: number | null;
  /** `.gitattributes` would rewrite these bytes on the way in or out of git. */
  readonly gitNormalized: boolean;
  /** Written, but matched by a `.gitignore` pattern — git will never show it. */
  readonly ignored: boolean;
  readonly ignoreRule: string | null;
}

export interface CategorizeSnapshotsOptions {
  readonly base: string;
  /** Repo-relative committed baseline dir for this producer. */
  readonly baselineDir: RepoPath;
  readonly received: readonly ReceivedFile[];
  /**
   * Out-dir-relative files this run DECLARED it would produce. Baseline files
   * outside it are `not-selected`, never `deleted`.
   *
   * Mapping selection ids to files is the manifest's job, not git's: CI runs an
   * 18-of-32 smoke subset, and without a declared selection every run reports
   * 14 deletions and permanently disarms the corpus-shrank check.
   */
  readonly selectedFiles?: readonly string[] | null;
  /** Default true. This is the check that catches `*.log` reaching into a snapshot dir. */
  readonly checkIgnored?: boolean;
  /** Default true. */
  readonly checkAttributes?: boolean;
}

export interface SnapshotCategorization {
  readonly entries: readonly SnapshotEntry[];
  readonly baselineCount: number;
  readonly receivedCount: number;
  /**
   * Same-basename add/delete pairs whose CONTENT differs. Not renames — a hint
   * for the report, so a moved-and-edited corpus entry is not read as one
   * deletion plus one unrelated addition.
   */
  readonly possibleMoves: readonly { readonly from: string; readonly to: string }[];
  readonly warnings: readonly string[];
}

export async function categorizeSnapshots(
  repo: GitRepo,
  opts: CategorizeSnapshotsOptions,
): Promise<SnapshotCategorization> {
  const warnings: string[] = [];
  const dir = opts.baselineDir.replace(/\/+$/, '');
  const prefix = `${dir}/`;

  /* baseline roster from the tree at <base> — never a filesystem walk */
  const treeEntries = await repo.lsTreeEntries(opts.base, dir);
  const baseline = new Map<string, { oid: Sha; mode: string }>();
  for (const e of treeEntries) {
    if (e.mode === GITLINK_MODE) {
      warnings.push(
        `${e.path} is a gitlink inside a baseline directory; its content is invisible to the superproject`,
      );
      continue;
    }
    if (!e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    // `vibes accept` writes a receipt and a `.gitattributes` beside the
    // baselines. A producer never emits either, so comparing the baseline
    // roster against received output reports both as `deleted` on every run —
    // two false rows at the top of every report, exactly where the real
    // behaviour diff belongs.
    //
    // Only these two. `_vibes-census.json` IS producer output and must stay
    // compared, or a shrinking corpus becomes invisible.
    if (!rel.includes('/') && (rel === ACCEPT_GITATTRIBUTES || ACCEPT_RECEIPT_RE.test(rel))) continue;
    baseline.set(rel, { oid: e.oid, mode: e.mode });
  }

  /* baseline content hashes, batched by oid — no path quoting, one process */
  const blobs = await repo.readBlobsByOid([...baseline.values()].map((v) => v.oid));
  const baselineSha = new Map<string, string>();
  for (const [file, meta] of baseline) {
    const buf = blobs.get(meta.oid);
    if (buf === undefined || buf === null) {
      warnings.push(`baseline blob ${meta.oid.slice(0, 12)} for ${file} is unreadable`);
      continue;
    }
    baselineSha.set(file, sha256(buf));
  }

  const received = new Map<string, ReceivedFile>();
  for (const f of opts.received) received.set(normRel(f.file), f);

  const selected =
    opts.selectedFiles === undefined || opts.selectedFiles === null
      ? null
      : new Set(opts.selectedFiles.map(normRel));

  /* ignore + attribute probes, batched over the paths as they WOULD land in
   * the committed baseline dir. A directory-level probe cannot see this: the
   * directory is clean while `run.log` inside it is ignored repo-wide. */
  const ignoreByFile = new Map<string, { ignored: boolean; rule: string | null }>();
  if (opts.checkIgnored !== false && received.size > 0) {
    const paths = [...received.keys()].map((f) => `${prefix}${f}`);
    for (const check of await repo.checkIgnore(paths)) {
      ignoreByFile.set(check.path.slice(prefix.length), {
        ignored: check.ignored,
        rule: check.rule,
      });
    }
  }
  const normalizedFiles =
    opts.checkAttributes !== false && received.size > 0
      ? await gitNormalizedPaths(
          repo,
          [...received.keys()].map((f) => `${prefix}${f}`),
        )
      : new Set<string>();

  const entries: SnapshotEntry[] = [];
  const added: SnapshotEntry[] = [];
  const deleted: SnapshotEntry[] = [];

  const allFiles = new Set<string>([...baseline.keys(), ...received.keys()]);
  for (const file of [...allFiles].sort(byteCompare)) {
    const b = baseline.get(file);
    const r = received.get(file);
    const bSha = baselineSha.get(file) ?? null;
    const ign = ignoreByFile.get(file);
    const common = {
      file,
      baselineOid: b?.oid ?? null,
      baselineMode: b?.mode ?? null,
      baselineSha256: bSha,
      receivedSha256: r?.sha256 ?? null,
      bytes: r?.bytes ?? null,
      renamedFrom: null,
      similarity: null,
      gitNormalized: normalizedFiles.has(`${prefix}${file}`),
      ignored: ign?.ignored ?? false,
      ignoreRule: ign?.rule ?? null,
    };

    if (b !== undefined && r !== undefined) {
      entries.push({
        ...common,
        status: bSha !== null && bSha === r.sha256 ? 'unchanged' : 'modified',
      });
    } else if (b !== undefined) {
      // A baseline file this run never claimed to produce is NOT a deletion.
      const status: SnapStatus =
        selected !== null && !selected.has(file) ? 'not-selected' : 'deleted';
      const e = { ...common, status };
      entries.push(e);
      if (status === 'deleted') deleted.push(e);
    } else {
      const e: SnapshotEntry = { ...common, status: 'added' };
      entries.push(e);
      added.push(e);
    }
  }

  /* rename post-pass: identical content on both sides of an add/delete pair.
   * git's own -M cannot see this, because the received side is not in any
   * tree — and content-hash matching has no diff.renameLimit to exceed. */
  const possibleMoves: { from: string; to: string }[] = [];
  const byShaDeleted = new Map<string, string[]>();
  for (const d of deleted) {
    if (d.baselineSha256 === null) continue;
    const list = byShaDeleted.get(d.baselineSha256) ?? [];
    list.push(d.file);
    byShaDeleted.set(d.baselineSha256, list);
  }
  const consumed = new Set<string>();
  const renamedTo = new Map<string, string>();
  for (const a of added) {
    if (a.receivedSha256 === null) continue;
    const candidates = byShaDeleted.get(a.receivedSha256);
    if (candidates === undefined) continue;
    const from = candidates.find((c) => !consumed.has(c));
    if (from === undefined) continue;
    consumed.add(from);
    renamedTo.set(a.file, from);
  }
  const hinted = new Set<string>();
  for (const a of added) {
    if (renamedTo.has(a.file)) continue;
    const base = basename(a.file);
    const match = deleted.find(
      (d) => !consumed.has(d.file) && !hinted.has(d.file) && basename(d.file) === base,
    );
    // One-to-one: a single deletion must not seed a hint for several additions,
    // or a corpus reorganisation renders as a pile of contradictory guesses.
    if (match !== undefined) {
      hinted.add(match.file);
      possibleMoves.push({ from: match.file, to: a.file });
    }
  }

  const finalEntries = entries
    .filter((e) => !(e.status === 'deleted' && consumed.has(e.file)))
    .map((e) => {
      const from = renamedTo.get(e.file);
      if (e.status !== 'added' || from === undefined) return e;
      return { ...e, status: 'renamed' as const, renamedFrom: from, similarity: 100 };
    });

  return {
    entries: finalEntries,
    baselineCount: baseline.size,
    receivedCount: received.size,
    possibleMoves,
    warnings,
  };
}

/* ─────────────────────────────── helpers ─────────────────────────────────── */

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function normRel(p: string): string {
  let s = p.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Paths whose committed bytes would differ from their on-disk bytes.
 *
 * Vibes compares DISK bytes to BLOB bytes; where a `.gitattributes` eol or
 * filter setting makes those diverge, the difference is git's, not the
 * producer's, and the report has to say so instead of blaming the change.
 */
export async function gitNormalizedPaths(
  repo: GitRepo,
  paths: readonly RepoPath[],
): Promise<Set<RepoPath>> {
  if (paths.length === 0) return new Set();
  const attrs = ['text', 'eol', 'filter'];
  const r = await repo.exec(['check-attr', '-z', '--stdin', ...attrs], {
    input: `${paths.join('\0')}\0`,
    allowCodes: [0, 1],
    strictFatal: false,
  });
  // Framing (verified): <path> NUL <attr> NUL <value> NUL, path-major.
  const fields = splitZ(r.stdout);
  const out = new Set<RepoPath>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i] as string;
    const value = fields[i + 2] as string;
    if (value !== 'unspecified' && value !== 'unset') out.add(path);
  }
  return out;
}
