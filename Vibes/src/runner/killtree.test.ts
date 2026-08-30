/**
 * Real process groups, real signals.
 *
 * The claim under test is the one that cannot be mocked: killing a producer
 * must kill its GRANDCHILDREN. MaD's producers are trees — `make playground` →
 * `cargo run` → `mad-emulator` — and the emulator is the process that holds
 * `/tmp/tty.rpi`. Signalling the direct child leaves it alive holding the exact
 * resource the next producer declared, turning one timeout into a cascade of
 * `blocked` runs. Node's own `spawn({timeout})` does precisely that, which is
 * why nothing in this module uses it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { makeTempDir, sleep } from './fixtures.test.js';
import { groupAlive, killTree, signalGroup } from './killtree.js';

const kids: ChildProcess[] = [];
afterEach(() => {
  for (const c of kids.splice(0)) {
    if (c.pid !== undefined && c.pid !== null) signalGroup(c.pid, 'SIGKILL');
  }
});

function spawnDetached(cmd: string, cwd: string): ChildProcess {
  const child = spawn('/bin/sh', ['-c', cmd], {
    cwd,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  kids.push(child);
  return child;
}

describe.skipIf(process.platform === 'win32')('killTree', () => {
  test('kills a GRANDCHILD the direct child left running', async () => {
    const t = await makeTempDir('vibes-kill-');
    try {
      const marker = join(t.dir, 'alive.txt');
      // The shape that breaks a naive kill: the shell backgrounds a loop and
      // then waits. SIGTERM to the shell alone leaves the loop appending.
      const child = spawnDetached(
        `sh -c 'while :; do printf x >> "${marker}"; sleep 0.02; done' & wait`,
        t.dir,
      );
      const pid = child.pid;
      expect(pid).toBeTypeOf('number');
      if (pid === undefined) return;

      // Wait until the grandchild is demonstrably running.
      for (let i = 0; i < 100 && !(await exists(marker)); i += 1) await sleep(20);
      const growing = (await stat(marker)).size;
      await sleep(60);
      expect((await stat(marker)).size).toBeGreaterThan(growing);

      const r = await killTree(pid, { gracefulKillMs: 300, probeMs: 100 });
      expect(r.steps[0]).toBe('term');

      const settled = (await readFile(marker)).length;
      await sleep(200);
      expect((await readFile(marker)).length).toBe(settled);
      expect(groupAlive(pid)).toBe(false);
      expect(r.orphaned).toBe(false);
    } finally {
      await t.cleanup();
    }
  }, 15_000);

  test('a process that ignores SIGTERM is escalated to SIGKILL', async () => {
    const t = await makeTempDir('vibes-kill-');
    try {
      const child = spawnDetached(`trap '' TERM; while :; do sleep 0.05; done`, t.dir);
      const pid = child.pid;
      if (pid === undefined) return;
      await sleep(120); // let the trap install

      const r = await killTree(pid, { gracefulKillMs: 250, probeMs: 150 });
      expect(r.steps).toContain('kill');
      expect(r.orphaned).toBe(false);
      expect(groupAlive(pid)).toBe(false);
    } finally {
      await t.cleanup();
    }
  }, 15_000);

  test('a cooperative process exits on SIGTERM without paying the full graceful wait', async () => {
    const t = await makeTempDir('vibes-kill-');
    try {
      const child = spawnDetached('sleep 30', t.dir);
      const pid = child.pid;
      if (pid === undefined) return;
      await sleep(50);

      const r = await killTree(pid, { gracefulKillMs: 5_000, probeMs: 500 });
      // Polling, not sleeping: a 20 ms exit must not cost 5 s of wall clock on
      // every timeout path, or a run with ten timeouts loses a minute.
      expect(r.durationMs).toBeLessThan(2_000);
      expect(r.steps).not.toContain('kill');
    } finally {
      await t.cleanup();
    }
  }, 15_000);

  test('an already-dead group reports gone rather than throwing', async () => {
    const r = await killTree(999_999, { gracefulKillMs: 100, probeMs: 10 });
    expect(r.steps).toEqual(['term']);
    expect(r.orphaned).toBe(false);
  });
});

describe('signalGroup', () => {
  test('refuses pids that would signal something other than one group', () => {
    // `kill(-1, sig)` signals EVERY process the user can signal. Guarding pid<=1
    // is not defensive style; it is the difference between a timeout and a
    // logout.
    expect(signalGroup(-1, 'SIGKILL')).toBe('gone');
    expect(signalGroup(0, 'SIGKILL')).toBe('gone');
    expect(signalGroup(1, 'SIGKILL')).toBe('gone');
    expect(signalGroup(1.5, 'SIGKILL')).toBe('gone');
  });

  test.skipIf(process.platform === 'win32')(
    'the pid must be a GROUP LEADER — which is exactly what detached:true guarantees',
    async () => {
      // Worth pinning: `kill(-pid, 0)` is ESRCH unless `pid` is a process-GROUP
      // id. A vitest worker is not a group leader, so probing our own pid answers
      // "gone" even though we are plainly running. Every pid this module is
      // handed comes from a `detached: true` spawn, which makes the child a group
      // leader with pgid === pid; anything else silently probes nothing.
      const t = await makeTempDir('vibes-kill-');
      try {
        expect(groupAlive(process.pid)).toBe(false);

        const child = spawnDetached('sleep 5', t.dir);
        const pid = child.pid;
        if (pid === undefined) return;
        await sleep(50);
        expect(groupAlive(pid)).toBe(true);
        signalGroup(pid, 'SIGKILL');
        await sleep(100);
        expect(groupAlive(pid)).toBe(false);
      } finally {
        await t.cleanup();
      }
    },
    15_000,
  );
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
