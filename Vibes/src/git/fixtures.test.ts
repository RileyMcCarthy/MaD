/**
 * Throwaway-repo fixtures.
 *
 * Every git claim in the specs was verified by EXECUTING it, and that is why
 * they held up. These tests do the same: real `git init`, real commits, real
 * `.gitignore` files. Mocking git would only test my belief about git, and the
 * whole point of this module is that my beliefs about git were wrong three
 * times before the code was written.
 *
 * (This file carries a self-test so vitest, which is pointed at `*.test.ts`,
 * does not report it as a suite with no tests.)
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const exec = promisify(execFile);

export interface Fixture {
  readonly dir: string;
  git(...args: string[]): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  commit(message: string): Promise<string>;
  head(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function makeFixture(): Promise<Fixture> {
  // realpath: on macOS $TMPDIR is under /var -> /private/var, and every
  // containment check in this module compares realpath'd absolute paths.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vibes-git-')));

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await exec('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'vibes',
        GIT_AUTHOR_EMAIL: 'vibes@example.invalid',
        GIT_COMMITTER_NAME: 'vibes',
        GIT_COMMITTER_EMAIL: 'vibes@example.invalid',
        // Fixed timestamps keep commit shas reproducible across runs.
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
    async commit(message) {
      await git('add', '-A');
      await git('commit', '-q', '-m', message, '--allow-empty');
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async head() {
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('fixture builds a real repo with a real commit', async () => {
  const f = await makeFixture();
  try {
    await f.write('a.txt', 'hello\n');
    const sha = await f.commit('first');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await f.git('ls-files')).trim()).toBe('a.txt');
  } finally {
    await f.cleanup();
  }
});
