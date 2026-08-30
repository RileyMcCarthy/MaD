/**
 * Throwaway repos and real child processes.
 *
 * This module spawns processes, deletes directories and takes filesystem locks.
 * None of those can be honestly tested against a mock of themselves: the whole
 * reason `detached: true` exists here is that Node's own `timeout` option
 * signals the direct child only, and a fake spawner would have agreed with the
 * wrong version just as readily as the right one. So the tests below use real
 * `git init`, real `/bin/sh`, real process groups and real `O_EXCL`.
 *
 * (Self-test at the bottom so vitest, which collects `*.test.ts`, does not
 * report this helper as a suite with no tests.)
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const exec = promisify(execFile);

export interface RunnerFixture {
  readonly dir: string;
  git(...args: string[]): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  mkdirp(rel: string): Promise<void>;
  commit(message: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function makeRunnerFixture(): Promise<RunnerFixture> {
  // realpath: on macOS $TMPDIR resolves /var -> /private/var, and every
  // containment check in this module compares realpath'd absolute paths. A
  // lexical comparison against the un-resolved path silently fails closed and
  // would make `assertSafeReceivedDir` reject its own scratch dir.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vibes-runner-')));

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

  return {
    dir,
    git,
    async write(rel, content) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    },
    async mkdirp(rel) {
      await mkdir(join(dir, rel), { recursive: true });
    },
    async commit(message) {
      await git('add', '-A');
      await git('commit', '-q', '-m', message, '--allow-empty');
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A bare temp dir, for the lock tests (which must live OUTSIDE any repo). */
export async function makeTempDir(prefix = 'vibes-tmp-'): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return { dir, cleanup: async (): Promise<void> => rm(dir, { recursive: true, force: true }) };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('the fixture builds a real repo with a real commit', async () => {
  const f = await makeRunnerFixture();
  try {
    await f.write('a.txt', 'hello\n');
    const sha = await f.commit('first');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await f.git('ls-files')).trim()).toBe('a.txt');
  } finally {
    await f.cleanup();
  }
});
