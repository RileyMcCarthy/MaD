/**
 * Spawning one producer.
 *
 * Four decisions here are load-bearing and each has a specific failure it
 * prevents:
 *
 *  1. `detached: true` + a process-GROUP kill ladder (see killtree.ts).
 *  2. `stdio[0] = 'ignore'`. A prompting tool gets EOF instead of blocking
 *     forever on a stdin nobody will ever write to.
 *  3. Streams are ALWAYS drained. A full 64 KiB pipe blocks the child, and a
 *     producer that deadlocks on its own stdout looks exactly like a hang.
 *  4. Chunks are buffered and decoded ONCE, at the end. `setEncoding` corrupts
 *     a multi-byte character split across a chunk boundary, and a corrupted
 *     byte in a log is indistinguishable from a real one.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { killTree } from './killtree.js';

/**
 * Head 25% / tail 75%.
 *
 * The split is not arbitrary: a producer's identity (which command, which
 * config) is at the top and its failure is at the bottom, and the bottom is
 * what a reader needs. A symmetric split throws away the stack trace.
 */
const HEAD_FRACTION = 0.25;

export class BoundedCapture {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;
  private total = 0;

  constructor(maxBytes: number) {
    const max = Math.max(0, Math.floor(maxBytes));
    this.headLimit = Math.floor(max * HEAD_FRACTION);
    this.tailLimit = max - this.headLimit;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headLimit) {
      const take = Math.min(this.headLimit - this.headBytes, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes > this.tailLimit && this.tail.length > 0) {
      const first = this.tail[0];
      if (first === undefined) break;
      const excess = this.tailBytes - this.tailLimit;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.dropped += excess;
      }
    }
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  get totalBytes(): number {
    return this.total;
  }

  /** Head + an explicit elision marker + tail. The marker is inside the bytes
   *  so a reader of the raw log cannot mistake a gap for the real output. */
  toBuffer(): Buffer {
    const parts = [...this.head];
    if (this.dropped > 0) {
      parts.push(Buffer.from(`\n[vibes: elided ${String(this.dropped)} bytes]\n`, 'utf8'));
    }
    parts.push(...this.tail);
    return Buffer.concat(parts);
  }
}

/**
 * Decode once, then strip terminal control sequences.
 *
 * Producer logs are EVIDENCE, not a terminal replay. Stripping also removes an
 * HTML-injection surface from the report, and `NO_COLOR=1 TERM=dumb` in the
 * spawn env means well-behaved producers emit none of this anyway.
 */
export function decodeCapture(buf: Buffer): string {
  return stripVTControlCharacters(buf.toString('utf8'));
}

export interface SpawnRequest {
  readonly cmd: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** 0 disables. See constants.ts for why the default is 0. */
  readonly idleTimeoutMs?: number;
  readonly gracefulKillMs: number;
  readonly killProbeMs: number;
  readonly closeGraceMs: number;
  readonly maxOutputBytes: number;
  /** Ring-buffer cap for the raw tee. */
  readonly logTeeBytes: number;
  readonly stdoutLogPath?: string | null;
  readonly stderrLogPath?: string | null;
  readonly signal?: AbortSignal | undefined;
  /** POSIX sh, never the login shell: a producer must behave the same on a
   *  laptop running zsh and on an Ubuntu runner where /bin/sh is dash. */
  readonly shell?: string;
}

export type SpawnFailure = 'timeout' | 'idle-timeout' | 'cancelled' | 'spawn-error' | null;

export interface SpawnOutcome {
  readonly pid: number | null;
  readonly code: number | null;
  readonly signal: string | null;
  readonly failure: SpawnFailure;
  readonly spawnError: string | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutDropped: number;
  readonly stderrDropped: number;
  /** The process group answered `kill(-pid, 0)` after SIGKILL. */
  readonly orphanedGroup: boolean;
  readonly stdoutPath: string | null;
  readonly stderrPath: string | null;
}

export type RunCommand = (req: SpawnRequest) => Promise<SpawnOutcome>;

export async function runCommand(req: SpawnRequest): Promise<SpawnOutcome> {
  const startedAt = Date.now();
  const shell = req.shell ?? '/bin/sh';

  const outCap = new BoundedCapture(req.maxOutputBytes);
  const errCap = new BoundedCapture(req.maxOutputBytes);
  const outTee = new BoundedCapture(req.logTeeBytes);
  const errTee = new BoundedCapture(req.logTeeBytes);

  let failure: SpawnFailure = null;
  let spawnError: string | null = null;
  let orphanedGroup = false;

  const child = spawn(shell, ['-c', req.cmd], {
    cwd: req.cwd,
    env: { ...req.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  });

  const pid = typeof child.pid === 'number' ? child.pid : null;
  let lastOutputAt = Date.now();

  child.stdout?.on('data', (c: Buffer) => {
    lastOutputAt = Date.now();
    outCap.push(c);
    outTee.push(c);
  });
  child.stderr?.on('data', (c: Buffer) => {
    lastOutputAt = Date.now();
    errCap.push(c);
    errTee.push(c);
  });
  // A stream error (EPIPE on a killed child) must not become an unhandled
  // rejection that takes the whole run down.
  child.stdout?.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);

  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  const finished = new Promise<void>((resolve) => {
    let settled = false;
    let closeTimer: NodeJS.Timeout | null = null;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      // Disarm the close-grace timer. Left armed it would fire after this
      // function has already returned, flip `orphanedGroup` on a value nobody
      // reads, and — much worse — signal a pid that the OS may have recycled.
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      resolve();
    };

    child.on('error', (e: Error) => {
      failure ??= 'spawn-error';
      spawnError = e.message;
      settle();
    });

    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Resolve on `close` when we can — it means every pipe drained. But a
      // grandchild that inherited stdout keeps the pipe open after the direct
      // child exits, and waiting on `close` there hangs forever. Bounded wait;
      // if `close` never comes, something in the group outlived its parent, so
      // reap the group and say so rather than reporting a clean exit.
      closeTimer = setTimeout(() => {
        orphanedGroup = true;
        if (pid !== null) void killTree(pid, { gracefulKillMs: 0, probeMs: 0 });
        settle();
      }, Math.max(0, req.closeGraceMs));
      if (typeof closeTimer.unref === 'function') closeTimer.unref();
    });

    child.on('close', () => {
      settle();
    });
  });

  const timers: NodeJS.Timeout[] = [];
  const arm = (fn: () => void, ms: number): void => {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === 'function') t.unref();
    timers.push(t);
  };

  let killPromise: Promise<void> | null = null;
  const kill = (why: SpawnFailure): void => {
    if (killPromise !== null || pid === null) return;
    failure ??= why;
    killPromise = killTree(pid, {
      gracefulKillMs: req.gracefulKillMs,
      probeMs: req.killProbeMs,
    }).then((r) => {
      orphanedGroup = r.orphaned;
    });
  };

  if (req.timeoutMs > 0) arm(() => kill('timeout'), req.timeoutMs);

  const idle = req.idleTimeoutMs ?? 0;
  if (idle > 0) {
    const tick = Math.max(50, Math.min(1_000, idle / 4));
    const id = setInterval(() => {
      if (Date.now() - lastOutputAt >= idle) kill('idle-timeout');
    }, tick);
    if (typeof id.unref === 'function') id.unref();
    timers.push(id);
  }

  const onAbort = (): void => kill('cancelled');
  if (req.signal !== undefined) {
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    await finished;
    if (killPromise !== null) await killPromise;
  } finally {
    // clearTimeout and clearInterval are the same unenroll in Node, so one
    // list of handles is enough for both kinds.
    for (const t of timers) clearTimeout(t);
    if (req.signal !== undefined) req.signal.removeEventListener('abort', onAbort);
  }

  const stdoutPath = (await writeLog(req.stdoutLogPath, outTee)) ?? null;
  const stderrPath = (await writeLog(req.stderrLogPath, errTee)) ?? null;

  return {
    pid,
    code: exitCode,
    signal: exitSignal,
    failure,
    spawnError,
    durationMs: Date.now() - startedAt,
    stdout: decodeCapture(outCap.toBuffer()),
    stderr: decodeCapture(errCap.toBuffer()),
    stdoutBytes: outCap.totalBytes,
    stderrBytes: errCap.totalBytes,
    stdoutDropped: outCap.droppedBytes,
    stderrDropped: errCap.droppedBytes,
    orphanedGroup,
    stdoutPath,
    stderrPath,
  };
}

async function writeLog(path: string | null | undefined, cap: BoundedCapture): Promise<string | null> {
  if (path === null || path === undefined || path === '') return null;
  await mkdir(dirname(path), { recursive: true });
  // Raw bytes, not the ANSI-stripped decode: the log on disk is the artifact a
  // human may want to grep, and stripping is a presentation concern.
  await writeFile(path, cap.toBuffer());
  return path;
}

/**
 * `/bin/sh` is dash on Ubuntu and a POSIX-mode bash on macOS. These four
 * constructs are accepted by the author's interactive zsh and rejected by dash,
 * which turns a working local producer into a CI-only `failed`.
 */
const SH_HAZARDS: readonly { readonly probe: RegExp; readonly what: string }[] = [
  { probe: /\[\[/, what: '[[ ... ]] (bash/zsh test)' },
  { probe: /<\(/, what: '<(...) process substitution' },
  { probe: /\|&/, what: '|& (bash stderr pipe)' },
  { probe: /(^|[^A-Za-z0-9_])function\s+[A-Za-z_]/, what: '`function name` declaration' },
];

export function shPortabilityHazards(cmd: string): readonly string[] {
  return SH_HAZARDS.filter((h) => h.probe.test(cmd)).map((h) => h.what);
}
