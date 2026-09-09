import { afterEach, describe, expect, test } from 'vitest';

import { makeFixture, type Fixture } from './fixtures.test.js';
import {
  createGitExec,
  GitError,
  GitTimeoutError,
  splitZ,
  splitLines,
  sortPathsBytewise,
} from './exec.js';

const live: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

describe('createGitExec', () => {
  test('returns stdout as raw bytes, not a decoded string', async () => {
    const f = await fixture();
    await f.write('x.bin', 'a\0b\n');
    await f.commit('init');
    const exec = createGitExec({ cwd: f.dir });
    const r = await exec(['cat-file', 'blob', 'HEAD:x.bin']);
    expect(r.stdout.equals(Buffer.from('a\0b\n'))).toBe(true);
  });

  test('a disallowed exit code throws with the argv and stderr attached', async () => {
    const f = await fixture();
    await f.commit('init');
    const exec = createGitExec({ cwd: f.dir });
    const err = await exec(['rev-parse', '--verify', 'nope']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).not.toBe(0);
    expect((err as GitError).argv).toContain('rev-parse');
  });

  test('allowCodes turns a legitimate non-zero answer into a result', async () => {
    const f = await fixture();
    await f.write('.gitignore', '*.log\n');
    await f.commit('init');
    const exec = createGitExec({ cwd: f.dir });
    // check-ignore exits 1 for "not ignored" — an answer, not a failure.
    const r = await exec(['check-ignore', '-q', '--no-index', '--', 'a.txt'], {
      allowCodes: [0, 1],
    });
    expect(r.code).toBe(1);
  });

  test('ONE submodule path aborts a whole check-ignore batch (rc 128)', async () => {
    // This is why checkIgnore partitions submodule paths out BEFORE calling
    // git: the fatal takes the answers for every other path in the batch with
    // it, and stdout comes back empty rather than partially useful.
    const inner = await fixture();
    await inner.write('lib.rs', 'x\n');
    await inner.commit('inner');
    const outer = await fixture();
    await outer.write('README.md', 'x\n');
    await outer.commit('init');
    await outer.git(
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner.dir,
      'vendor/inner',
    );
    await outer.commit('add submodule');

    const exec = createGitExec({ cwd: outer.dir });
    const args = ['check-ignore', '-z', '--stdin'];
    const input = 'README.md\0vendor/inner/lib.rs\0more.txt\0';

    const err = await exec(args, { input, allowCodes: [0, 1] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe(128);
    expect((err as GitError).stderr).toMatch(/is in submodule/);

    // The damage: README.md's answer is gone too. Nothing came back at all.
    const loose = await exec(args, {
      input,
      allowCodes: [0, 1, 128],
      strictFatal: false,
    });
    expect(loose.stdout.length).toBe(0);
  });

  test('strictFatal refuses output git abandoned, even on an allowed code', async () => {
    // Defence in depth for the call sites that widen allowCodes to 1 or 128: a
    // widened code must not become a licence to parse a truncated stream.
    const f = await fixture();
    await f.commit('init');
    const exec = createGitExec({ cwd: f.dir });
    const alias = '!sh -c "echo data; echo fatal: synthetic >&2; exit 0"';
    await expect(exec(['-c', `alias.boom=${alias}`, 'boom'])).rejects.toThrow(
      /fatal error but exited/,
    );
    const loose = await exec(['-c', `alias.boom=${alias}`, 'boom'], {
      strictFatal: false,
    });
    expect(loose.code).toBe(0);
    expect(loose.stdout.toString('utf8')).toBe('data\n');
  });

  test('a timeout kills the process group and reports as a timeout', async () => {
    const f = await fixture();
    await f.commit('init');
    const exec = createGitExec({ cwd: f.dir });
    const started = Date.now();
    const err = await exec(['-c', 'alias.slow=!sleep 30', 'slow'], {
      timeoutMs: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitTimeoutError);
    // It really died; it did not sit out the full 30 seconds.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('output over the cap is refused rather than silently truncated', async () => {
    const f = await fixture();
    await f.write('big.txt', 'x'.repeat(200_000));
    await f.commit('init');
    const exec = createGitExec({ cwd: f.dir });
    await expect(
      exec(['cat-file', 'blob', 'HEAD:big.txt'], { maxOutputBytes: 1024 }),
    ).rejects.toThrow(/more than 1024 bytes/);
  });

  test('every invocation is offered to the recorder, failures included', async () => {
    const f = await fixture();
    await f.commit('init');
    const seen: string[] = [];
    const exec = createGitExec({
      cwd: f.dir,
      recorder: (r) => seen.push(`${r.argv.join(' ')} -> ${String(r.code)}`),
    });
    await exec(['rev-parse', 'HEAD']);
    await exec(['rev-parse', '--verify', '--quiet', 'nope'], { allowCodes: [0, 1] });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatch(/-> 1$/);
  });

  test('a user gitconfig cannot redirect what the core sees', async () => {
    // diff.external alone can replace every diff this tool reads with arbitrary
    // output, so the fixed -c overrides are part of the contract.
    const f = await fixture();
    await f.write('x.ts', 'a\n');
    await f.commit('init');
    await f.git('config', 'diff.external', 'echo HIJACKED');
    await f.write('x.ts', 'b\n');
    const exec = createGitExec({ cwd: f.dir });
    const r = await exec(['diff', '--no-ext-diff', 'HEAD', '--', 'x.ts'], {
      allowCodes: [0, 1],
    });
    expect(r.stdout.toString('utf8')).not.toMatch(/HIJACKED/);
    expect(r.stdout.toString('utf8')).toMatch(/^\+b$/m);
  });
});

describe('framing helpers', () => {
  test('splitZ drops only the trailing empty field', () => {
    expect(splitZ(Buffer.from('a\0b\0'))).toEqual(['a', 'b']);
    expect(splitZ(Buffer.from(''))).toEqual([]);
    // An empty field in the MIDDLE is preserved so a length check can catch it.
    expect(splitZ(Buffer.from('a\0\0b\0'))).toEqual(['a', '', 'b']);
  });

  test('splitLines drops a single trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
  });

  test('sortPathsBytewise orders by UTF-8 bytes, not UTF-16 code units', () => {
    // U+FF5E sorts after U+1F600 in UTF-16 (surrogates) but before it in UTF-8.
    const paths = ['\u{1F600}.txt', '～.txt', 'a.txt'];
    expect(sortPathsBytewise(paths)).toEqual(['a.txt', '～.txt', '\u{1F600}.txt']);
    expect([...paths].sort()).not.toEqual(sortPathsBytewise(paths));
  });
});
