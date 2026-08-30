/**
 * What the producer actually wrote.
 *
 * The received dir is authoritative because the runner emptied it moments
 * earlier — that single fact is what lets this module walk a filesystem at all.
 * Everywhere else in Vibes the path universe comes from git, because a
 * filesystem walk surfaces files git deliberately hides.
 */

import { symlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { makeRunnerFixture, makeTempDir, type RunnerFixture } from './fixtures.test.js';
import { openRepo } from '../git/index.js';
import {
  baselineCaseCount,
  countCases,
  detectEol,
  findCaseCollisions,
  hasBom,
  inventoryDir,
  isReserved,
  readCensus,
  readSelection,
  type EmittedFile,
} from './inventory.js';

const live: { cleanup(): Promise<void> }[] = [];
async function temp(): Promise<string> {
  const t = await makeTempDir('vibes-inv-');
  live.push(t);
  return t.dir;
}
async function repoFixture(): Promise<RunnerFixture> {
  const f = await makeRunnerFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((t) => t.cleanup()));
});

const LIMITS = { maxFiles: 1000, maxFileBytes: 1024 * 1024 };

async function write(dir: string, rel: string, body: string | Buffer): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body);
}

describe('walking', () => {
  test('lists files bytewise, with sha256, size and POSIX keys', async () => {
    const dir = await temp();
    await write(dir, 'b.txt', 'bee\n');
    await write(dir, 'a.txt', 'ay\n');
    await write(dir, 'nested/deep/c.txt', 'see\n');

    const inv = await inventoryDir(dir, LIMITS);
    // Bytewise, never localeCompare: the report must be byte-identical between
    // two runs on the same tree, and locale collation is not stable across
    // machines or ICU versions.
    expect(inv.files.map((f) => f.file)).toEqual(['a.txt', 'b.txt', 'nested/deep/c.txt']);
    expect(inv.files[0]?.bytes).toBe(3);
    expect(inv.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inv.totalBytes).toBe(3 + 4 + 4);
  });

  test('a missing dir is an empty inventory, not a throw', async () => {
    const dir = await temp();
    const inv = await inventoryDir(join(dir, 'never-created'), LIMITS);
    expect(inv.files).toEqual([]);
    expect(inv.totalBytes).toBe(0);
  });

  test('records symlinks and does NOT follow them', async () => {
    const dir = await temp();
    const outside = await temp();
    await writeFile(join(outside, 'secret.txt'), 'not the producer output\n');
    await write(dir, 'real.txt', 'x\n');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));

    const inv = await inventoryDir(dir, LIMITS);
    // A link is a way to make the comparator read bytes the producer never
    // emitted — including bytes from outside the repo.
    expect(inv.symlinks).toEqual(['link.txt']);
    expect(inv.files.map((f) => f.file)).toEqual(['real.txt']);
  });

  test('stops at the file budget and says it truncated', async () => {
    const dir = await temp();
    for (let i = 0; i < 12; i += 1) await write(dir, `f${String(i).padStart(2, '0')}.txt`, 'x');
    const inv = await inventoryDir(dir, { maxFiles: 5, maxFileBytes: 1024 });
    expect(inv.truncated).toBe(true);
    expect(inv.files.length).toBe(5);
  });

  test('flags an oversize file rather than silently diffing it', async () => {
    const dir = await temp();
    await write(dir, 'big.bin', Buffer.alloc(4096, 1));
    await write(dir, 'small.txt', 'x');
    const inv = await inventoryDir(dir, { maxFiles: 100, maxFileBytes: 1024 });
    expect(inv.files.find((f) => f.file === 'big.bin')?.oversize).toBe(true);
    expect(inv.files.find((f) => f.file === 'small.txt')?.oversize).toBe(false);
  });
});

describe('file shape', () => {
  test("binary detection is git's own rule: a NUL in the first 8000 bytes", async () => {
    const dir = await temp();
    await write(dir, 'text.txt', 'plain\n');
    await write(dir, 'bin.dat', Buffer.from([0x41, 0x00, 0x42]));
    // A NUL past 8000 bytes is not binary by git's rule, and diverging from git
    // here would make Vibes disagree with the tool that stores the baseline.
    await write(dir, 'late.dat', Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]));

    const inv = await inventoryDir(dir, LIMITS);
    const by = new Map(inv.files.map((f) => [f.file, f]));
    expect(by.get('text.txt')?.isBinary).toBe(false);
    expect(by.get('bin.dat')?.isBinary).toBe(true);
    expect(by.get('late.dat')?.isBinary).toBe(false);
  });

  test('detects EOL style, BOM and a final newline', async () => {
    const dir = await temp();
    await write(dir, 'lf.txt', 'a\nb\n');
    await write(dir, 'crlf.txt', 'a\r\nb\r\n');
    await write(dir, 'mixed.txt', 'a\nb\r\n');
    await write(dir, 'none.txt', 'no newline at all');
    await write(dir, 'bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n')]));

    const inv = await inventoryDir(dir, LIMITS);
    const by = new Map(inv.files.map((f) => [f.file, f]));
    expect(by.get('lf.txt')?.eol).toBe('lf');
    expect(by.get('crlf.txt')?.eol).toBe('crlf');
    expect(by.get('mixed.txt')?.eol).toBe('mixed');
    expect(by.get('none.txt')?.eol).toBe('none');
    expect(by.get('none.txt')?.endsWithNewline).toBe(false);
    expect(by.get('bom.txt')?.hasBom).toBe(true);
    expect(by.get('lf.txt')?.hasBom).toBe(false);
  });

  test('the EOL and BOM helpers handle the empty file', () => {
    expect(detectEol(Buffer.alloc(0))).toBe('none');
    expect(hasBom(Buffer.alloc(0))).toBe(false);
    expect(hasBom(Buffer.from([0xef, 0xbb]))).toBe(false);
  });

  test('finds paths that differ only by case', async () => {
    // Harmless on ext4, fatal on APFS: one of them silently disappears when the
    // baseline is checked out, and `core.ignorecase=true` is set in this repo.
    expect(findCaseCollisions(['A.txt', 'a.txt', 'b.txt'])).toEqual([['A.txt', 'a.txt']]);
    expect(findCaseCollisions(['a/x.txt', 'A/x.txt'])).toEqual([['a/x.txt', 'A/x.txt']]);
    expect(findCaseCollisions(['a.txt', 'b.txt'])).toEqual([]);
  });
});

describe('census and selection', () => {
  test('reads a well-formed census', async () => {
    const dir = await temp();
    await write(dir, '_vibes-census.json', JSON.stringify({ producer: 'p', cases: ['a', 'b'] }));
    expect(await readCensus(dir)).toEqual({ present: true, cases: ['a', 'b'], error: null });
  });

  test('an absent census is absent, not an error', async () => {
    const dir = await temp();
    expect(await readCensus(dir)).toEqual({ present: false, cases: null, error: null });
  });

  test('a malformed census is present WITH an error, never silently empty', async () => {
    const dir = await temp();
    await write(dir, '_vibes-census.json', '{ nope');
    const bad = await readCensus(dir);
    expect(bad.present).toBe(true);
    expect(bad.cases).toBeNull();
    expect(bad.error).toContain('unparseable');

    await write(dir, '_vibes-census.json', JSON.stringify({ cases: [1, 2] }));
    expect((await readCensus(dir)).error).toContain('array of strings');

    await write(dir, '_vibes-census.json', JSON.stringify(['a']));
    expect((await readCensus(dir)).error).toContain('array of strings');
  });

  test('reads .vibes-selected, ignoring blanks and comments', async () => {
    // MaD's smoke lane emits 18 of a 32-entry catalog. Without this contract
    // every CI run would report 14 DELETIONS, and a permanent wall of false
    // deletions is exactly what disarms the real corpus-shrank signal.
    const dir = await temp();
    await write(dir, '.vibes-selected', '# smoke subset\ncase-a\n\n  case-b  \n# trailing\n');
    expect(await readSelection(dir)).toEqual(['case-a', 'case-b']);
    expect(await readSelection(await temp())).toBeNull();
  });

  test('bookkeeping files are not cases', async () => {
    const files: EmittedFile[] = ['_vibes-census.json', '_vibes-provenance.json', '.vibes-selected', 'a.txt', 'b.txt'].map(
      (file) => ({
        file,
        sha256: '',
        bytes: 0,
        isBinary: false,
        eol: 'lf' as const,
        hasBom: false,
        endsWithNewline: true,
        oversize: false,
      }),
    );
    expect(isReserved('_vibes-census.json')).toBe(true);
    expect(isReserved('nested/_vibes-census.json')).toBe(true);
    expect(isReserved('a.txt')).toBe(false);
    // Counting them would let a producer satisfy minCases by emitting nothing
    // but its own census.
    expect(countCases(files, null)).toBe(2);
    // A census, when present, is the authority on the case count.
    expect(countCases(files, { present: true, cases: ['x', 'y', 'z'], error: null })).toBe(3);
    expect(countCases(files, { present: true, cases: null, error: 'bad' })).toBe(2);
  });
});

describe('baselineCaseCount — the monotonic half of the corpus floor', () => {
  test('counts committed baseline files, excluding bookkeeping', async () => {
    const f = await repoFixture();
    await f.write('c/vibes/snapshots/p/a.txt', 'a\n');
    await f.write('c/vibes/snapshots/p/b.txt', 'b\n');
    await f.write('c/vibes/snapshots/p/_vibes-provenance.json', '{}');
    await f.commit('baseline');
    const repo = await openRepo({ cwd: f.dir });

    const r = await baselineCaseCount(repo, await repo.revParse('HEAD') ?? '', 'c/vibes/snapshots/p');
    expect(r).toEqual({ count: 2, fromCensus: false });
  });

  test('prefers the committed census when there is one', async () => {
    const f = await repoFixture();
    // The census is what makes a shrink comparable across a run that emits
    // several files per case.
    await f.write(
      'c/vibes/snapshots/p/_vibes-census.json',
      JSON.stringify({ producer: 'p', cases: ['one', 'two', 'three'] }),
    );
    await f.write('c/vibes/snapshots/p/one.json', '{}');
    await f.commit('baseline');
    const repo = await openRepo({ cwd: f.dir });

    const r = await baselineCaseCount(repo, await repo.revParse('HEAD') ?? '', 'c/vibes/snapshots/p');
    expect(r).toEqual({ count: 3, fromCensus: true });
  });

  test('an unparseable baseline census falls back to the file count', async () => {
    const f = await repoFixture();
    await f.write('c/vibes/snapshots/p/_vibes-census.json', 'not json');
    await f.write('c/vibes/snapshots/p/one.json', '{}');
    await f.write('c/vibes/snapshots/p/two.json', '{}');
    await f.commit('baseline');
    const repo = await openRepo({ cwd: f.dir });

    const r = await baselineCaseCount(repo, await repo.revParse('HEAD') ?? '', 'c/vibes/snapshots/p');
    expect(r).toEqual({ count: 2, fromCensus: false });
  });

  test('an absent baseline answers null — bootstrap is not a shrink', async () => {
    const f = await repoFixture();
    await f.write('README.md', 'x\n');
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const r = await baselineCaseCount(repo, await repo.revParse('HEAD') ?? '', 'c/vibes/snapshots/p');
    expect(r).toEqual({ count: null, fromCensus: false });
  });
});
