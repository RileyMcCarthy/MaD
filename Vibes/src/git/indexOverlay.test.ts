import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { makeFixture, type Fixture } from './fixtures.test.js';
import { openRepo, EMPTY_TREE_SHA } from './repo.js';
import { diffRawWithUntracked, withIndexOverlay } from './indexOverlay.js';
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

describe('index overlay', () => {
  test('makes an ADDED corpus case visible, which plain diff cannot', async () => {
    const f = await fixture();
    await f.write('snaps/a.txt', 'a\n');
    const base = await f.commit('init');
    await f.write('snaps/a.txt', 'a2\n');
    await f.write('snaps/new.txt', 'brand new\n');

    const repo = await openRepo({ cwd: f.dir });
    expect((await repo.diffRaw(base)).entries.map((e) => e.path)).toEqual([
      'snaps/a.txt',
    ]);

    const { value } = await diffRawWithUntracked(repo, base, { addPaths: ['snaps'] });
    expect(
      value.entries.map((e) => `${e.status} ${e.path}`).sort(),
    ).toEqual(['A snaps/new.txt', 'M snaps/a.txt']);
  });

  test('leaves the real .git/index byte-identical and the worktree untouched', async () => {
    // This is the whole reason the overlay is safe to run on a developer's
    // dirty tree while they have things staged.
    const f = await fixture();
    await f.write('snaps/a.txt', 'a\n');
    await f.write('staged.txt', 'v1\n');
    const base = await f.commit('init');
    await f.write('staged.txt', 'v2\n');
    await f.git('add', 'staged.txt');
    await f.write('snaps/new.txt', 'new\n');

    const indexPath = join(f.dir, '.git', 'index');
    const before = sha256(await readFile(indexPath));
    const statusBefore = await f.git('status', '--porcelain');

    const repo = await openRepo({ cwd: f.dir });
    await diffRawWithUntracked(repo, base, { addPaths: ['snaps'] });

    expect(sha256(await readFile(indexPath))).toBe(before);
    expect(await f.git('status', '--porcelain')).toBe(statusBefore);
  });

  test('the temp index file is removed even when the body throws', async () => {
    const f = await fixture();
    await f.write('snaps/a.txt', 'a\n');
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('vibes-index-'));
    await expect(
      withIndexOverlay(repo, { addPaths: ['snaps'] }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = (await readdir(tmpdir())).filter((n) => n.startsWith('vibes-index-'));
    expect(after).toEqual(before);
  });

  test('a pathspec matching nothing is reported, not swallowed', async () => {
    const f = await fixture();
    await f.write('snaps/a.txt', 'a\n');
    const base = await f.commit('init');
    await f.write('snaps/new.txt', 'new\n');

    const repo = await openRepo({ cwd: f.dir });
    const r = await diffRawWithUntracked(repo, base, {
      // The real dir plus a typo. The typo must not take the real one down
      // with it — a batched `add` would fail for both.
      addPaths: ['snaps', 'snapshots'],
    });
    expect(r.unmatchedPaths).toEqual(['snapshots']);
    expect(r.value.entries.map((e) => e.path)).toContain('snaps/new.txt');
  });

  test('an IGNORED produced file stays invisible even with the overlay', async () => {
    // The overlay fixes untracked-blindness. It does NOT fix ignore-blindness:
    // `add -N` skips ignored paths without a word. That is why the runner must
    // also run every produced path through checkIgnore.
    const f = await fixture();
    await f.write('.gitignore', '*.log\n');
    await f.write('snaps/a.txt', 'a\n');
    const base = await f.commit('init');
    await f.write('snaps/run.log', 'produced but invisible\n');

    const repo = await openRepo({ cwd: f.dir });
    const { value } = await diffRawWithUntracked(repo, base, { addPaths: ['snaps'] });
    expect(value.entries).toEqual([]);
    // ...and here is how it IS found.
    expect(await repo.listIgnoredFiles(['snaps'])).toEqual(['snaps/run.log']);
  });

  test('works against a base older than HEAD without hiding later additions', async () => {
    // Regression for seeding the throwaway index from the BASE instead of HEAD:
    // files added between base and HEAD would look untracked and vanish.
    const f = await fixture();
    await f.write('snaps/a.txt', 'a\n');
    const base = await f.commit('base');
    await f.write('snaps/b.txt', 'b\n');
    await f.commit('head');
    await f.write('snaps/c.txt', 'c\n');

    const repo = await openRepo({ cwd: f.dir });
    const { value } = await diffRawWithUntracked(repo, base, { addPaths: ['snaps'] });
    expect(value.entries.map((e) => `${e.status} ${e.path}`).sort()).toEqual([
      'A snaps/b.txt',
      'A snaps/c.txt',
    ]);
  });

  test('an unborn HEAD seeds from the empty tree instead of failing', async () => {
    const f = await fixture();
    await f.write('snaps/a.txt', 'a\n');
    const repo = await openRepo({ cwd: f.dir });
    const { value } = await diffRawWithUntracked(repo, EMPTY_TREE_SHA, {
      addPaths: ['snaps'],
    });
    expect(value.entries.map((e) => `${e.status} ${e.path}`)).toEqual([
      'A snaps/a.txt',
    ]);
  });
});
