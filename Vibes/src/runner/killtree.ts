/**
 * Killing a producer means killing its process TREE.
 *
 * MaD's real producers are trees: `make playground` → `cargo run` →
 * `mad-emulator`, and the emulator is the thing that holds `/tmp/tty.rpi` and
 * the trace port. Signalling only the direct child leaves the grandchild alive
 * holding the exact resources the next producer declared, which turns one
 * timeout into a cascade of `blocked` runs.
 *
 * That is also why `child_process`'s own `timeout`/`killSignal` options are not
 * used anywhere in this module: they signal the direct child only.
 *
 * POSIX assumption, stated plainly: `detached: true` makes the child a process
 * GROUP leader with `pgid === child.pid`, and `process.kill(-pid, sig)` signals
 * the group. Windows has no process groups; there the ladder degrades to
 * signalling the child alone, which is the documented v1 Windows gap.
 */

export type GroupSignal = 'SIGTERM' | 'SIGKILL' | 0;

export type SignalResult =
  /** Delivered to at least one process in the group. */
  | 'sent'
  /** No such process — the group is gone. */
  | 'gone'
  /** Alive but not ours. Should be impossible for a child we spawned; if it
   *  happens the pid was recycled, and killing it would be worse than not. */
  | 'denied'
  /** Platform refused group signalling (Windows). */
  | 'unsupported';

const IS_POSIX = process.platform !== 'win32';

function errCode(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return null;
}

/** Signal the whole group. `pid` is the group leader (the spawned child). */
export function signalGroup(pid: number, signal: GroupSignal): SignalResult {
  if (!Number.isInteger(pid) || pid <= 1) return 'gone';
  try {
    if (IS_POSIX) process.kill(-pid, signal === 0 ? 0 : signal);
    else process.kill(pid, signal === 0 ? 0 : signal);
    return 'sent';
  } catch (e) {
    const code = errCode(e);
    if (code === 'ESRCH') return 'gone';
    if (code === 'EPERM') return 'denied';
    if (code === 'EINVAL') return 'unsupported';
    return 'gone';
  }
}

/** True when at least one process in the group still exists. */
export function groupAlive(pid: number): boolean {
  const r = signalGroup(pid, 0);
  return r === 'sent' || r === 'denied';
}

export interface KillTreeOptions {
  readonly gracefulKillMs: number;
  readonly probeMs: number;
  /** Injectable so the ladder is testable without real sleeping. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface KillTreeResult {
  /** Which rungs actually fired, in order. */
  readonly steps: readonly ('term' | 'kill' | 'probe')[];
  /** True when the group still answered `kill(-pid, 0)` after SIGKILL.
   *  This is the condition worth shouting about: something survives that Vibes
   *  cannot reach, and the next producer's `port:`/`path:` probe will trip. */
  readonly orphaned: boolean;
  readonly durationMs: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Do not hold the event loop open on a graceful-kill wait.
    if (typeof t.unref === 'function') t.unref();
  });

/**
 * SIGTERM → wait → SIGKILL → wait → probe.
 *
 * The graceful rung is not politeness: an emulator that is SIGKILLed mid-write
 * leaves a half-written PTY device node and a stale lock, and the next run
 * inherits both.
 */
export async function killTree(pid: number, opts: KillTreeOptions): Promise<KillTreeResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const started = Date.now();
  const steps: ('term' | 'kill' | 'probe')[] = [];

  const term = signalGroup(pid, 'SIGTERM');
  steps.push('term');
  if (term === 'gone') return { steps, orphaned: false, durationMs: Date.now() - started };

  // Poll rather than sleeping the full graceful window: a producer that exits
  // in 20 ms should not cost 5 s of wall clock on every timeout path.
  const deadline = Date.now() + Math.max(0, opts.gracefulKillMs);
  const step = Math.max(10, Math.min(100, Math.max(1, opts.gracefulKillMs) / 10));
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return { steps, orphaned: false, durationMs: Date.now() - started };
    await sleep(step);
  }

  if (!groupAlive(pid)) return { steps, orphaned: false, durationMs: Date.now() - started };

  signalGroup(pid, 'SIGKILL');
  steps.push('kill');
  await sleep(Math.max(0, opts.probeMs));
  steps.push('probe');
  return { steps, orphaned: groupAlive(pid), durationMs: Date.now() - started };
}
