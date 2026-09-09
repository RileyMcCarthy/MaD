import { afterEach, describe, expect, test } from 'vitest';

import { makeFixture, type Fixture } from './fixtures.test.js';
import { openRepo } from './repo.js';
import { categorizeChangedPaths } from './categorize.js';
import {
  describeGitlink,
  enrichGitlink,
  enrichGitlinks,
  notMeasuredSentence,
} from './submodule.js';
import { NULL_OID } from './rawParse.js';

const live: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

/** Outer repo with `vendor/inner` pinned, then bumped by `commits` commits. */
async function withPinBump(commits: number): Promise<{
  outer: Fixture;
  base: string;
  oldPin: string;
  newPin: string;
}> {
  const inner = await fixture();
  await inner.write('lib.rs', 'fn a() {}\n');
  await inner.commit('inner 1');

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
  const base = await outer.commit('pin inner');
  const oldPin = (await outer.git('rev-parse', 'HEAD:vendor/inner')).trim();

  for (let i = 0; i < commits; i++) {
    await inner.write(`f${String(i)}.rs`, `fn f${String(i)}() {}\n`);
    await inner.commit(`inner change ${String(i)}`);
  }
  await outer.git('-C', 'vendor/inner', 'fetch', '-q', 'origin');
  await outer.git('-C', 'vendor/inner', 'checkout', '-q', await inner.head());
  await outer.commit('bump pin');
  const newPin = (await outer.git('rev-parse', 'HEAD:vendor/inner')).trim();

  return { outer, base, oldPin, newPin };
}

describe('gitlink rows', () => {
  test('a pin bump appears as a changed path with kind gitlink', async () => {
    const { outer, base, oldPin, newPin } = await withPinBump(2);
    const repo = await openRepo({ cwd: outer.dir });
    const r = await categorizeChangedPaths(repo, { base });
    expect(r.gitlinks).toHaveLength(1);
    expect(r.gitlinks[0]).toMatchObject({
      path: 'vendor/inner',
      kind: 'gitlink',
      submodule: { base: oldPin, head: newPin },
    });
  });

  test('enrichment reads the SUBMODULE\'s own history', async () => {
    const { outer, base, oldPin, newPin } = await withPinBump(3);
    const repo = await openRepo({ cwd: outer.dir });
    const g = await enrichGitlink(repo, {
      path: 'vendor/inner',
      base: oldPin,
      head: newPin,
    });
    expect(g.enriched).toBe(true);
    expect(g.direction).toBe('forward');
    expect(g.commitCount).toBe(3);
    expect(g.filesChanged).toBe(3);
    expect(g.subjects).toContain('inner change 2');
    // The sentence is mandatory: a commit count must never read as coverage.
    expect(g.note).toBe(notMeasuredSentence('vendor/inner'));
    expect(describeGitlink(g)).toMatch(/3 commits, 3 files changed upstream/);
  });

  test('a pin moved BACKWARD is named, not reported as zero commits', async () => {
    const { outer, base, oldPin, newPin } = await withPinBump(2);
    const repo = await openRepo({ cwd: outer.dir });
    const g = await enrichGitlink(repo, {
      path: 'vendor/inner',
      base: newPin,
      head: oldPin,
    });
    expect(g.direction).toBe('backward');
    expect(g.commitCount).toBe(2);
    expect(describeGitlink(g)).toMatch(/PIN MOVED BACKWARD/);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
  });

  test('an uninitialised submodule degrades honestly instead of enriching', async () => {
    const { outer, oldPin, newPin } = await withPinBump(1);
    // Empty the working directory of the submodule, as a fresh clone would be.
    await outer.git('submodule', 'deinit', '-f', 'vendor/inner');

    const repo = await openRepo({ cwd: outer.dir });
    const g = await enrichGitlink(repo, {
      path: 'vendor/inner',
      base: oldPin,
      head: newPin,
    });
    expect(g.enriched).toBe(false);
    expect(g.reason).toMatch(/not initialised/);
    // ...and it must NOT have silently answered from the superproject.
    expect(g.commitCount).toBeNull();
    expect(g.note).toBe(notMeasuredSentence('vendor/inner'));
  });

  test('an added or removed gitlink is not enriched', async () => {
    const { outer, newPin } = await withPinBump(1);
    const repo = await openRepo({ cwd: outer.dir });
    const added = await enrichGitlink(repo, {
      path: 'vendor/inner',
      base: NULL_OID,
      head: newPin,
    });
    expect(added).toMatchObject({ added: true, enriched: false });
    expect(added.reason).toMatch(/added/);
  });

  test('enrichGitlinks picks the gitlink rows out of a raw diff', async () => {
    const { outer, base } = await withPinBump(1);
    await outer.write('README.md', 'changed\n');
    await outer.commit('touch readme');

    const repo = await openRepo({ cwd: outer.dir });
    const raw = await repo.diffRaw(base);
    const enriched = await enrichGitlinks(repo, raw.entries);
    expect(enriched.map((g) => g.path)).toEqual(['vendor/inner']);
  });
});
