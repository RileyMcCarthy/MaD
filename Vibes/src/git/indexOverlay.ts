/**
 * The index overlay.
 *
 * THE PROBLEM, verified: `git diff <base> -- <dir>` never lists untracked
 * files, and `git diff --exit-code` therefore exits 0 for a tree where a brand
 * new file has appeared. That fails in exactly the case that matters most —
 * someone ADDS a corpus case — and it fails silently, reporting "no change".
 *
 * THE FIX, verified byte-for-byte: build a THROWAWAY index from a commit, mark
 * the candidate paths intent-to-add in it, and diff with `GIT_INDEX_FILE`
 * pointed at that. `git status` and `.git/index` are byte-identical afterwards.
 *
 *   GIT_INDEX_FILE=$T git read-tree HEAD
 *   GIT_INDEX_FILE=$T git add -N -- <dir>
 *   GIT_INDEX_FILE=$T git diff --raw -z <base>     ->  A <dir>/new.txt
 *
 * WHY read-tree from HEAD and not from the base: the temp index supplies the
 * TRACKED SET, and the tracked set is HEAD's. Seeding it from an older base
 * would make every file added between base and HEAD look untracked, so they
 * would vanish from the diff unless separately re-added — a second bug hiding
 * the first. The base is supplied to `diff`, which is where it belongs.
 */

import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { RepoPath } from '../types.js';
import { GitError, type GitExec } from './exec.js';
import type { GitRepo } from './repo.js';
import { parseRawDiffZ, type RawDiffParse } from './rawParse.js';
import { EMPTY_TREE_SHA } from './repo.js';

export interface OverlayOptions {
  /**
   * Commit whose tree seeds the throwaway index. Default `HEAD`, or the empty
   * tree when HEAD is unborn.
   */
  readonly trackedSetFrom?: string;
  /** Paths (usually directories) whose untracked contents become visible. */
  readonly addPaths: readonly RepoPath[];
}

export interface OverlayResult<T> {
  readonly value: T;
  /**
   * `add -N` pathspecs that matched nothing. Benign for an empty produced
   * directory, and a real signal for a typo'd path — so it is reported, never
   * swallowed.
   */
  readonly unmatchedPaths: readonly RepoPath[];
}

/** Matches git's own wording; anything else from `add` is a genuine failure. */
const NO_MATCH_RE = /did not match any files/;

/**
 * Run `fn` with an exec bound to a throwaway index. The real `.git/index` is
 * never opened for write, so this is safe to run against a dirty worktree while
 * a developer has staged changes.
 */
export async function withIndexOverlay<T>(
  repo: GitRepo,
  opts: OverlayOptions,
  fn: (exec: GitExec) => Promise<T>,
): Promise<OverlayResult<T>> {
  const indexPath = join(
    tmpdir(),
    `vibes-index-${String(process.pid)}-${randomBytes(6).toString('hex')}`,
  );
  const exec: GitExec = (args, o = {}) =>
    repo.exec(args, { ...o, env: { ...o.env, GIT_INDEX_FILE: indexPath } });

  const seed =
    opts.trackedSetFrom ?? ((await repo.isUnborn()) ? EMPTY_TREE_SHA : 'HEAD');

  try {
    await exec(['read-tree', seed]);

    const unmatched: RepoPath[] = [];
    for (const p of opts.addPaths) {
      // One pathspec per call: a single non-matching path makes the whole
      // batched `add` fail, which would drop the untracked files under every
      // other path with it.
      const r = await exec(
        ['add', '--intent-to-add', '--', `:(top,literal)${p.replace(/\/+$/, '')}`],
        { allowCodes: [0, 1, 128], strictFatal: false },
      );
      if (r.code !== 0) {
        if (NO_MATCH_RE.test(r.stderr)) {
          unmatched.push(p);
          continue;
        }
        throw new GitError(`index overlay: add -N failed for ${p}\n${r.stderr.trim()}`, {
          argv: r.argv,
          code: r.code,
          signal: null,
          stderr: r.stderr,
          cwd: repo.repoRoot,
        });
      }
    }

    const value = await fn(exec);
    return { value, unmatchedPaths: unmatched };
  } finally {
    await unlink(indexPath).catch(() => {
      /* never existed, or already gone */
    });
  }
}

export interface OverlayDiffOptions extends OverlayOptions {
  readonly pathspecs?: readonly string[];
  readonly findRenames?: string | false;
}

/**
 * `git diff --raw` against `base` WITH untracked files under `addPaths`
 * appearing as `A` rows.
 *
 * NOTE what stays invisible even here: a produced file matched by a
 * `.gitignore` pattern is skipped by `add -N` without a word (verified — a
 * repo-root `*.log` reaches into a snapshot directory and swallows `run.log`).
 * That is why the runner must ALSO run every produced path through
 * `checkIgnore`; this function reports what git can see, which is not the same
 * as what the producer wrote.
 */
export async function diffRawWithUntracked(
  repo: GitRepo,
  base: string,
  opts: OverlayDiffOptions,
): Promise<OverlayResult<RawDiffParse>> {
  const rename = opts.findRenames ?? '40%';
  return withIndexOverlay(repo, opts, async (exec) => {
    const args = [
      'diff',
      '--raw',
      '-z',
      '--abbrev=40',
      '--no-textconv',
      '--no-ext-diff',
      '--ignore-submodules=none',
      '-l0',
    ];
    if (rename !== false) args.push(`-M${rename}`);
    args.push(base);
    if (opts.pathspecs !== undefined && opts.pathspecs.length > 0) {
      args.push('--', ...opts.pathspecs);
    }
    const r = await exec(args);
    return parseRawDiffZ(r.stdout);
  });
}
