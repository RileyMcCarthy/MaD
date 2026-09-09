/**
 * Spawning one producer, for real.
 *
 * Every assertion here corresponds to a way a producer can hang or lie:
 * a full stdout pipe, a prompt on stdin nobody answers, a multi-byte character
 * split across two chunk boundaries, a background grandchild that outlives its
 * shell.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { makeTempDir, sleep } from './fixtures.test.js';
import { BoundedCapture, decodeCapture, runCommand, shPortabilityHazards } from './exec.js';

const live: { cleanup(): Promise<void> }[] = [];
async function temp(): Promise<string> {
  const t = await makeTempDir('vibes-exec-');
  live.push(t);
  return t.dir;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((t) => t.cleanup()));
});

const BASE = {
  timeoutMs: 10_000,
  gracefulKillMs: 500,
  killProbeMs: 100,
  closeGraceMs: 500,
  maxOutputBytes: 64 * 1024,
  logTeeBytes: 256 * 1024,
  env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
} as const;

describe('exit status', () => {
  test('captures stdout, stderr and a zero exit', async () => {
    const cwd = await temp();
    const r = await runCommand({ ...BASE, cmd: 'echo out; echo err 1>&2', cwd });
    expect(r.code).toBe(0);
    expect(r.failure).toBeNull();
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
  });

  test('a nonzero exit is reported as a code, not as a failure mode', async () => {
    const cwd = await temp();
    const r = await runCommand({ ...BASE, cmd: 'exit 3', cwd });
    expect(r.code).toBe(3);
    // `failure` is reserved for things Vibes did (timeout, abort, spawn error).
    // Conflating them would make "the producer failed" and "we killed it"
    // indistinguishable in the report.
    expect(r.failure).toBeNull();
  });

  test('runs in the requested cwd', async () => {
    const cwd = await temp();
    const r = await runCommand({ ...BASE, cmd: 'pwd', cwd });
    expect(r.stdout.trim()).toBe(cwd);
  });

  test('a missing shell is a spawn error, not a crash', async () => {
    const cwd = await temp();
    const r = await runCommand({ ...BASE, cmd: 'true', cwd, shell: '/nonexistent/sh' });
    expect(r.failure).toBe('spawn-error');
    expect(r.spawnError).toContain('ENOENT');
  });
});

describe('the child cannot hang the run', () => {
  test('stdin is EOF, so a tool that reads it does not block forever', async () => {
    const cwd = await temp();
    const r = await runCommand({ ...BASE, cmd: 'cat; echo done', cwd, timeoutMs: 4_000 });
    expect(r.stdout).toBe('done\n');
    expect(r.failure).toBeNull();
  }, 10_000);

  test('a chatty producer does not deadlock on a full pipe', async () => {
    // A 64 KiB pipe blocks the writer once nobody drains it. This emits ~2 MiB,
    // far past that, and must still exit.
    const cwd = await temp();
    const r = await runCommand({
      ...BASE,
      cmd: `i=0; while [ $i -lt 2048 ]; do awk 'BEGIN{for(n=0;n<16;n++) printf "%064d\\n", n}'; i=$((i+1)); done`,
      cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024,
    });
    expect(r.code).toBe(0);
    expect(r.stdoutBytes).toBeGreaterThan(1_000_000);
    expect(r.stdoutDropped).toBeGreaterThan(0);
  }, 60_000);

  test('a timeout kills the whole GROUP, not just the shell', async () => {
    const cwd = await temp();
    const marker = join(cwd, 'tick.txt');
    const r = await runCommand({
      ...BASE,
      cmd: `sh -c 'while :; do printf x >> "${marker}"; sleep 0.02; done' & wait`,
      cwd,
      timeoutMs: 250,
      gracefulKillMs: 300,
    });
    expect(r.failure).toBe('timeout');

    const settled = (await readFile(marker)).length;
    await sleep(250);
    // The grandchild holds the resource the next producer declares. If it is
    // still appending here, the whole lease design is decorative.
    expect((await readFile(marker)).length).toBe(settled);
  }, 15_000);

  test('an abort signal cancels a running producer', async () => {
    const cwd = await temp();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runCommand({ ...BASE, cmd: 'sleep 30', cwd, signal: controller.signal });
    expect(r.failure).toBe('cancelled');
    expect(r.durationMs).toBeLessThan(5_000);
  }, 15_000);

  test('an already-aborted signal never lets the producer run to completion', async () => {
    const cwd = await temp();
    const controller = new AbortController();
    controller.abort();
    const r = await runCommand({ ...BASE, cmd: 'sleep 30', cwd, signal: controller.signal });
    expect(r.failure).toBe('cancelled');
  }, 15_000);

  test('an idle timeout fires on silence and stays off at 0', async () => {
    const cwd = await temp();
    const idle = await runCommand({
      ...BASE,
      cmd: 'echo hi; sleep 30',
      cwd,
      idleTimeoutMs: 300,
      timeoutMs: 20_000,
    });
    expect(idle.failure).toBe('idle-timeout');

    // 0 is the default precisely because `cargo build` and `pio run` are
    // legitimately silent for minutes; an idle timeout there converts a slow
    // producer into a false regression.
    const quiet = await runCommand({ ...BASE, cmd: 'sleep 0.6; echo late', cwd, idleTimeoutMs: 0 });
    expect(quiet.failure).toBeNull();
    expect(quiet.stdout).toBe('late\n');
  }, 30_000);
});

describe('logs', () => {
  test('writes the raw tee to disk and reports its path', async () => {
    const cwd = await temp();
    const out = join(cwd, 'logs', 'p.out.log');
    const err = join(cwd, 'logs', 'p.err.log');
    const r = await runCommand({
      ...BASE,
      cmd: 'echo hello; echo bad 1>&2',
      cwd,
      stdoutLogPath: out,
      stderrLogPath: err,
    });
    expect(r.stdoutPath).toBe(out);
    expect(await readFile(out, 'utf8')).toBe('hello\n');
    expect(await readFile(err, 'utf8')).toBe('bad\n');
  });

  test('the tee is bounded too — an uncapped sink can fill a runner disk', async () => {
    const cwd = await temp();
    const out = join(cwd, 'big.log');
    await runCommand({
      ...BASE,
      cmd: `awk 'BEGIN{for(n=0;n<20000;n++) printf "%064d\\n", n}'`,
      cwd,
      maxOutputBytes: 4 * 1024,
      logTeeBytes: 16 * 1024,
      stdoutLogPath: out,
    });
    const size = (await stat(out)).size;
    expect(size).toBeGreaterThan(0);
    // 16 KiB cap plus the elision marker; nowhere near the ~1.3 MB emitted.
    expect(size).toBeLessThan(17 * 1024);
  }, 30_000);

  test('no log path means no file written', async () => {
    const cwd = await temp();
    const r = await runCommand({ ...BASE, cmd: 'echo x', cwd });
    expect(r.stdoutPath).toBeNull();
    expect(r.stderrPath).toBeNull();
  });
});

describe('BoundedCapture', () => {
  test('keeps the head and the TAIL, because the failure is at the end', () => {
    const cap = new BoundedCapture(100);
    for (let i = 0; i < 50; i += 1) cap.push(Buffer.from(`line${String(i).padStart(3, '0')}\n`));
    const text = cap.toBuffer().toString('utf8');
    expect(text.startsWith('line000')).toBe(true);
    expect(text.endsWith('line049\n')).toBe(true);
    expect(text).toContain('[vibes: elided');
    // Head 25% / tail 75%: the stack trace lives at the bottom, and a symmetric
    // split would throw exactly that away.
    expect(cap.totalBytes).toBe(50 * 8);
    expect(cap.droppedBytes).toBe(50 * 8 - 100);
  });

  test('passes small output through untouched, with no marker', () => {
    const cap = new BoundedCapture(1024);
    cap.push(Buffer.from('a'));
    cap.push(Buffer.from('b'));
    expect(cap.toBuffer().toString('utf8')).toBe('ab');
    expect(cap.droppedBytes).toBe(0);
  });

  test('a multi-byte character split across chunks survives — setEncoding would not', () => {
    // `setEncoding('utf8')` on the stream decodes per chunk and turns a split
    // character into U+FFFD. A corrupted byte in a log is indistinguishable from
    // a real one, so the bytes are buffered and decoded exactly once.
    const emoji = Buffer.from('héllo — 🌍', 'utf8');
    const cap = new BoundedCapture(4096);
    for (let i = 0; i < emoji.length; i += 1) cap.push(emoji.subarray(i, i + 1));
    expect(decodeCapture(cap.toBuffer())).toBe('héllo — 🌍');
  });

  test('strips terminal control sequences — a log is evidence, not a replay', () => {
    expect(decodeCapture(Buffer.from('[31mred[0m\n'))).toBe('red\n');
  });

  test('a zero budget drops everything but still says how much', () => {
    const cap = new BoundedCapture(0);
    cap.push(Buffer.from('abcdef'));
    expect(cap.totalBytes).toBe(6);
    expect(cap.droppedBytes).toBe(6);
    expect(cap.toBuffer().toString('utf8')).toContain('elided 6 bytes');
  });
});

describe('shPortabilityHazards', () => {
  test('flags bash/zsh syntax that dash rejects', () => {
    // The author's interactive zsh accepts all of these; Ubuntu's /bin/sh is
    // dash and does not. That is a producer that works locally and is CI-only
    // `failed` — the least debuggable failure this tool can produce.
    expect(shPortabilityHazards('[[ -f x ]] && echo hi')).toContain('[[ ... ]] (bash/zsh test)');
    expect(shPortabilityHazards('diff <(a) <(b)')).toContain('<(...) process substitution');
    expect(shPortabilityHazards('make |& tee log')).toContain('|& (bash stderr pipe)');
    expect(shPortabilityHazards('function build { :; }')).toContain('`function name` declaration');
  });

  test('leaves POSIX sh alone', () => {
    expect(shPortabilityHazards('npm run build && node ./x.mjs > "$VIBES_OUT_DIR/a.json"')).toEqual(
      [],
    );
    expect(shPortabilityHazards('[ -f x ] && echo hi')).toEqual([]);
  });
});
