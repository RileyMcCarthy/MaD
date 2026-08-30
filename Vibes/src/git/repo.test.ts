import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { makeFixture, type Fixture } from './fixtures.test.js';
import { openRepo, SubmodulePathError } from './repo.js';
import { sha256 } from './categorize.js';

const live: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

describe('openRepo', () => {
  test('discovers a realpath-ed root from a subdirectory', async () => {
    const f = await fixture();
    await f.write('sub/deep/a.txt', 'x\n');
    await f.commit('init');
    const repo = await openRepo({ cwd: join(f.dir, 'sub', 'deep') });
    expect(repo.repoRoot).toBe(f.dir);
    // Locks key on the COMMON dir, not the worktree root: a linked worktree
    // returns its own toplevel and would get a private lease on a shared resource.
    expect(repo.gitCommonDir).toContain('.git');
    expect(repo.isLinkedWorktree).toBe(false);
  });

  test('an unborn HEAD reports null rather than throwing', async () => {
    const f = await fixture();
    const repo = await openRepo({ cwd: f.dir });
    expect(await repo.headSha()).toBeNull();
    expect(await repo.isUnborn()).toBe(true);
  });
});

describe('checkIgnore', () => {
  test('a bare extension pattern reaches INTO a snapshot directory', async () => {
    // The hazard, verified in the real repo: `snapshots/` is not ignored, so a
    // directory-level probe passes, while a repo-root `*.log` swallows a
    // produced `run.log` and git never shows it to anyone.
    const f = await fixture();
    await f.write('.gitignore', '*.log\n*.tmp\n');
    await f.write('vibes/snapshots/ok.txt', 'a\n');
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    expect(await repo.isIgnored('vibes/snapshots')).toBe(false);
    expect(await repo.isIgnored('vibes/snapshots/ok.txt')).toBe(false);
    expect(await repo.isIgnored('vibes/snapshots/run.log')).toBe(true);
    expect(await repo.isIgnored('vibes/snapshots/scratch.tmp')).toBe(true);
  });

  test('a negation is NOT ignored, though `-v` would exit 0 for it', async () => {
    const f = await fixture();
    // `.vibes/` + `!...` does not work (git never descends into an excluded
    // directory); `.vibes/*` + `!...` does. Both are pinned here.
    await f.write('.gitignore', '.vibes/*\n!.vibes/policy.lock.json\nblocked/\n!blocked/x\n');
    await f.write('a.txt', 'x\n');
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const [lock, other, blocked] = await repo.checkIgnore([
      '.vibes/policy.lock.json',
      '.vibes/other.json',
      'blocked/x',
    ]);
    expect(lock).toMatchObject({ ignored: false, negated: true });
    expect(lock?.rule).toMatch(/!\.vibes\/policy\.lock\.json$/);
    expect(other?.ignored).toBe(true);
    // A `!` under a directory-ignore cannot re-include: git never descends.
    expect(blocked).toMatchObject({ ignored: true, negated: false });
  });

  test('answers every path asked, in order, including non-matching ones', async () => {
    const f = await fixture();
    await f.write('.gitignore', '*.log\n');
    await f.write('a.txt', 'x\n');
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });
    const paths = ['a.txt', 'b.log', 'c.txt', 'd.log', 'e.txt'];
    const got = await repo.checkIgnore(paths);
    expect(got.map((g) => g.path)).toEqual(paths);
    expect(got.map((g) => g.ignored)).toEqual([false, true, false, true, false]);
  });

  test('a force-added ignored file is still reported ignored (--no-index)', async () => {
    // Without --no-index git answers "not ignored" for a tracked path, so a
    // once-force-added snapshot would mask that its new siblings are invisible.
    const f = await fixture();
    await f.write('.gitignore', '*.log\n');
    await f.write('snaps/run.log', 'x\n');
    await f.git('add', '-f', 'snaps/run.log');
    await f.commit('force-added');
    const repo = await openRepo({ cwd: f.dir });
    expect(await repo.isIgnored('snaps/run.log')).toBe(true);
  });

  test('empty input does not invoke git', async () => {
    const f = await fixture();
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });
    expect(await repo.checkIgnore([])).toEqual([]);
  });
});

describe('listIgnoredFiles', () => {
  test('names the produced files git will never show', async () => {
    const f = await fixture();
    await f.write('.gitignore', '*.log\n');
    await f.write('snaps/keep.txt', 'a\n');
    await f.commit('init');
    await f.write('snaps/run.log', 'noise\n');
    await f.write('snaps/new.txt', 'fresh\n');
    const repo = await openRepo({ cwd: f.dir });
    expect(await repo.listIgnoredFiles(['snaps'])).toEqual(['snaps/run.log']);
    expect(await repo.listUntracked(['snaps'])).toEqual(['snaps/new.txt']);
  });
});

describe('submodule guard', () => {
  test('paths inside a submodule are never sent to git, and the port says so', async () => {
    const inner = await fixture();
    await inner.write('lib.rs', 'fn main() {}\n');
    await inner.commit('inner');

    const outer = await fixture();
    await outer.write('README.md', 'x\n');
    await outer.commit('init');
    await outer.git(
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner.dir,
      'vendor/inner',
    );
    await outer.commit('add submodule');

    const repo = await openRepo({ cwd: outer.dir });
    expect(await repo.submodulePaths()).toEqual(['vendor/inner']);
    // The gitlink path ITSELF is a superproject entry; only strict descendants
    // are "inside". git answers happily for the gitlink and fatals below it.
    expect(await repo.isInSubmodule('vendor/inner')).toBe(false);
    expect(await repo.isInSubmodule('vendor/inner/lib.rs')).toBe(true);

    const [outside, insideEntry] = await repo.checkIgnore([
      'README.md',
      'vendor/inner/lib.rs',
    ]);
    expect(outside?.inSubmodule).toBe(false);
    expect(insideEntry?.inSubmodule).toBe(true);
    // ...and asking for a decision on it is an error, not a cheerful `false`.
    await expect(repo.isIgnored('vendor/inner/lib.rs')).rejects.toBeInstanceOf(
      SubmodulePathError,
    );
  });

  test('a gitlink with no .gitmodules entry is still detected', async () => {
    const inner = await fixture();
    await inner.write('lib.rs', 'x\n');
    await inner.commit('inner');

    const outer = await fixture();
    await outer.write('README.md', 'x\n');
    await outer.commit('init');
    await outer.git(
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner.dir,
      'vendor/inner',
    );
    await outer.commit('add submodule');
    // A half-removed submodule: config gone, gitlink still in the index.
    await outer.git('rm', '-f', '--cached', '.gitmodules');
    await outer.commit('drop .gitmodules');

    const repo = await openRepo({ cwd: outer.dir });
    expect(await repo.submodulePaths()).toEqual(['vendor/inner']);
  });
});

describe('path universe', () => {
  test('listFiles is tracked + untracked-not-ignored, deduped and byte-ordered', async () => {
    const f = await fixture();
    await f.write('.gitignore', 'ignored.txt\n');
    await f.write('b.txt', 'b\n');
    await f.write('a.txt', 'a\n');
    await f.commit('init');
    await f.write('c.txt', 'c\n');
    await f.write('ignored.txt', 'nope\n');
    const repo = await openRepo({ cwd: f.dir });
    expect(await repo.listFiles()).toEqual(['.gitignore', 'a.txt', 'b.txt', 'c.txt']);
  });

  test('lsTree reads a prefix at a rev, and a literal pathspec is not a glob', async () => {
    const f = await fixture();
    await f.write('snaps/a.txt', 'a\n');
    await f.write('snaps/nested/b.txt', 'b\n');
    await f.write('other.txt', 'o\n');
    const base = await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });
    expect(await repo.lsTree(base, 'snaps')).toEqual([
      'snaps/a.txt',
      'snaps/nested/b.txt',
    ]);
    // A directory that does not exist at that rev is empty, not an error: this
    // is the bootstrap case, a producer with no committed baseline yet.
    expect(await repo.lsTree(base, 'nope')).toEqual([]);
  });

  test('readBlob and readBlobsByOid return exact bytes, and null for absent', async () => {
    const f = await fixture();
    const body = 'line\né\n';
    await f.write('x.txt', body);
    const base = await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const direct = await repo.readBlob(base, 'x.txt');
    expect(direct?.toString('utf8')).toBe(body);
    expect(await repo.readBlob(base, 'missing.txt')).toBeNull();

    const entries = await repo.lsTreeEntries(base);
    const oids = entries.map((e) => e.oid);
    const blobs = await repo.readBlobsByOid([...oids, 'f'.repeat(40)]);
    expect(blobs.get(oids[0] as string)?.toString('utf8')).toBe(body);
    expect(blobs.get('f'.repeat(40))).toBeNull();
  });

  test('readBlobsByOid preserves binary content byte-for-byte', async () => {
    const f = await fixture();
    await f.write('bin.dat', 'a\0b\nc\0');
    const base = await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });
    const [entry] = await repo.lsTreeEntries(base, 'bin.dat');
    const blob = (await repo.readBlobsByOid([entry?.oid ?? ''])).get(entry?.oid ?? '');
    expect(blob).not.toBeNull();
    expect(sha256(blob as Buffer)).toBe(
      sha256(await readFile(join(f.dir, 'bin.dat'))),
    );
  });
});

describe('diffNameStatus', () => {
  test('detects a rename BEFORE per-file compare', async () => {
    // Fact 26: the real Software/MaDWasmControl -> Software/Control move
    // detects at R100/R099. Without rename detection ahead of compare it reads
    // as delete + add, and a moved corpus entry looks like a deletion.
    const f = await fixture();
    const body = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n');
    await f.write('old/dir/file.ts', `${body}\n`);
    await f.write('new/dir/.keep', '');
    const base = await f.commit('init');
    await f.git('mv', 'old/dir/file.ts', 'new/dir/file.ts');
    await f.commit('rename');

    const repo = await openRepo({ cwd: f.dir });
    const entries = await repo.diffNameStatus(base);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'R',
      from: 'old/dir/file.ts',
      path: 'new/dir/file.ts',
    });
  });

  test('IS BLIND to untracked files — the hazard the overlay exists for', async () => {
    const f = await fixture();
    await f.write('snaps/a.txt', 'a\n');
    const base = await f.commit('init');
    await f.write('snaps/new.txt', 'brand new corpus case\n');

    const repo = await openRepo({ cwd: f.dir });
    // Exit 0. Nothing reported. A newly ADDED corpus case is invisible.
    expect(await repo.diffNameStatus(base)).toEqual([]);
  });

  test('a conflicted tree reports M from the worktree diff — ask unmergedPaths', async () => {
    const f = await fixture();
    await f.write('x.txt', 'base\n');
    const base = await f.commit('base');
    await f.git('checkout', '-q', '-b', 'other');
    await f.write('x.txt', 'other\n');
    await f.commit('other');
    await f.git('checkout', '-q', 'main');
    await f.write('x.txt', 'main\n');
    await f.commit('main');
    await f.git('merge', 'other').catch(() => {
      /* expected conflict */
    });

    const repo = await openRepo({ cwd: f.dir });
    // The trap: the worktree diff calls a conflicted file an ordinary `M`, so
    // a run would happily measure a half-merged tree and report the conflict
    // markers as behaviour. The conflict has to be asked for separately.
    expect((await repo.diffNameStatus(base))[0]?.status).toBe('M');
    expect(await repo.unmergedPaths()).toEqual(['x.txt']);
  });
});

describe('isShallow', () => {
  test('a complete clone is not shallow', async () => {
    const f = await fixture();
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });
    expect(await repo.isShallow()).toBe(false);
    expect((await repo.shallowBoundary()).size).toBe(0);
  });
});
