/**
 * Resource leases — MACHINE-scoped, not worktree-scoped.
 *
 * THE BUG THIS EXISTS TO PREVENT: this repo carries 18 registered worktrees.
 * `git rev-parse --show-toplevel` returns a DIFFERENT path in each one, so a
 * lock directory derived from the worktree root hands every worktree a private
 * lease on the single machine-global SIL emulator. Two agents then drive one
 * emulator and both believe they measured it.
 *
 * The key is therefore `sha256(--git-common-dir + '\0' + token)` — the common
 * dir is the SHARED `.git`, identical from every linked worktree — and the lock
 * directory lives OUTSIDE the repo, under `$XDG_RUNTIME_DIR` or the system temp
 * dir, so it is per machine and not per checkout.
 *
 * Locks are advisory and machine-local by construction. NFS home directories
 * are an unsupported configuration for `O_EXCL`, and that is acceptable
 * precisely because nothing here is ever placed on a network filesystem.
 */

import { createHash } from 'node:crypto';
import { createServer, Socket } from 'node:net';
import { lstatSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LockHolder {
  readonly token: string;
  readonly pid: number;
  readonly host: string;
  readonly runId: string;
  readonly startedAt: number;
}

export interface Lease {
  readonly token: string;
  readonly path: string;
  release(): Promise<void>;
}

export interface LockOptions {
  readonly lockDir: string;
  /** `git rev-parse --git-common-dir`, absolute. Never the worktree root. */
  readonly gitCommonDir: string;
  readonly runId: string;
  readonly staleLockMs: number;
  readonly waitMs: number;
  readonly pollMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
}

/**
 * `$XDG_RUNTIME_DIR/vibes-locks` when set (it is tmpfs, per-user, and cleared
 * at logout), otherwise `<tmpdir>/vibes-locks`. NEVER under repoRoot.
 */
export function lockDirFor(
  override?: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (override !== null && override !== undefined && override !== '') return override;
  const xdg = env['XDG_RUNTIME_DIR'];
  const base = xdg !== undefined && xdg !== '' ? xdg : tmpdir();
  return join(base, 'vibes-locks');
}

export function lockKey(gitCommonDir: string, token: string): string {
  return createHash('sha256').update(`${gitCommonDir}\0${token}`).digest('hex').slice(0, 16);
}

export function lockPathFor(lockDir: string, gitCommonDir: string, token: string): string {
  return join(lockDir, `${lockKey(gitCommonDir, token)}.lock`);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code?: unknown }).code : null;
    // EPERM means it exists and belongs to someone else — still alive.
    return code === 'EPERM';
  }
}

async function readHolder(path: string): Promise<LockHolder | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o['token'] !== 'string' || typeof o['pid'] !== 'number') return null;
    return {
      token: o['token'],
      pid: o['pid'],
      host: typeof o['host'] === 'string' ? o['host'] : '',
      runId: typeof o['runId'] === 'string' ? o['runId'] : '',
      startedAt: typeof o['startedAt'] === 'number' ? o['startedAt'] : 0,
    };
  } catch {
    // Unreadable or truncated: treat as a corpse rather than a holder. A lock
    // file we cannot parse must not be able to wedge the machine forever.
    return null;
  }
}

/**
 * A holder is stale when it is demonstrably gone, or older than the cap.
 *
 * Liveness is judged by pid ONLY on the same host — a pid from another machine
 * is meaningless here and, worse, is likely to collide with a live local one.
 * Cross-host leases fall back to age alone.
 */
export function isStale(holder: LockHolder | null, now: number, staleMs: number): boolean {
  if (holder === null) return true;
  if (holder.host === hostname() && !pidAlive(holder.pid)) return true;
  return now - holder.startedAt > staleMs;
}

export type AcquireResult =
  | { readonly ok: true; readonly lease: Lease; readonly reclaimed: boolean }
  | { readonly ok: false; readonly holder: LockHolder | null; readonly waitedMs: number };

export async function acquireLease(token: string, opts: LockOptions): Promise<AcquireResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const path = lockPathFor(opts.lockDir, opts.gitCommonDir, token);
  await mkdir(opts.lockDir, { recursive: true });

  const startedWaiting = now();
  let reclaimed = false;

  for (;;) {
    try {
      // 'wx' is O_CREAT|O_EXCL: the whole mutual-exclusion guarantee is this
      // one flag, and it is why nothing here does check-then-create.
      const fh = await open(path, 'wx');
      const holder: LockHolder = {
        token,
        pid: process.pid,
        host: hostname(),
        runId: opts.runId,
        startedAt: now(),
      };
      try {
        await fh.writeFile(JSON.stringify(holder));
      } finally {
        await fh.close();
      }
      return { ok: true, reclaimed, lease: makeLease(token, path, holder) };
    } catch (e) {
      const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code?: unknown }).code : null;
      if (code !== 'EEXIST') throw e;
    }

    const holder = await readHolder(path);
    if (isStale(holder, now(), opts.staleLockMs)) {
      await rm(path, { force: true });
      reclaimed = true;
      continue;
    }

    const waited = now() - startedWaiting;
    if (waited >= opts.waitMs || opts.signal?.aborted === true) {
      return { ok: false, holder, waitedMs: waited };
    }
    await sleep(Math.max(1, opts.pollMs));
  }
}

function makeLease(token: string, path: string, holder: LockHolder): Lease {
  let released = false;
  return {
    token,
    path,
    async release() {
      if (released) return;
      released = true;
      // Only remove a lock we still own. If a stale-reclaim by another process
      // already took it, deleting it would evict the new holder.
      const current = await readHolder(path);
      if (current !== null && (current.pid !== holder.pid || current.startedAt !== holder.startedAt)) return;
      await rm(path, { force: true });
    },
  };
}

export interface AcquireAllResult {
  readonly ok: boolean;
  readonly leases: readonly Lease[];
  /** The token that could not be taken, when `ok` is false. */
  readonly blockedToken: string | null;
  readonly blockedBy: LockHolder | null;
  readonly waitedMs: number;
}

/**
 * All-or-nothing, in sorted token order.
 *
 * Sorting is the deadlock avoidance: every Vibes process on the machine takes
 * the same tokens in the same order, so two runs that both want
 * {`sil-emulator`, `port:9999`} cannot each hold half.
 */
export async function acquireAll(
  tokens: readonly string[],
  opts: LockOptions,
): Promise<AcquireAllResult> {
  const ordered = [...new Set(tokens)].sort();
  const held: Lease[] = [];
  for (const token of ordered) {
    const r = await acquireLease(token, opts);
    if (!r.ok) {
      await releaseAll(held);
      return { ok: false, leases: [], blockedToken: token, blockedBy: r.holder, waitedMs: r.waitedMs };
    }
    held.push(r.lease);
  }
  return { ok: true, leases: held, blockedToken: null, blockedBy: null, waitedMs: 0 };
}

export async function releaseAll(leases: readonly Lease[]): Promise<void> {
  // Reverse order, and never let one failed unlink strand the rest.
  for (const lease of [...leases].reverse()) {
    try {
      await lease.release();
    } catch {
      /* advisory locks: a failed release is reclaimed by staleness */
    }
  }
}

/* ─────────────────────────── token namespaces ────────────────────────── */

export type TokenKind = 'port' | 'path' | 'opaque';

export interface ParsedToken {
  readonly kind: TokenKind;
  readonly raw: string;
  readonly port: number | null;
  readonly path: string | null;
}

export function parseToken(token: string): ParsedToken {
  if (token.startsWith('port:')) {
    const n = Number(token.slice(5));
    if (Number.isInteger(n) && n > 0 && n < 65536) {
      return { kind: 'port', raw: token, port: n, path: null };
    }
    return { kind: 'opaque', raw: token, port: null, path: null };
  }
  if (token.startsWith('path:')) {
    return { kind: 'path', raw: token, port: null, path: token.slice(5) };
  }
  return { kind: 'opaque', raw: token, port: null, path: null };
}

export interface ProbeResult {
  readonly token: string;
  readonly available: boolean;
  readonly detail: string;
}

export type ResourceProbe = (token: string) => Promise<ProbeResult>;

/**
 * Probe a `port:` or `path:` token for a FOREIGN holder.
 *
 * We already hold the Vibes lease at this point, so anything answering here is
 * outside Vibes' bookkeeping — a hand-started emulator, a stray `npm run dev`,
 * or an orphan from a previous killed run. The spec's ruling stands: a producer
 * that cannot bind the port it declared has NOT been verified, so this makes it
 * `blocked` rather than a warning-and-proceed.
 */
export async function probeResource(token: string): Promise<ProbeResult> {
  const t = parseToken(token);
  if (t.kind === 'port' && t.port !== null) return probePort(token, t.port);
  if (t.kind === 'path' && t.path !== null && t.path !== '') {
    try {
      // lstat, not stat: a dangling symlink at /tmp/tty.rpi is exactly the
      // leftover a killed emulator leaves behind, and stat would miss it.
      lstatSync(t.path);
      return { token, available: false, detail: `${t.path} already exists` };
    } catch {
      return { token, available: true, detail: `${t.path} absent` };
    }
  }
  return { token, available: true, detail: 'opaque token; no probe' };
}

/** A connect probe waits this long before concluding nothing answered. */
const PROBE_CONNECT_MS = 300;

/**
 * Is anything SERVING on this port?
 *
 * A bind test alone is not sufficient, and this was measured rather than
 * assumed. On macOS, with a listener held on `127.0.0.1:P`:
 *
 *   listen({port})                 -> BOUND   (the holder is missed entirely)
 *   listen({port, host:'0.0.0.0'}) -> BOUND
 *   listen({port, host:'::'})      -> BOUND
 *   listen({port, host:'127.0.0.1'}) -> EADDRINUSE
 *
 * and with the holder on the wildcard the answers invert. A loopback-only
 * listener is exactly how an emulator's trace/HTTP port binds, so a wildcard
 * bind — the obvious implementation — would report the port free while the
 * previous run's orphan is still serving on it.
 *
 * So: connect first (that is the question actually being asked — "is someone
 * already there?"), then try both binds, and treat any refusal as taken.
 */
async function probePort(token: string, port: number): Promise<ProbeResult> {
  for (const host of ['127.0.0.1', '::1']) {
    if (await connects(host, port)) {
      return { token, available: false, detail: `something is already listening on ${host}:${String(port)}` };
    }
  }
  for (const host of [null, '127.0.0.1']) {
    const code = await bindFailure(host, port);
    if (code !== null) {
      return {
        token,
        available: false,
        detail: `bind ${host ?? '*'}:${String(port)} failed with ${code}`,
      };
    }
  }
  return { token, available: true, detail: `:${String(port)} is free` };
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PROBE_CONNECT_MS, () => done(false));
    socket.once('connect', () => done(true));
    // ECONNREFUSED (nothing there), EHOSTUNREACH / EAFNOSUPPORT (no IPv6 on
    // this host) all mean the same thing to us: not taken by a listener.
    socket.once('error', () => done(false));
    socket.connect({ host, port });
  });
}

function bindFailure(host: string | null, port: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const server = createServer();
    let settled = false;
    const done = (code: string | null): void => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      server.close(() => resolve(code));
    };
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      // The bind failed, so there is nothing to close.
      resolve(e.code ?? e.message);
    });
    // `exclusive` stops the cluster module from quietly sharing the handle,
    // which would make a taken port look free inside a clustered runner.
    server.listen(host === null ? { port, exclusive: true } : { port, host, exclusive: true }, () => {
      done(null);
    });
  });
}
