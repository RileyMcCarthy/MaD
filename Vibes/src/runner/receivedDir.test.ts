/**
 * The only `rm -rf` in the tool.
 *
 * Every test here is a deletion that must NOT happen, plus the one that must.
 * A resolution bug in this file destroys a user's committed baselines, so the
 * guard is tested by asking it to delete things it should refuse.
 */

import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { makeTempDir } from './fixtures.test.js';
import {
  assertSafeReceivedDir,
  prepareReceivedDir,
  receivedDirFor,
  receivedRepoPath,
  UnsafeReceivedDirError,
} from './receivedDir.js';

const live: { cleanup(): Promise<void> }[] = [];
async function temp(): Promise<string> {
  const t = await makeTempDir('vibes-received-');
  live.push(t);
  return t.dir;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((t) => t.cleanup()));
});

describe('path shape', () => {
  test('derives the one legal shape and its repo-relative twin', async () => {
    const root = await temp();
    expect(receivedDirFor(root, 'control', 'domain')).toBe(
      join(root, '.vibes', 'received', 'control', 'domain'),
    );
    expect(receivedRepoPath('control', 'domain')).toBe('.vibes/received/control/domain');
  });

  test('accepts exactly a producer scratch dir', async () => {
    const root = await temp();
    expect(() => assertSafeReceivedDir(root, receivedDirFor(root, 'c', 'p'))).not.toThrow();
  });
});

describe('refusals — each one is a directory that must survive', () => {
  test('refuses the received root: it holds every producer, including finished ones', async () => {
    const root = await temp();
    expect(() => assertSafeReceivedDir(root, join(root, '.vibes', 'received'))).toThrow(
      UnsafeReceivedDirError,
    );
  });

  test('refuses .vibes itself: the logs, the report and the COMMITTED policy lock live there', async () => {
    const root = await temp();
    expect(() => assertSafeReceivedDir(root, join(root, '.vibes'))).toThrow(/expected/);
  });

  test('refuses the repo root', async () => {
    const root = await temp();
    expect(() => assertSafeReceivedDir(root, root)).toThrow(/outside the repo root|expected/);
  });

  test('refuses a path outside the repo, however it is spelled', async () => {
    const root = await temp();
    const other = await temp();
    expect(() => assertSafeReceivedDir(root, other)).toThrow(/outside the repo root/);
    expect(() =>
      assertSafeReceivedDir(root, join(root, '.vibes', 'received', '..', '..', '..', 'elsewhere')),
    ).toThrow(UnsafeReceivedDirError);
  });

  test('refuses a deeper path: a nested dir is not the producer dir', async () => {
    const root = await temp();
    expect(() => assertSafeReceivedDir(root, join(root, '.vibes', 'received', 'c', 'p', 'sub'))).toThrow(
      /expected \.vibes\/received/,
    );
  });

  test('refuses a wrong prefix under the repo', async () => {
    const root = await temp();
    expect(() => assertSafeReceivedDir(root, join(root, 'src', 'received', 'c', 'p'))).toThrow(
      /prefix/,
    );
  });

  test('refuses a SYMLINKED ancestor — containment is lexical and would otherwise lie', async () => {
    // The dangerous shape: `.vibes` is a link to somewhere real. `relative()`
    // still answers `.vibes/received/c/p`, the containment check passes, and the
    // deletion lands on the link target.
    const root = await temp();
    const victim = await temp();
    await mkdir(join(victim, 'received', 'c', 'p'), { recursive: true });
    await writeFile(join(victim, 'received', 'c', 'p', 'precious.txt'), 'do not delete\n');
    symlinkSync(victim, join(root, '.vibes'));

    const target = join(root, '.vibes', 'received', 'c', 'p');
    expect(() => assertSafeReceivedDir(root, target)).toThrow(/is a symlink/);
    await expect(prepareReceivedDir(root, target, true)).rejects.toThrow(UnsafeReceivedDirError);
    expect(existsSync(join(victim, 'received', 'c', 'p', 'precious.txt'))).toBe(true);
  });
});

describe('clean', () => {
  test('wiping is what makes a DELETED corpus entry visible', async () => {
    // Without the wipe, output from a case that has since been removed lingers
    // in the received dir and compares byte-equal to its baseline. The deletion
    // then never appears in any report — which is the exact change an honesty
    // tool exists to surface.
    const root = await temp();
    const dir = receivedDirFor(root, 'c', 'p');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'stale.txt'), 'from a case that no longer exists\n');
    await writeFile(join(dir, 'nested', 'deep.txt'), 'x\n');

    const r = await prepareReceivedDir(root, dir, true);
    expect(r.wiped).toBe(true);
    expect(existsSync(join(dir, 'stale.txt'))).toBe(false);
    expect(existsSync(join(dir, 'nested'))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  test('clean:false keeps prior output — the opt-out an incremental producer needs', async () => {
    const root = await temp();
    const dir = receivedDirFor(root, 'c', 'p');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'stale.txt'), 'kept\n');

    const r = await prepareReceivedDir(root, dir, false);
    expect(r.wiped).toBe(false);
    expect(await readFile(join(dir, 'stale.txt'), 'utf8')).toBe('kept\n');
  });

  test('creates the dir when it does not exist yet', async () => {
    const root = await temp();
    const dir = receivedDirFor(root, 'new', 'producer');
    expect(existsSync(dir)).toBe(false);
    await prepareReceivedDir(root, dir, true);
    expect(existsSync(dir)).toBe(true);
  });
});
