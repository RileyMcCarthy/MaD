/**
 * Machine-scoped leases.
 *
 * THE BUG THESE PREVENT, stated once: this repo carries 18 registered
 * worktrees. `git rev-parse --show-toplevel` returns a different path in every
 * one of them, so a lock key derived from the worktree root hands each worktree
 * a private lease on the single machine-global SIL emulator. Two agents then
 * drive one emulator and both believe they measured it. The key is therefore
 * `--git-common-dir`, which is identical from every linked worktree, and the
 * lock directory lives outside the repo entirely.
 */

import { createServer, type Server } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { makeTempDir } from './fixtures.test.js';
import {
  acquireAll,
  acquireLease,
  isStale,
  lockDirFor,
  lockKey,
  lockPathFor,
  parseToken,
  probeResource,
  releaseAll,
  type LockOptions,
} from './locks.js';

const live: { cleanup(): Promise<void> }[] = [];
const servers: Server[] = [];
async function temp(): Promise<string> {
  const t = await makeTempDir('vibes-lock-');
  live.push(t);
  return t.dir;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await Promise.all(live.splice(0).map((t) => t.cleanup()));
});

const opts = (lockDir: string, over: Partial<LockOptions> = {}): LockOptions => ({
  lockDir,
  gitCommonDir: '/repo/.git',
  runId: 'run-1',
  staleLockMs: 3_600_000,
  waitMs: 0,
  pollMs: 5,
  ...over,
});

describe('the key is the machine, not the checkout', () => {
  test('two worktrees of one repo compute the SAME lock path', () => {
    // Both of these are real linked-worktree shapes: different toplevels, one
    // shared common dir. If the key moved with the toplevel, both would take the
    // lease and both would drive the same emulator.
    const common = '/Users/x/MaD/.git';
    const fromMain = lockPathFor('/tmp/vibes-locks', common, 'sil-emulator');
    const fromLinked = lockPathFor('/tmp/vibes-locks', common, 'sil-emulator');
    expect(fromLinked).toBe(fromMain);

    const otherRepo = lockPathFor('/tmp/vibes-locks', '/Users/x/Other/.git', 'sil-emulator');
    expect(otherRepo).not.toBe(fromMain);
  });

  test('distinct tokens get distinct keys, and the key is short and stable', () => {
    expect(lockKey('/a/.git', 'x')).toHaveLength(16);
    expect(lockKey('/a/.git', 'x')).toBe(lockKey('/a/.git', 'x'));
    expect(lockKey('/a/.git', 'x')).not.toBe(lockKey('/a/.git', 'y'));
    // The separator matters: without it, ('/a/.gitx','') and ('/a/.git','x')
    // would collide.
    expect(lockKey('/a/.gitx', '')).not.toBe(lockKey('/a/.git', 'x'));
  });

  test('the lock dir is never under the repo', () => {
    expect(lockDirFor(null, { XDG_RUNTIME_DIR: '/run/user/501' })).toBe('/run/user/501/vibes-locks');
    expect(lockDirFor(null, {})).toBe(join(tmpdir(), 'vibes-locks'));
    expect(lockDirFor('/custom/dir', { XDG_RUNTIME_DIR: '/run/user/501' })).toBe('/custom/dir');
    expect(lockDirFor(null, { XDG_RUNTIME_DIR: '' })).toBe(join(tmpdir(), 'vibes-locks'));
  });
});

describe('acquire / release', () => {
  test('a second acquirer is refused while the first holds', async () => {
    const dir = await temp();
    const first = await acquireLease('sil-emulator', opts(dir));
    expect(first.ok).toBe(true);

    const second = await acquireLease('sil-emulator', opts(dir, { runId: 'run-2' }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.holder?.runId).toBe('run-1');
    expect(second.holder?.pid).toBe(process.pid);

    if (!first.ok) return;
    await first.lease.release();
    const third = await acquireLease('sil-emulator', opts(dir, { runId: 'run-3' }));
    expect(third.ok).toBe(true);
  });

  test('the lease file records who holds it, for the blocked producer to name', async () => {
    const dir = await temp();
    const r = await acquireLease('tok', opts(dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const holder: unknown = JSON.parse(await readFile(r.lease.path, 'utf8'));
    expect(holder).toMatchObject({ token: 'tok', pid: process.pid, host: hostname(), runId: 'run-1' });
  });

  test('release only removes a lock we still own', async () => {
    const dir = await temp();
    const mine = await acquireLease('tok', opts(dir));
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    // Simulate a stale-reclaim by another process that already took the file.
    await writeFile(
      mine.lease.path,
      JSON.stringify({ token: 'tok', pid: process.pid + 1, host: hostname(), runId: 'other', startedAt: Date.now() }),
    );
    await mine.lease.release();

    // Deleting it here would evict the NEW holder, which is worse than leaking.
    const after: unknown = JSON.parse(await readFile(mine.lease.path, 'utf8'));
    expect((after as { runId: string }).runId).toBe('other');
  });

  test('a dead holder is reclaimed', async () => {
    const dir = await temp();
    await mkdir(dir, { recursive: true });
    const path = lockPathFor(dir, '/repo/.git', 'tok');
    // pid 1 exists; a very large pid does not. Use one we can prove is gone.
    await writeFile(
      path,
      JSON.stringify({ token: 'tok', pid: 999_998, host: hostname(), runId: 'ghost', startedAt: Date.now() }),
    );
    const r = await acquireLease('tok', opts(dir));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reclaimed).toBe(true);
  });

  test('an unparseable lock file is a corpse, not a permanent wedge', async () => {
    const dir = await temp();
    await mkdir(dir, { recursive: true });
    await writeFile(lockPathFor(dir, '/repo/.git', 'tok'), 'half-written{');
    const r = await acquireLease('tok', opts(dir));
    expect(r.ok).toBe(true);
  });

  test('a live holder older than the cap is reclaimed by age', () => {
    const now = 10_000_000;
    const live1 = { token: 't', pid: process.pid, host: hostname(), runId: 'r', startedAt: now - 10 };
    expect(isStale(live1, now, 1_000)).toBe(false);
    expect(isStale({ ...live1, startedAt: now - 5_000 }, now, 1_000)).toBe(true);
    // A pid from ANOTHER host is meaningless locally and would likely collide
    // with a live local process, so cross-host leases fall back to age alone.
    const foreign = { ...live1, host: 'someone-else', pid: 999_998, startedAt: now - 10 };
    expect(isStale(foreign, now, 1_000)).toBe(false);
    expect(isStale(null, now, 1_000)).toBe(true);
  });
});

describe('acquireAll', () => {
  test('is all-or-nothing: a partial grab is fully released', async () => {
    const dir = await temp();
    const foreign = await acquireLease('b-token', opts(dir, { runId: 'foreign' }));
    expect(foreign.ok).toBe(true);

    const r = await acquireAll(['a-token', 'b-token'], opts(dir, { runId: 'mine' }));
    expect(r.ok).toBe(false);
    expect(r.blockedToken).toBe('b-token');
    expect(r.blockedBy?.runId).toBe('foreign');

    // `a-token` must be free again — a half-held set is how two runs deadlock.
    const probe = await acquireLease('a-token', opts(dir, { runId: 'other' }));
    expect(probe.ok).toBe(true);
  });

  test('takes tokens in sorted order — that ordering IS the deadlock avoidance', async () => {
    const dir = await temp();
    const r = await acquireAll(['zeta', 'alpha', 'alpha'], opts(dir));
    expect(r.ok).toBe(true);
    // Deduped and sorted: two runs both wanting {sil, port:9999} take them in
    // the same order, so neither can hold half of what the other needs.
    expect(r.leases.map((l) => l.token)).toEqual(['alpha', 'zeta']);
    await releaseAll(r.leases);

    const again = await acquireAll(['alpha'], opts(dir, { runId: 'later' }));
    expect(again.ok).toBe(true);
  });

  test('releaseAll survives a lease whose release throws', async () => {
    const dir = await temp();
    const r = await acquireAll(['a'], opts(dir));
    expect(r.ok).toBe(true);
    const broken = {
      token: 'x',
      path: '/nope',
      release: (): Promise<void> => Promise.reject(new Error('nope')),
    };
    await expect(releaseAll([broken, ...r.leases])).resolves.toBeUndefined();
  });
});

describe('resource probes', () => {
  test('parses the token namespaces', () => {
    expect(parseToken('port:9999')).toMatchObject({ kind: 'port', port: 9999 });
    expect(parseToken('path:/tmp/tty.rpi')).toMatchObject({ kind: 'path', path: '/tmp/tty.rpi' });
    expect(parseToken('sil-emulator')).toMatchObject({ kind: 'opaque', port: null, path: null });
    // A malformed port is opaque rather than a crash or a bogus bind attempt.
    expect(parseToken('port:notanumber')).toMatchObject({ kind: 'opaque' });
    expect(parseToken('port:70000')).toMatchObject({ kind: 'opaque' });
  });

  test('a LOOPBACK-ONLY listener is detected — the wildcard bind alone misses it', async () => {
    // Measured on this machine, holder on 127.0.0.1:P:
    //   listen({port})                  -> BOUND        (holder missed)
    //   listen({port, host:'0.0.0.0'})  -> BOUND        (holder missed)
    //   listen({port, host:'::'})       -> BOUND        (holder missed)
    //   listen({port, host:'127.0.0.1'})-> EADDRINUSE
    // A loopback-only listener is exactly how an emulator's trace/HTTP port
    // binds, so a wildcard-bind probe would call this port free while the
    // previous run's orphan is still serving on it.
    const port = await listenOn('127.0.0.1');
    const held = await probeResource(`port:${String(port)}`);
    // A producer that cannot bind the port it declared has NOT been verified,
    // so this makes it `blocked` rather than a warning-and-proceed.
    expect(held.available).toBe(false);
    expect(held.detail).toMatch(/already listening|EADDRINUSE/);
  });

  test('a wildcard listener is detected too — the answers invert by holder', async () => {
    const port = await listenOn(null);
    const held = await probeResource(`port:${String(port)}`);
    expect(held.available).toBe(false);
  });

  test('a free port is available and is left free', async () => {
    const r = await probeResource('port:0');
    // port 0 is opaque, not a real bind — the parser guards `> 0`.
    expect(r.available).toBe(true);
  });

  test('a leftover device node is detected with lstat, not stat', async () => {
    const dir = await temp();
    const p = join(dir, 'tty.rpi');
    expect((await probeResource(`path:${p}`)).available).toBe(true);
    await writeFile(p, '');
    // The real leftover a SIGKILLed emulator leaves behind is often a dangling
    // link; `stat` would follow it and answer "absent".
    expect((await probeResource(`path:${p}`)).available).toBe(false);
  });

  test('an unheld port is reported free', async () => {
    // Take a port, then release it, so we know a real one that nothing holds.
    const port = await listenOn('127.0.0.1');
    await new Promise<void>((r) => servers.pop()?.close(() => r()));
    const free = await probeResource(`port:${String(port)}`);
    expect(free.available).toBe(true);
  });

  test('an opaque token has nothing to probe and says so', async () => {
    const r = await probeResource('sil-emulator');
    expect(r.available).toBe(true);
    expect(r.detail).toContain('no probe');
  });
});

/** Listen on an ephemeral port and return it. `null` host = wildcard. */
async function listenOn(host: string | null): Promise<number> {
  const server = createServer();
  servers.push(server);
  return new Promise<number>((resolve) => {
    const onListening = (): void => {
      const a = server.address();
      resolve(typeof a === 'object' && a !== null ? a.port : 0);
    };
    if (host === null) server.listen(0, onListening);
    else server.listen(0, host, onListening);
  });
}
