import { createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { makeFixture, type Fixture } from './fixtures.test.js';
import { openRepo } from './repo.js';
import {
  categorizeChangedPaths,
  categorizeSnapshots,
  classifyKind,
  type ReceivedFile,
} from './categorize.js';

const live: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const recv = (file: string, content: string): ReceivedFile => ({
  file,
  sha256: hash(content),
  bytes: Buffer.byteLength(content),
});

/* ══════════════════════════ changed source paths ══════════════════════════ */

describe('categorizeChangedPaths', () => {
  test('a rename is one row, not a delete plus an add', async () => {
    const f = await fixture();
    const body = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n');
    await f.write('src/old.ts', `${body}\n`);
    const base = await f.commit('init');
    await f.git('mv', 'src/old.ts', 'src/new.ts');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeChangedPaths(repo, { base });
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]).toMatchObject({
      status: 'renamed',
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      similarity: 100,
    });
  });

  test('untracked source files are included — plain diff cannot see them', async () => {
    const f = await fixture();
    await f.write('src/a.ts', 'a\n');
    const base = await f.commit('init');
    await f.write('src/brand-new.ts', 'new\n');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeChangedPaths(repo, { base });
    expect(r.paths).toEqual([
      expect.objectContaining({
        path: 'src/brand-new.ts',
        status: 'added',
        isUntracked: true,
      }),
    ]);
    const without = await categorizeChangedPaths(repo, { base, includeUntracked: false });
    expect(without.paths).toEqual([]);
  });

  test('baseline dirs and nested worktrees are excluded from source', async () => {
    const f = await fixture();
    await f.write('src/a.ts', 'a\n');
    await f.write('vibes/snapshots/domain/case.txt', 'x\n');
    await f.write('.claude/worktrees/stale/src/a.ts', 'stale\n');
    const base = await f.commit('init');
    await f.write('src/a.ts', 'a2\n');
    await f.write('vibes/snapshots/domain/case.txt', 'y\n');
    await f.write('.claude/worktrees/stale/src/a.ts', 'stale2\n');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeChangedPaths(repo, {
      base,
      excludeDirs: ['vibes/snapshots/domain'],
    });
    expect(r.paths.map((p) => p.path)).toEqual(['src/a.ts']);
  });

  test('governance files get their own kind, and the policy lock survives exclusion', async () => {
    const f = await fixture();
    await f.write('vibes.config.mjs', 'export default {}\n');
    await f.write('vibes.ignore', '\n');
    await f.write('.vibes/policy.lock.json', '{}\n');
    await f.write('Software/Control/vibes/vibes.manifest.mjs', 'export default {}\n');
    await f.write('Software/Control/vibes/snapshots/d/.vibes-accept.json', '{}\n');
    await f.write('.vibes/report/report.md', 'old\n');
    const base = await f.commit('init');
    await f.write('vibes.config.mjs', 'export default { version: 1 }\n');
    await f.write('vibes.ignore', 'x :: why :: until=2030-01-01\n');
    await f.write('.vibes/policy.lock.json', '{"v":1}\n');
    await f.write('Software/Control/vibes/vibes.manifest.mjs', 'export default { a: 1 }\n');
    await f.write('Software/Control/vibes/snapshots/d/.vibes-accept.json', '{"a":1}\n');
    await f.write('.vibes/report/report.md', 'new\n');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeChangedPaths(repo, { base });
    const kinds = Object.fromEntries(r.paths.map((p) => [p.path, p.kind]));
    expect(kinds).toEqual({
      'vibes.config.mjs': 'vibes-config',
      'vibes.ignore': 'vibes-ignore',
      // NOT excluded, deliberately: it is the one file that can prove a
      // manifest was narrowed.
      '.vibes/policy.lock.json': 'vibes-lock',
      'Software/Control/vibes/vibes.manifest.mjs': 'vibes-manifest',
      'Software/Control/vibes/snapshots/d/.vibes-accept.json': 'vibes-receipt',
    });
    // ...while the generated report under .vibes/ is excluded.
    expect(kinds['.vibes/report/report.md']).toBeUndefined();
  });

  test('a permission flip is mode-only, not modified', async () => {
    const f = await fixture();
    await f.write('run.sh', '#!/bin/sh\necho hi\n');
    const base = await f.commit('init');
    // The worktree mode is what `git diff <base>` reads, so chmod the file.
    await chmod(join(f.dir, 'run.sh'), 0o755);

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeChangedPaths(repo, { base });
    expect(r.paths[0]).toMatchObject({ path: 'run.sh', status: 'mode-only' });
  });

  test('line detail drives cosmetic classification, and refuses to guess', async () => {
    const f = await fixture();
    await f.write('src/a.ts', 'const x = 1;\n// old comment\n');
    await f.write('src/b.ts', 'const y = 1;\n');
    const base = await f.commit('init');
    await f.write('src/a.ts', 'const x = 1;\n// new comment\n');
    await f.write('src/b.ts', 'const y = 2;\n');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeChangedPaths(repo, {
      base,
      lineDetail: true,
      cosmeticPatterns: [/^\s*\/\//],
    });
    const byPath = Object.fromEntries(r.paths.map((p) => [p.path, p]));
    expect(byPath['src/a.ts']?.cosmetic).toBe(true);
    expect(byPath['src/b.ts']?.cosmetic).toBe(false);
    expect(byPath['src/a.ts']?.lines?.added).toEqual([
      { line: 2, text: '// new comment' },
    ]);
  });

  test('without line detail nothing is cosmetic and isBinary stays UNKNOWN', async () => {
    // null means "not determined", and it must never read as "text".
    const f = await fixture();
    await f.write('src/a.ts', '// x\n');
    const base = await f.commit('init');
    await f.write('src/a.ts', '// y\n');
    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeChangedPaths(repo, { base, cosmeticPatterns: [/.*/] });
    expect(r.paths[0]?.cosmetic).toBe(false);
    expect(r.paths[0]?.isBinary).toBeNull();
  });
});

describe('classifyKind', () => {
  test('recognises manifests at any depth and never mistakes a lookalike', () => {
    expect(classifyKind('a/b/vibes/vibes.manifest.mjs', false)).toBe('vibes-manifest');
    expect(classifyKind('vibes/vibes.manifest.js', false)).toBe('vibes-manifest');
    expect(classifyKind('src/vibes.manifest.mjs', false)).toBe('file');
    expect(classifyKind('docs/vibes.config.mjs', false)).toBe('file');
    expect(classifyKind('SIL/embsim', true)).toBe('gitlink');
  });
});

/* ═════════════════════════════ snapshot files ═════════════════════════════ */

describe('categorizeSnapshots', () => {
  const dir = 'vibes/snapshots/domain';

  test('classifies unchanged / modified / added / deleted', async () => {
    const f = await fixture();
    await f.write(`${dir}/same.txt`, 'same\n');
    await f.write(`${dir}/moved.txt`, 'old\n');
    await f.write(`${dir}/gone.txt`, 'gone\n');
    const base = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeSnapshots(repo, {
      base,
      baselineDir: dir,
      received: [
        recv('same.txt', 'same\n'),
        recv('moved.txt', 'new\n'),
        recv('fresh.txt', 'fresh\n'),
      ],
    });
    expect(Object.fromEntries(r.entries.map((e) => [e.file, e.status]))).toEqual({
      'same.txt': 'unchanged',
      'moved.txt': 'modified',
      'gone.txt': 'deleted',
      'fresh.txt': 'added',
    });
    expect(r.baselineCount).toBe(3);
    expect(r.receivedCount).toBe(3);
  });

  test('baseline files outside a declared selection are not-selected, NEVER deleted', async () => {
    // CI runs an 18-of-32 smoke subset. Without this the report shows 14
    // deletions on every run and the corpus-shrank check is permanently
    // disarmed by noise.
    const f = await fixture();
    await f.write(`${dir}/a.txt`, 'a\n');
    await f.write(`${dir}/b.txt`, 'b\n');
    await f.write(`${dir}/c.txt`, 'c\n');
    const base = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeSnapshots(repo, {
      base,
      baselineDir: dir,
      received: [recv('a.txt', 'a\n')],
      selectedFiles: ['a.txt', 'b.txt'],
    });
    const byFile = Object.fromEntries(r.entries.map((e) => [e.file, e.status]));
    expect(byFile['a.txt']).toBe('unchanged');
    // Selected, promised, and absent -> a real deletion.
    expect(byFile['b.txt']).toBe('deleted');
    // Never claimed by this run -> not a deletion.
    expect(byFile['c.txt']).toBe('not-selected');
  });

  test('a corpus entry moved with identical content is a rename, not delete+add', async () => {
    const f = await fixture();
    await f.write(`${dir}/gcode/old-name.gcode`, 'G1 X1\n');
    const base = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeSnapshots(repo, {
      base,
      baselineDir: dir,
      received: [recv('gcode/new-name.gcode', 'G1 X1\n')],
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      file: 'gcode/new-name.gcode',
      status: 'renamed',
      renamedFrom: 'gcode/old-name.gcode',
      similarity: 100,
    });
  });

  test('a moved-AND-edited entry stays add+delete but is flagged as a possible move', async () => {
    const f = await fixture();
    await f.write(`${dir}/a/case.txt`, 'v1\n');
    const base = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeSnapshots(repo, {
      base,
      baselineDir: dir,
      received: [recv('b/case.txt', 'v2\n')],
    });
    expect(r.entries.map((e) => e.status).sort()).toEqual(['added', 'deleted']);
    expect(r.possibleMoves).toEqual([{ from: 'a/case.txt', to: 'b/case.txt' }]);
  });

  test('a produced file swallowed by a .gitignore pattern is named', async () => {
    // Directory-level probes pass here: the snapshots dir is not ignored while
    // `run.log` inside it is, courtesy of a repo-root `*.log`.
    const f = await fixture();
    await f.write('.gitignore', '*.log\n');
    await f.write(`${dir}/keep.txt`, 'k\n');
    const base = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeSnapshots(repo, {
      base,
      baselineDir: dir,
      received: [recv('keep.txt', 'k\n'), recv('run.log', 'noise\n')],
    });
    const log = r.entries.find((e) => e.file === 'run.log');
    expect(log?.ignored).toBe(true);
    expect(log?.ignoreRule).toMatch(/\*\.log$/);
    expect(r.entries.find((e) => e.file === 'keep.txt')?.ignored).toBe(false);
  });

  test('an empty baseline is bootstrap, not 0 deletions', async () => {
    const f = await fixture();
    await f.write('README.md', 'x\n');
    const base = await f.commit('init');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeSnapshots(repo, {
      base,
      baselineDir: dir,
      received: [recv('a.txt', 'a\n'), recv('b.txt', 'b\n')],
    });
    expect(r.baselineCount).toBe(0);
    expect(r.entries.every((e) => e.status === 'added')).toBe(true);
  });

  test('baseline content is compared by hash of the BLOB, not by git status', async () => {
    // The received directory is gitignored scratch that git cannot see at all,
    // so this comparison can never come from `git diff`.
    const f = await fixture();
    await f.write(`${dir}/x.bin`, 'a\0b\n');
    const base = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const same = await categorizeSnapshots(repo, {
      base,
      baselineDir: dir,
      received: [recv('x.bin', 'a\0b\n')],
    });
    expect(same.entries[0]?.status).toBe('unchanged');
    expect(same.entries[0]?.baselineSha256).toBe(hash('a\0b\n'));
  });

  test('a nested baseline dir prefix does not leak sibling directories', async () => {
    const f = await fixture();
    await f.write(`${dir}/a.txt`, 'a\n');
    await f.write(`${dir}-other/b.txt`, 'b\n');
    const base = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const r = await categorizeSnapshots(repo, { base, baselineDir: dir, received: [] });
    expect(r.entries.map((e) => e.file)).toEqual(['a.txt']);
  });
});

describe("accept's own bookkeeping is not producer output", () => {
  // Regression: `vibes accept` writes a receipt and a `.gitattributes` beside
  // the baselines. Neither is ever emitted by a producer, so the baseline
  // roster reported both as `deleted` on every run — two false rows sitting
  // directly above the real behaviour diff.
  test('a committed receipt and .gitattributes are not reported as deleted', async () => {
    const f = await fixture();
    await f.write('snaps/a.txt', 'one\n');
    await f.write('snaps/.gitattributes', '* -merge -diff\n');
    await f.write('snaps/.vibes-accept.json', '{"receipts":[]}\n');
    await f.git('add', '-A');
    const base = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const cat = await categorizeSnapshots(repo, {
      base,
      baselineDir: 'snaps',
      received: [{ file: 'a.txt', sha256: await sha256File(f.dir, 'snaps/a.txt'), bytes: 4 }],
    });
    expect(cat.entries.filter((e) => e.status === 'deleted')).toEqual([]);
    expect(cat.entries.map((e) => e.file)).toEqual(['a.txt']);
  });

  test('_vibes-census.json IS producer output and stays compared', async () => {
    // The census is emitted by the producer. Excluding it would make a
    // shrinking corpus invisible, which is the opposite of the point.
    const f = await fixture();
    await f.write('snaps/_vibes-census.json', '{"cases":["a","b"]}\n');
    await f.git('add', '-A');
    const base = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const cat = await categorizeSnapshots(repo, { base, baselineDir: 'snaps', received: [] });
    expect(cat.entries.map((e) => `${e.file}:${e.status}`)).toEqual(['_vibes-census.json:deleted']);
  });
});

async function sha256File(dir: string, rel: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  return createHash('sha256').update(await readFile(join(dir, rel))).digest('hex');
}
