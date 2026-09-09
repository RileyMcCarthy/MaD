import { afterEach, describe, expect, test } from 'vitest';

import { makeFixture, type Fixture } from './fixtures.test.js';
import { openRepo } from './repo.js';
import { changedLinesFor, isCosmetic, parseUnifiedDiff } from './changedLines.js';

const live: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

describe('parseUnifiedDiff', () => {
  test('THE trap: a hunk header with an omitted count is still a hunk', () => {
    // `@@ -1,0 +2 @@` is what git emits when a side's length is 1. A regex that
    // requires the comma drops the hunk and a one-line change reads as none.
    const text = ['@@ -1,0 +2 @@ x', '+y'].join('\n');
    const r = parseUnifiedDiff(text);
    expect(r.hunks).toBe(1);
    expect(r.added).toEqual([{ line: 2, text: 'y' }]);
  });

  test('tracks line numbers across multiple hunks and both sides', () => {
    const text = [
      'diff --git a/x.ts b/x.ts',
      'index 111..222 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -3,2 +3,1 @@',
      '-old one',
      '-old two',
      '+new one',
      '@@ -20 +19,2 @@',
      '+tail a',
      '+tail b',
    ].join('\n');
    const r = parseUnifiedDiff(text);
    expect(r.hunks).toBe(2);
    expect(r.removed).toEqual([
      { line: 3, text: 'old one' },
      { line: 4, text: 'old two' },
    ]);
    expect(r.added).toEqual([
      { line: 3, text: 'new one' },
      { line: 19, text: 'tail a' },
      { line: 20, text: 'tail b' },
    ]);
  });

  test('a `+++`/`---` header inside the preamble is not counted as a line', () => {
    const text = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n');
    const r = parseUnifiedDiff(text);
    expect(r.added).toEqual([{ line: 1, text: 'b' }]);
    expect(r.removed).toEqual([{ line: 1, text: 'a' }]);
  });

  test('a binary diff reports binary, not "no lines changed"', () => {
    const text = [
      'diff --git a/b.dat b/b.dat',
      'index 111..222 100644',
      'Binary files a/b.dat and b/b.dat differ',
    ].join('\n');
    const r = parseUnifiedDiff(text);
    expect(r.binary).toBe(true);
    expect(r.added).toEqual([]);
  });

  test('the no-newline marker is not content', () => {
    const text = ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n');
    expect(parseUnifiedDiff(text).removed).toEqual([{ line: 1, text: 'a' }]);
  });

  test('a rename header is captured', () => {
    const text = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 95%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n');
    expect(parseUnifiedDiff(text).renamedFrom).toBe('old.ts');
  });

  test('truncation is reported rather than silently capping', () => {
    const lines = ['@@ -1,0 +1,5 @@', ...['a', 'b', 'c', 'd', 'e'].map((c) => `+${c}`)];
    const r = parseUnifiedDiff(lines.join('\n'), { maxLines: 2 });
    expect(r.added).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
});

describe('isCosmetic', () => {
  const comment = [/^\s*\/\//];

  test('true only when EVERY changed line matches', () => {
    expect(
      isCosmetic(
        parseUnifiedDiff('@@ -1 +1 @@\n-// a\n+// b'),
        comment,
      ),
    ).toBe(true);
    expect(
      isCosmetic(parseUnifiedDiff('@@ -1,2 +1,2 @@\n-// a\n-code()\n+// b\n+code2()'), comment),
    ).toBe(false);
  });

  test('never cosmetic when we did not see the lines', () => {
    const binary = parseUnifiedDiff('Binary files a/x and b/x differ');
    expect(isCosmetic(binary, [/.*/])).toBe(false);
    const truncated = parseUnifiedDiff('@@ -1,0 +1,2 @@\n+a\n+b', { maxLines: 1 });
    expect(isCosmetic(truncated, [/.*/])).toBe(false);
  });

  test('an empty change set is not vacuously cosmetic', () => {
    expect(isCosmetic(parseUnifiedDiff(''), [/.*/])).toBe(false);
  });

  test('no declared patterns means nothing is cosmetic', () => {
    expect(isCosmetic(parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b'), [])).toBe(false);
  });
});

describe('changedLinesFor', () => {
  test('reads a tracked file against the base', async () => {
    const f = await fixture();
    await f.write('x.ts', 'a\nb\n');
    const base = await f.commit('init');
    await f.write('x.ts', 'a\nB\n');
    const repo = await openRepo({ cwd: f.dir });
    const r = await changedLinesFor(repo, base, 'x.ts');
    expect(r.added).toEqual([{ line: 2, text: 'B' }]);
    expect(r.removed).toEqual([{ line: 2, text: 'b' }]);
  });

  test('an untracked file needs --no-index or it reports NOTHING', async () => {
    const f = await fixture();
    await f.write('x.ts', 'a\n');
    const base = await f.commit('init');
    await f.write('new.ts', 'one\ntwo\n');
    const repo = await openRepo({ cwd: f.dir });

    expect((await changedLinesFor(repo, base, 'new.ts')).added).toEqual([]);
    const r = await changedLinesFor(repo, base, 'new.ts', { untracked: true });
    expect(r.added).toEqual([
      { line: 1, text: 'one' },
      { line: 2, text: 'two' },
    ]);
  });

  test('a path containing glob characters is matched literally', async () => {
    const f = await fixture();
    await f.write('weird[1].ts', 'a\n');
    const base = await f.commit('init');
    await f.write('weird[1].ts', 'b\n');
    const repo = await openRepo({ cwd: f.dir });
    expect((await changedLinesFor(repo, base, 'weird[1].ts')).added).toEqual([
      { line: 1, text: 'b' },
    ]);
  });
});
