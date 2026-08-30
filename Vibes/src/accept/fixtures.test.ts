/**
 * Throwaway-repo fixtures for the accept tests.
 *
 * `accept` is the only thing in Vibes that writes a committed file, and every
 * one of its eight refusals is a claim about the state of a real working tree —
 * "the base is HEAD", "someone hand-edited a snapshot", "the index is
 * mid-merge". Those claims are only worth testing against real `git init`,
 * real commits and real `git status` output; a mocked GitPort would test my
 * beliefs about git, and the specs' whole method was that beliefs about git
 * are wrong until executed.
 *
 * (Carries a self-test so vitest, which globs `*.test.ts`, does not report a
 * suite with no tests.)
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import type { SnapState, SnapshotResult, VerdictKind } from '../types.js';
import { openRepo, type GitRepo } from '../git/index.js';
import type { AcceptDecision, AcceptTarget, Candidate } from './model.js';
import type { AcceptIo } from './interactive.js';
import type { BaseFacts } from './guards.js';

const exec = promisify(execFile);

/** The MaD layout from the specs, so the paths in failures read like real ones. */
export const OUT_REPO = 'Software/Control/vibes/snapshots/domain';
export const RECEIVED_REPO = '.vibes/received/control/domain';

export interface AcceptFixture {
  readonly dir: string;
  readonly outRepo: string;
  readonly baselineDir: string;
  readonly receivedDir: string;
  git(...args: string[]): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  read(rel: string): Promise<string>;
  exists(rel: string): Promise<boolean>;
  commit(message: string): Promise<string>;
  head(): Promise<string>;
  repo(): Promise<GitRepo>;
  /** Write a baseline snapshot file (committed side). */
  baseline(file: string, content: string): Promise<void>;
  /** Write a received snapshot file (gitignored side). */
  received(file: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function makeFixture(): Promise<AcceptFixture> {
  // realpath: on macOS $TMPDIR is /var/... -> /private/var/..., and `openRepo`
  // realpaths its root, so an unresolved path makes every containment compare
  // fail in a way that looks like a logic bug.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vibes-accept-')));

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await exec('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'vibes',
        GIT_AUTHOR_EMAIL: 'vibes@example.invalid',
        GIT_COMMITTER_NAME: 'vibes',
        GIT_COMMITTER_EMAIL: 'vibes@example.invalid',
        GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
        LC_ALL: 'C',
      },
    });
    return stdout;
  };

  await git('init', '-q', '-b', 'main', '.');
  await git('config', 'user.name', 'vibes');
  await git('config', 'user.email', 'vibes@example.invalid');
  await git('config', 'commit.gpgsign', 'false');

  const write = async (rel: string, content: string): Promise<void> => {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  };

  // The received dir is gitignored by construction — §5.1's physical layout is
  // what makes `git add -A` after a run stage nothing under the baseline.
  await write('.gitignore', '.vibes/\n');

  return {
    dir,
    outRepo: OUT_REPO,
    baselineDir: join(dir, ...OUT_REPO.split('/')),
    receivedDir: join(dir, ...RECEIVED_REPO.split('/')),
    git,
    write,
    async read(rel) {
      return readFile(join(dir, rel), 'utf8');
    },
    async exists(rel) {
      try {
        await readFile(join(dir, rel));
        return true;
      } catch {
        return false;
      }
    },
    async commit(message) {
      await git('add', '-A');
      await git('commit', '-q', '-m', message, '--allow-empty');
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async head() {
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async repo() {
      return openRepo({ cwd: dir });
    },
    async baseline(file, content) {
      await write(`${OUT_REPO}/${file}`, content);
    },
    async received(file, content) {
      await write(`${RECEIVED_REPO}/${file}`, content);
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/* ───────────────────────────── model builders ────────────────────────── */

export interface SnapInit {
  readonly file: string;
  readonly state?: SnapState;
  readonly verdict?: VerdictKind;
  readonly baselineSha256?: string | null;
  readonly receivedSha256?: string | null;
  readonly bytes?: number;
}

export function snap(init: SnapInit): SnapshotResult {
  const kind = init.verdict ?? 'different';
  const state: SnapState =
    init.state ??
    (kind === 'added'
      ? 'added'
      : kind === 'deleted'
        ? 'deleted'
        : kind === 'identical' || kind === 'equivalent'
          ? 'verified-unchanged'
          : 'changed');
  return {
    component: 'control',
    producer: 'domain',
    file: init.file,
    state,
    verdict: { kind, mode: 'exact' },
    baselineSha256: init.baselineSha256 ?? null,
    receivedSha256: init.receivedSha256 ?? null,
    receiptId: null,
    renderer: null,
    bytes: init.bytes ?? 0,
  };
}

export function target(f: AcceptFixture, over: Partial<AcceptTarget> = {}): AcceptTarget {
  return {
    component: 'control',
    producer: 'domain',
    outcome: 'ok',
    everCIVerified: true,
    ciJob: 'wasm-control-ci',
    baselineDir: f.baselineDir,
    receivedDir: f.receivedDir,
    outRepo: f.outRepo,
    files: [],
    changedWitnessPaths: ['Software/Control/src/domain/gcode.ts'],
    exercisedWitnessPaths: ['Software/Control/src/domain/gcode.ts'],
    corpusChangedPaths: [],
    hasBaseline: true,
    ...over,
  };
}

export function baseFacts(over: Partial<BaseFacts> = {}): BaseFacts {
  return {
    sha: 'a'.repeat(40),
    source: 'merge-base',
    confidence: 'exact',
    sameAsHead: false,
    ...over,
  };
}

/* ──────────────────────────────── fake io ────────────────────────────── */

export interface FakeIo extends AcceptIo {
  readonly out: string[];
  text(): string;
  /** Prompts that were issued but had no scripted answer left. */
  readonly starved: string[];
}

/**
 * A scripted terminal.
 *
 * When the script runs out, `question` returns null — EOF — rather than
 * looping forever. That mirrors a real pipe closing, and the review loop must
 * treat it as an abort, never as consent.
 */
export function fakeIo(answers: readonly string[] = [], isTTY = true): FakeIo {
  const queue = [...answers];
  const out: string[] = [];
  const starved: string[] = [];
  return {
    isTTY,
    out,
    starved,
    write(text) {
      out.push(text);
    },
    async question(prompt) {
      const next = queue.shift();
      if (next === undefined) {
        starved.push(prompt);
        return null;
      }
      return next;
    },
    close() {
      /* nothing to release */
    },
    text() {
      return out.join('');
    },
  };
}

export function decisionsOf(
  candidates: readonly Candidate[],
  d: AcceptDecision,
): ReadonlyMap<string, AcceptDecision> {
  return new Map(candidates.map((c) => [`${c.component}/${c.producer}:${c.file}`, d]));
}

test('fixture builds a real repo whose received dir is ignored', async () => {
  const f = await makeFixture();
  try {
    await f.baseline('a.gcode', 'G0 X1\n');
    await f.received('a.gcode', 'G0 X2\n');
    await f.commit('init');
    const tracked = (await f.git('ls-files')).trim().split('\n');
    expect(tracked).toContain(`${OUT_REPO}/a.gcode`);
    expect(tracked.some((p) => p.startsWith('.vibes/'))).toBe(false);
  } finally {
    await f.cleanup();
  }
});
