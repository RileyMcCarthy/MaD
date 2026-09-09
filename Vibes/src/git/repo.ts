/**
 * `GitPort` over execFile + git plumbing.
 *
 * Every command here is byte-exact on purpose. A wrapper library would hide the
 * three behaviours this tool's correctness rests on:
 *   1. `git diff` is BLIND to untracked files — see indexOverlay.ts.
 *   2. `check-ignore -q` exit 0/1 is the only usable decision; the `-v` form
 *      exits 0 for a matched NEGATION too.
 *   3. `check-ignore` fatals (rc 128) inside a submodule — and in the `--stdin`
 *      batch form ONE such path aborts the whole batch and truncates stdout, so
 *      every other path in that call loses its answer too (verified, git 2.49).
 */

import { realpath, readFile } from 'node:fs/promises';

import type { GitPort, DiffEntry, RepoPath, Sha } from '../types.js';
import {
  createGitExec,
  splitZ,
  splitLines,
  sortPathsBytewise,
  GitError,
  type GitExec,
  type GitCommandRecord,
} from './exec.js';
import {
  parseRawDiffZ,
  parseLsTreeZ,
  parseCatFileBatch,
  parseStatusZ,
  type LsTreeEntry,
  type RawDiffParse,
  type StatusEntry,
} from './rawParse.js';

/** The well-known empty tree. Base for an unborn HEAD; every path reads added. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const SHA_RE = /^[0-9a-f]{40}$/;

/** Raised instead of letting git fatal with rc 128 on a submodule path. */
export class SubmodulePathError extends Error {
  readonly path: RepoPath;
  readonly submodule: RepoPath;
  constructor(path: RepoPath, submodule: RepoPath) {
    super(
      `${path} is inside submodule ${submodule}; git ignore/attr queries fatal there. ` +
        `Vibes is superproject-only: a gitlink is compared as a pin, not as content.`,
    );
    this.name = 'SubmodulePathError';
    this.path = path;
    this.submodule = submodule;
  }
}

/** A tree mid-merge-conflict cannot be measured, so we refuse rather than diff half of it. */
export class UnmergedIndexError extends Error {
  readonly paths: readonly RepoPath[];
  constructor(paths: readonly RepoPath[]) {
    super(
      `working tree has ${String(paths.length)} unmerged path(s); resolve the merge before running Vibes: ` +
        paths.slice(0, 5).join(', '),
    );
    this.name = 'UnmergedIndexError';
    this.paths = paths;
  }
}

export interface IgnoreCheck {
  readonly path: RepoPath;
  /** THE decision. Derived from the winning pattern, never from an exit code. */
  readonly ignored: boolean;
  /** `<source>:<line>:<pattern>` of the winning rule, or null when none matched. */
  readonly rule: string | null;
  readonly pattern: string | null;
  /** True when the winning pattern is a `!` re-inclusion. */
  readonly negated: boolean;
  /** True when the path lies inside a submodule; git was NOT asked. */
  readonly inSubmodule: boolean;
}

export interface DiffRawOptions {
  /** Second revision. Omitted = the working tree. */
  readonly to?: string;
  readonly pathspecs?: readonly string[];
  /** `-M<n>`; default `40%`, lower than git's 50% so a corpus rename is seen. */
  readonly findRenames?: string | false;
  /** Include `--find-copies-harder`. Off: it is O(files²) on a large tree. */
  readonly findCopies?: boolean;
}

export interface GitRepo extends GitPort {
  /** Realpath'd worktree root. */
  readonly repoRoot: string;
  /** `--absolute-git-dir`. For a linked worktree this is the per-worktree dir. */
  readonly gitDir: string;
  /**
   * `--git-common-dir`. Locks key on THIS, never on the worktree root: a linked
   * worktree returns its own toplevel, so a repo-local lock dir would hand each
   * of this repo's worktrees a private lease on one machine-global resource.
   */
  readonly gitCommonDir: string;
  readonly isLinkedWorktree: boolean;

  readonly exec: GitExec;

  headSha(): Promise<Sha | null>;
  /** True when HEAD points at a branch with no commits yet. */
  isUnborn(): Promise<boolean>;

  lsTreeEntries(rev: string, prefix?: RepoPath): Promise<readonly LsTreeEntry[]>;
  /** Untracked-not-ignored only, i.e. `ls-files --others --exclude-standard`. */
  listUntracked(pathspecs?: readonly string[]): Promise<readonly RepoPath[]>;
  /**
   * Untracked files that ARE ignored. This is the direct query for "what did a
   * producer write that git will never show anyone" — a repo-root `*.log`
   * pattern reaches into a snapshot directory and swallows `run.log` silently.
   */
  listIgnoredFiles(pathspecs?: readonly string[]): Promise<readonly RepoPath[]>;
  /** Batched blob read keyed by oid — no path quoting, no per-file process. */
  readBlobsByOid(oids: readonly Sha[]): Promise<Map<Sha, Buffer | null>>;

  diffRaw(base: string, opts?: DiffRawOptions): Promise<RawDiffParse>;
  /** `git diff --unified=<n>` text for one path. Empty when nothing differs. */
  diffUnified(
    base: string,
    path: RepoPath,
    opts?: { readonly unified?: number; readonly to?: string },
  ): Promise<string>;

  /**
   * Batch ignore check. One call, complete per-path answers, rules included.
   * Paths inside a submodule are answered `inSubmodule` and never sent to git.
   */
  checkIgnore(paths: readonly RepoPath[]): Promise<readonly IgnoreCheck[]>;
  /** Repo-relative paths of every submodule (`.gitmodules` ∪ index gitlinks). */
  submodulePaths(): Promise<readonly RepoPath[]>;
  /** The submodule containing `path`, or null. Strict descendants only — the
   *  gitlink path ITSELF is a superproject entry and answers null. */
  containingSubmodule(path: RepoPath): Promise<RepoPath | null>;

  status(): Promise<readonly StatusEntry[]>;
  /**
   * Paths with conflict stages in the index. NOTE: `git diff <base>` against
   * the WORKTREE reports a conflicted file as an ordinary `M`, so the raw diff
   * cannot see this — it has to be asked for separately, or a run measures a
   * half-merged tree and reports the conflict markers as behaviour.
   */
  unmergedPaths(): Promise<readonly RepoPath[]>;
  /** Commits recorded in `$GIT_DIR/shallow`, i.e. the graft boundary. */
  shallowBoundary(): Promise<ReadonlySet<Sha>>;
  /** Resolves `rev` inside a submodule's own repository. */
  revParseIn(dir: string, rev: string): Promise<Sha | null>;
  config(key: string): Promise<string | null>;
}

export interface OpenRepoOptions {
  readonly cwd?: string;
  readonly gitPath?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly recorder?: (record: GitCommandRecord) => void;
}

export async function openRepo(opts: OpenRepoOptions = {}): Promise<GitRepo> {
  const cwd = opts.cwd ?? process.cwd();
  const bootstrap = createGitExec({
    cwd,
    ...(opts.gitPath !== undefined ? { gitPath: opts.gitPath } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.recorder !== undefined ? { recorder: opts.recorder } : {}),
  });

  const top = (await bootstrap(['rev-parse', '--show-toplevel'])).stdout
    .toString('utf8')
    .trim();
  if (top === '') {
    throw new GitError('not inside a git worktree', {
      argv: ['rev-parse', '--show-toplevel'],
      code: 0,
      signal: null,
      stderr: '',
      cwd,
    });
  }
  // realpath matters: on macOS /tmp is a symlink to /private/tmp, so every
  // "is this path inside the repo" containment check would fail without it.
  const repoRoot = await realpath(top);

  const exec = createGitExec({
    cwd: repoRoot,
    ...(opts.gitPath !== undefined ? { gitPath: opts.gitPath } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.recorder !== undefined ? { recorder: opts.recorder } : {}),
  });

  const gitDir = (await exec(['rev-parse', '--absolute-git-dir'])).stdout
    .toString('utf8')
    .trim();
  const commonRaw = (await exec(['rev-parse', '--git-common-dir'])).stdout
    .toString('utf8')
    .trim();
  const gitCommonDir = commonRaw.startsWith('/')
    ? commonRaw
    : `${repoRoot}/${commonRaw}`;

  return makeRepo({ repoRoot, gitDir, gitCommonDir, exec });
}

function makeRepo(d: {
  repoRoot: string;
  gitDir: string;
  gitCommonDir: string;
  exec: GitExec;
}): GitRepo {
  const { repoRoot, gitDir, gitCommonDir, exec } = d;
  let submodulesCache: readonly RepoPath[] | null = null;

  const norm = (p: RepoPath): RepoPath => {
    let s = p.replace(/\\/g, '/');
    while (s.startsWith('./')) s = s.slice(2);
    if (s.endsWith('/') && s.length > 1) s = s.slice(0, -1);
    return s;
  };

  const submodulePaths = async (): Promise<readonly RepoPath[]> => {
    if (submodulesCache !== null) return submodulesCache;
    const found = new Set<RepoPath>();

    // .gitmodules is the declared list (R-M1: never hardcode).
    const cfg = await exec(
      ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
      { allowCodes: [0, 1, 128], strictFatal: false },
    );
    if (cfg.code === 0) {
      for (const line of splitLines(cfg.stdout)) {
        const sp = line.indexOf(' ');
        if (sp > 0) found.add(norm(line.slice(sp + 1)));
      }
    }
    // ...and the index is the actual list. A gitlink can exist with no
    // .gitmodules entry (a half-removed submodule), and check-ignore fatals on
    // it regardless of what the config file says.
    const staged = await exec(['ls-files', '-z', '--stage']);
    for (const rec of splitZ(staged.stdout)) {
      if (!rec.startsWith('160000 ')) continue;
      const tab = rec.indexOf('\t');
      if (tab > 0) found.add(norm(rec.slice(tab + 1)));
    }
    submodulesCache = sortPathsBytewise([...found]);
    return submodulesCache;
  };

  const containingSubmodule = async (path: RepoPath): Promise<RepoPath | null> => {
    const p = norm(path);
    for (const sub of await submodulePaths()) {
      // Strict descendant: the gitlink path itself is a superproject entry, and
      // `check-ignore` answers it happily (verified rc 1 on `SIL/embsim`).
      if (p.startsWith(`${sub}/`)) return sub;
    }
    return null;
  };

  const revParse = async (rev: string): Promise<Sha | null> => {
    const r = await exec(['rev-parse', '--verify', '--quiet', '--end-of-options', rev], {
      allowCodes: [0, 1, 128],
      strictFatal: false,
    });
    if (r.code !== 0) return null;
    const sha = r.stdout.toString('utf8').trim();
    return SHA_RE.test(sha) ? sha : null;
  };

  const lsTreeEntries = async (
    rev: string,
    prefix?: RepoPath,
  ): Promise<readonly LsTreeEntry[]> => {
    const args = ['ls-tree', '-r', '-z', rev];
    if (prefix !== undefined && prefix !== '') {
      // `:(top,literal)` is accepted by ls-tree (verified) and stops a path
      // containing `*` or `[` from being read as a wildcard. `:(glob)` is NOT
      // accepted here — that is the pathspec magic ls-tree rejects.
      args.push('--', `:(top,literal)${norm(prefix)}`);
    }
    const r = await exec(args, { allowCodes: [0, 128], strictFatal: false });
    if (r.code !== 0) return [];
    return parseLsTreeZ(r.stdout);
  };

  const readBlobsByOid = async (
    oids: readonly Sha[],
  ): Promise<Map<Sha, Buffer | null>> => {
    const out = new Map<Sha, Buffer | null>();
    const unique = [...new Set(oids)].filter((o) => SHA_RE.test(o));
    // Chunked so one enormous batch cannot blow the output cap; oids are fixed
    // width so the batching is purely about total content bytes.
    const CHUNK = 512;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const r = await exec(['cat-file', '--batch', '--buffer'], {
        input: `${slice.join('\n')}\n`,
      });
      for (const [oid, buf] of parseCatFileBatch(r.stdout)) out.set(oid, buf);
    }
    for (const oid of unique) if (!out.has(oid)) out.set(oid, null);
    return out;
  };

  const diffRaw = async (
    base: string,
    o: DiffRawOptions = {},
  ): Promise<RawDiffParse> => {
    const rename = o.findRenames ?? '40%';
    const args = [
      'diff',
      '--raw',
      '-z',
      // Full oids. The default abbreviation is ambiguity-prone and useless for
      // the gitlink rows, where the sha IS the payload.
      '--abbrev=40',
      '--no-textconv',
      '--no-ext-diff',
      // A pin bump is a real behaviour change with no in-repo content. The
      // default (`--ignore-submodules=untracked` via config, or `all` if a user
      // set it) would drop the row entirely.
      '--ignore-submodules=none',
      // Removes diff.renameLimit (default 1000), past which git silently stops
      // detecting renames — and a corpus rename would read as delete+add.
      '-l0',
    ];
    if (rename !== false) args.push(`-M${rename}`);
    if (o.findCopies === true) args.push('-C', '--find-copies-harder');
    args.push(base);
    if (o.to !== undefined) args.push(o.to);
    if (o.pathspecs !== undefined && o.pathspecs.length > 0) {
      args.push('--', ...o.pathspecs);
    }
    const r = await exec(args);
    return parseRawDiffZ(r.stdout);
  };

  const repo: GitRepo = {
    repoRoot,
    gitDir,
    gitCommonDir,
    isLinkedWorktree: gitDir !== gitCommonDir,
    exec,

    revParse,

    async mergeBase(a, b) {
      const r = await exec(['merge-base', a, b], {
        allowCodes: [0, 1, 128],
        strictFatal: false,
      });
      if (r.code !== 0) return null;
      const sha = r.stdout.toString('utf8').trim();
      return SHA_RE.test(sha) ? sha : null;
    },

    async headSha() {
      return revParse('HEAD^{commit}');
    },

    async isUnborn() {
      return (await revParse('HEAD^{commit}')) === null;
    },

    async listFiles(pathspecs) {
      const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
      if (pathspecs !== undefined && pathspecs.length > 0) args.push('--', ...pathspecs);
      const r = await exec(args);
      // `--cached --others` can list the same path twice mid-rename, and the
      // two sources are emitted in different orders. Dedupe and pin the order:
      // two runs on one tree must produce byte-identical reports.
      return sortPathsBytewise([...new Set(splitZ(r.stdout))]);
    },

    async listUntracked(pathspecs) {
      const args = ['ls-files', '-z', '--others', '--exclude-standard'];
      if (pathspecs !== undefined && pathspecs.length > 0) args.push('--', ...pathspecs);
      const r = await exec(args);
      return sortPathsBytewise([...new Set(splitZ(r.stdout))]);
    },

    async listIgnoredFiles(pathspecs) {
      const args = [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        // `--ignored` without `--exclude-standard` is a git usage error, and
        // with it the answer is exactly "written, and invisible".
        '--exclude-standard',
      ];
      if (pathspecs !== undefined && pathspecs.length > 0) args.push('--', ...pathspecs);
      const r = await exec(args);
      return sortPathsBytewise([...new Set(splitZ(r.stdout))]);
    },

    async lsTree(rev, prefix) {
      const entries = await lsTreeEntries(rev, prefix);
      return sortPathsBytewise(entries.map((e) => e.path));
    },

    lsTreeEntries,
    readBlobsByOid,

    async readBlob(rev, path) {
      const r = await exec(['cat-file', 'blob', `${rev}:${norm(path)}`], {
        allowCodes: [0, 1, 128],
        strictFatal: false,
      });
      return r.code === 0 ? r.stdout : null;
    },

    async diffNameStatus(base) {
      const parsed = await diffRaw(base);
      if (parsed.unmerged.length > 0) throw new UnmergedIndexError(parsed.unmerged);
      return parsed.entries as readonly DiffEntry[];
    },

    diffRaw,

    async diffUnified(base, path, o = {}) {
      const args = [
        'diff',
        `--unified=${String(o.unified ?? 0)}`,
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '-M',
        base,
      ];
      if (o.to !== undefined) args.push(o.to);
      args.push('--', `:(top,literal)${norm(path)}`);
      const r = await exec(args, { allowCodes: [0, 1], strictFatal: false });
      return r.stdout.toString('utf8');
    },

    async checkIgnore(paths) {
      const results: IgnoreCheck[] = [];
      const askable: RepoPath[] = [];
      for (const raw of paths) {
        const p = norm(raw);
        const sub = await containingSubmodule(p);
        if (sub !== null) {
          results.push({
            path: p,
            ignored: false,
            rule: null,
            pattern: null,
            negated: false,
            inSubmodule: true,
          });
        } else {
          askable.push(p);
        }
      }
      if (askable.length > 0) {
        // ONE call, and it answers for EVERY path:
        //  * `-v --non-matching` echoes non-matching paths too, so the field
        //    count proves every asked path was answered. Without it, only the
        //    IGNORED paths come back and a truncated stream is indistinguishable
        //    from "none of the rest were ignored".
        //  * `--no-index` is required: a force-added path otherwise reports
        //    "not ignored" while newly written siblings stay invisible, and it
        //    is also what stops the submodule fatal if the partition above ever
        //    misses one.
        //  * The DECISION is the winning pattern, never the exit status: a
        //    matched `!` negation exits 0 while meaning "not ignored".
        const r = await exec(
          ['check-ignore', '-v', '-z', '--non-matching', '--stdin', '--no-index'],
          {
            input: `${askable.join('\0')}\0`,
            allowCodes: [0, 1],
          },
        );
        const fields = splitZ(r.stdout);
        if (fields.length !== askable.length * 4) {
          throw new GitError(
            `check-ignore answered ${String(fields.length / 4)} of ${String(askable.length)} paths — ` +
              `its output was truncated and must not be trusted`,
            {
              argv: ['check-ignore'],
              code: r.code,
              signal: null,
              stderr: r.stderr,
              cwd: repoRoot,
            },
          );
        }
        for (let i = 0; i < askable.length; i++) {
          const source = fields[i * 4] as string;
          const line = fields[i * 4 + 1] as string;
          const pattern = fields[i * 4 + 2] as string;
          const echoed = fields[i * 4 + 3] as string;
          const want = askable[i] as string;
          if (echoed !== want) {
            throw new GitError(
              `check-ignore returned an answer for ${JSON.stringify(echoed)} where ` +
                `${JSON.stringify(want)} was asked`,
              {
                argv: ['check-ignore'],
                code: r.code,
                signal: null,
                stderr: r.stderr,
                cwd: repoRoot,
              },
            );
          }
          const matched = pattern !== '';
          const negated = pattern.startsWith('!');
          results.push({
            path: want,
            ignored: matched && !negated,
            rule: matched ? `${source}:${line}:${pattern}` : null,
            pattern: matched ? pattern : null,
            negated,
            inSubmodule: false,
          });
        }
      }
      const byPath = new Map(results.map((r) => [r.path, r]));
      return paths.map((p) => {
        const hit = byPath.get(norm(p));
        if (hit === undefined) throw new Error(`no ignore answer for ${p}`);
        return hit;
      });
    },

    async isIgnored(path) {
      const [only] = await repo.checkIgnore([path]);
      if (only === undefined) throw new Error(`no ignore answer for ${path}`);
      if (only.inSubmodule) {
        const sub = await containingSubmodule(path);
        throw new SubmodulePathError(path, sub ?? '(unknown)');
      }
      return only.ignored;
    },

    async isInSubmodule(path) {
      return (await containingSubmodule(path)) !== null;
    },

    submodulePaths,
    containingSubmodule,

    async isShallow() {
      const r = await exec(['rev-parse', '--is-shallow-repository']);
      return r.stdout.toString('utf8').trim() === 'true';
    },

    async shallowBoundary() {
      try {
        const text = await readFile(`${gitCommonDir}/shallow`, 'utf8');
        return new Set(splitLines(text).filter((l) => SHA_RE.test(l)));
      } catch {
        return new Set<Sha>();
      }
    },

    async status() {
      const r = await exec([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]);
      return parseStatusZ(r.stdout);
    },

    async unmergedPaths() {
      const r = await exec(['ls-files', '-u', '-z']);
      const paths = new Set<RepoPath>();
      for (const rec of splitZ(r.stdout)) {
        const tab = rec.indexOf('\t');
        if (tab > 0) paths.add(rec.slice(tab + 1));
      }
      return sortPathsBytewise([...paths]);
    },

    async revParseIn(dir, rev) {
      const r = await exec(
        ['-C', dir, 'rev-parse', '--verify', '--quiet', '--end-of-options', rev],
        { allowCodes: [0, 1, 128], strictFatal: false },
      );
      if (r.code !== 0) return null;
      const sha = r.stdout.toString('utf8').trim();
      return SHA_RE.test(sha) ? sha : null;
    },

    async config(key) {
      const r = await exec(['config', '--get', key], {
        allowCodes: [0, 1],
        strictFatal: false,
      });
      return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
    },
  };

  return repo;
}
