/**
 * Low-level git invocation.
 *
 * WHY spawn and not execFile: several call sites must write NUL-framed data to
 * git's stdin (`check-ignore --stdin`, `cat-file --batch`) and execFile has no
 * `input` option.
 *
 * WHY Buffers and not strings: `-z` framing is byte-oriented, a path is bytes,
 * and `setEncoding` corrupts a multi-byte character split across a chunk
 * boundary. We collect chunks and decode exactly once, at the end.
 *
 * WHY fixed `-c` overrides: a contributor's ~/.gitconfig must not be able to
 * change what the core sees. `diff.external` alone can replace every diff this
 * tool reads with arbitrary output.
 */

import { spawn } from 'node:child_process';

/** Git commands are read-only plumbing; 2 minutes is already pathological. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
/** Guards against a runaway `cat-file` on a pack-sized blob eating the heap. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Prepended to every invocation.
 * - `--no-optional-locks`: never write .git/index just by looking at the tree.
 * - `core.quotepath=false`: raw UTF-8 bytes in paths, not `\303\251` escapes.
 * - `core.fsmonitor=false`: a stale fsmonitor daemon must not answer for us.
 * - `core.hooksPath=/dev/null`: reading a repo must not execute repo code.
 * - `diff.external=`: with `--no-ext-diff`, belt and braces.
 */
const FIXED_ARGS: readonly string[] = [
  '--no-optional-locks',
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
];

export interface GitCommandRecord {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly code: number;
  readonly durationMs: number;
  /** First line of stderr, if any. Reports quote this; nothing parses it. */
  readonly stderrHead: string | null;
}

export class GitError extends Error {
  readonly argv: readonly string[];
  readonly code: number;
  readonly signal: string | null;
  readonly stderr: string;
  readonly cwd: string;

  constructor(
    message: string,
    d: {
      argv: readonly string[];
      code: number;
      signal: string | null;
      stderr: string;
      cwd: string;
    },
  ) {
    super(message);
    this.name = 'GitError';
    this.argv = d.argv;
    this.code = d.code;
    this.signal = d.signal;
    this.stderr = d.stderr;
    this.cwd = d.cwd;
  }
}

export class GitTimeoutError extends GitError {
  constructor(d: {
    argv: readonly string[];
    stderr: string;
    cwd: string;
    timeoutMs: number;
  }) {
    super(`git timed out after ${String(d.timeoutMs)}ms: git ${d.argv.join(' ')}`, {
      argv: d.argv,
      code: -1,
      signal: 'SIGKILL',
      stderr: d.stderr,
      cwd: d.cwd,
    });
    this.name = 'GitTimeoutError';
  }
}

export interface GitRunOptions {
  readonly cwd?: string;
  readonly input?: Buffer | string;
  /**
   * Exit codes treated as success. Default `[0]`. `check-ignore` and
   * `rev-parse --verify --quiet` use 1 as a legitimate answer, not an error.
   */
  readonly allowCodes?: readonly number[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Extra `-c key=value` pairs, inserted after the fixed ones. */
  readonly config?: readonly string[];
  /** Merged over the base env. `GIT_INDEX_FILE` rides here. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Throw when stderr carries a `fatal:` line even though git exited inside
   * `allowCodes`. Defence in depth, not an observed git behaviour: several call
   * sites here widen `allowCodes` to accept 1 or 128 as legitimate answers, and
   * a widened code must not become a licence to parse output that git abandoned
   * halfway. (Measured: `check-ignore -z --stdin` on a submodule path exits 128
   * with its stdout truncated — the danger is a caller allowing 128, not git
   * lying about the code.) Default true.
   */
  readonly strictFatal?: boolean;
}

export interface GitRunResult {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly durationMs: number;
}

export type GitExec = (
  args: readonly string[],
  opts?: GitRunOptions,
) => Promise<GitRunResult>;

export interface CreateGitExecOptions {
  readonly cwd: string;
  readonly gitPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Every invocation is offered here, success or failure. Reports use it. */
  readonly recorder?: (record: GitCommandRecord) => void;
}

/** Env forced on every git process, over the caller's. */
function baseEnv(
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    ...inherited,
    // Never block on a credential prompt in CI or in a subagent.
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Stable, parseable messages regardless of the developer's locale.
    LC_ALL: 'C',
    LANG: 'C',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    // An inherited GIT_INDEX_FILE/GIT_DIR from a hook context would silently
    // retarget every command. The overlay sets these back, explicitly.
    GIT_INDEX_FILE: undefined,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
  };
}

const FATAL_RE = /^fatal:/m;

export function createGitExec(base: CreateGitExecOptions): GitExec {
  const gitPath = base.gitPath ?? 'git';
  const inherited = base.env ?? process.env;

  return function run(args, opts = {}): Promise<GitRunResult> {
    const cwd = opts.cwd ?? base.cwd;
    const timeoutMs = opts.timeoutMs ?? base.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    const maxOutputBytes =
      opts.maxOutputBytes ?? base.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const allow = opts.allowCodes ?? [0];
    const strictFatal = opts.strictFatal ?? true;
    const argv = [...FIXED_ARGS, ...(opts.config ?? []), ...args];
    const startedAt = Date.now();

    return new Promise<GitRunResult>((resolve, reject) => {
      const child = spawn(gitPath, argv, {
        cwd,
        env: { ...baseEnv(inherited), ...opts.env } as NodeJS.ProcessEnv,
        // Own process group so a timeout can take the transport helper
        // (ssh/git-remote-https) with it rather than orphaning it.
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      let overflow = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, timeoutMs);
      timer.unref();

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout.on('data', (c: Buffer) => {
        outBytes += c.length;
        if (outBytes > maxOutputBytes) {
          overflow = true;
          killGroup(child.pid);
          return;
        }
        outChunks.push(c);
      });
      child.stderr.on('data', (c: Buffer) => {
        // stderr is diagnostics only; cap it hard and keep the head, which is
        // where git puts the actual `fatal:`.
        if (errBytes < 64 * 1024) {
          errChunks.push(c);
          errBytes += c.length;
        }
      });

      child.on('error', (err: Error) => {
        finish(() => {
          reject(
            new GitError(`failed to spawn git: ${err.message}`, {
              argv,
              code: -1,
              signal: null,
              stderr: '',
              cwd,
            }),
          );
        });
      });

      child.on('close', (code, signal) => {
        const stdout = Buffer.concat(outChunks);
        const stderr = Buffer.concat(errChunks).toString('utf8');
        const durationMs = Date.now() - startedAt;
        const exit = code ?? -1;
        base.recorder?.({
          argv,
          cwd,
          code: exit,
          durationMs,
          stderrHead: stderr === '' ? null : (stderr.split('\n')[0] ?? null),
        });

        finish(() => {
          if (timedOut) {
            reject(new GitTimeoutError({ argv, stderr, cwd, timeoutMs }));
            return;
          }
          if (overflow) {
            reject(
              new GitError(
                `git produced more than ${String(maxOutputBytes)} bytes: git ${args.join(' ')}`,
                { argv, code: exit, signal: signal ?? null, stderr, cwd },
              ),
            );
            return;
          }
          if (!allow.includes(exit)) {
            reject(
              new GitError(
                `git exited ${String(exit)}: git ${args.join(' ')}\n${stderr.trim()}`,
                { argv, code: exit, signal: signal ?? null, stderr, cwd },
              ),
            );
            return;
          }
          if (strictFatal && FATAL_RE.test(stderr)) {
            reject(
              new GitError(
                `git reported a fatal error but exited ${String(exit)} — its output is ` +
                  `truncated and must not be parsed: git ${args.join(' ')}\n${stderr.trim()}`,
                { argv, code: exit, signal: signal ?? null, stderr, cwd },
              ),
            );
            return;
          }
          resolve({ argv, code: exit, stdout, stderr, durationMs });
        });
      });

      if (opts.input !== undefined) {
        child.stdin.on('error', () => {
          /* EPIPE when git exits before reading it all; the close handler wins. */
        });
        child.stdin.end(opts.input);
      } else {
        // EOF immediately: a git subcommand waiting on stdin must never hang.
        child.stdin.end();
      }
    });
  };
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Split NUL-framed git output. The trailing NUL produces a final empty field
 * which is dropped; an empty field anywhere else would be a git bug and is
 * preserved so a caller's length check can catch it.
 */
export function splitZ(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const s = buf.toString('utf8');
  const parts = s.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Split newline-framed output, dropping a single trailing newline. */
export function splitLines(buf: Buffer | string): string[] {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Bytewise path ordering. WHY not `Array.sort()` on strings: JS compares UTF-16
 * code units, so a path containing an astral character sorts differently from
 * the byte order git and every other tool uses. Reports must be byte-identical
 * across runs and platforms, so ordering is pinned here.
 */
export function sortPathsBytewise(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );
}
