/**
 * The producer environment.
 *
 * The one assertion that carries the whole design: `VIBES_OUT_DIR` cannot be
 * overridden by any layer. It is the write contract — a producer able to point
 * it at the committed baseline reintroduces in-place writes, and in-place writes
 * delete the accept step.
 */

import { mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { makeTempDir } from './fixtures.test.js';
import { buildProducerEnv, envDiff, injectedEnv, producerPath, type ProducerEnvContext } from './env.js';

const live: { cleanup(): Promise<void> }[] = [];
async function temp(): Promise<string> {
  const t = await makeTempDir('vibes-env-');
  live.push(t);
  return t.dir;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((t) => t.cleanup()));
});

function ctxFor(root: string): ProducerEnvContext {
  return {
    repoRoot: root,
    absRoot: join(root, 'Software', 'Control'),
    absVibesDir: join(root, 'Software', 'Control', 'vibes'),
    component: 'control',
    producer: 'domain',
    receivedDir: join(root, '.vibes', 'received', 'control', 'domain'),
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    runId: 'run-42',
    vibesVersion: '0.1.0',
    sourceDateEpoch: 1_577_836_800,
  };
}

const BASE_ENV: Readonly<Record<string, string | undefined>> = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/x',
  ELECTRON_RUN_AS_NODE: '1',
  npm_config_registry: 'https://example.invalid',
  npm_lifecycle_event: 'vibes',
  INIT_CWD: '/somewhere/else',
  TZ: 'America/New_York',
  UNDEFINED_ONE: undefined,
};

describe('the denylist', () => {
  test('strips ELECTRON_RUN_AS_NODE — a documented, reproduced breakage in this repo', async () => {
    const root = await temp();
    const { env, stripped } = buildProducerEnv(ctxFor(root), [], BASE_ENV);
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(stripped).toContain('ELECTRON_RUN_AS_NODE');
  });

  test('strips npm_* and INIT_CWD, because Vibes is usually launched via `npm run`', async () => {
    const root = await temp();
    const { env } = buildProducerEnv(ctxFor(root), [], BASE_ENV);
    // A producer that reads these gets the PARENT invocation's paths, not its
    // own, which is a wrong answer that looks like a right one.
    expect(env['npm_config_registry']).toBeUndefined();
    expect(env['npm_lifecycle_event']).toBeUndefined();
    expect(env['INIT_CWD']).toBeUndefined();
    expect(env['HOME']).toBe('/Users/x');
  });

  test('drops variables whose value is undefined rather than stringifying them', async () => {
    const root = await temp();
    const { env } = buildProducerEnv(ctxFor(root), [], BASE_ENV);
    expect('UNDEFINED_ONE' in env).toBe(false);
  });
});

describe('layering', () => {
  test('the determinism floor is applied and is overridable by a producer', async () => {
    const root = await temp();
    const { env } = buildProducerEnv(ctxFor(root), [], BASE_ENV);
    expect(env['TZ']).toBe('UTC');
    expect(env['LC_ALL']).toBe('C');
    expect(env['NO_COLOR']).toBe('1');

    const overridden = buildProducerEnv(ctxFor(root), [{ TZ: 'Europe/Berlin' }], BASE_ENV);
    expect(overridden.env['TZ']).toBe('Europe/Berlin');
  });

  test('later layers win, and `null` means UNSET rather than empty', async () => {
    const root = await temp();
    const { env } = buildProducerEnv(
      ctxFor(root),
      [{ A: 'manifest', B: 'manifest' }, { A: 'producer', B: null }],
      BASE_ENV,
    );
    expect(env['A']).toBe('producer');
    // '' is a value most tools read as configured-but-blank; absence is the only
    // way to say "not set".
    expect('B' in env).toBe(false);
  });

  test('CI is never touched, in either direction', async () => {
    // Setting it flips vitest/insta/jest into never-write-snapshots mode;
    // unsetting it changes what a project's own scripts do. Either way Vibes
    // would be modifying the behaviour it claims to be observing.
    const root = await temp();
    const absent = buildProducerEnv(ctxFor(root), [], BASE_ENV);
    expect('CI' in absent.env).toBe(false);

    const present = buildProducerEnv(ctxFor(root), [], { ...BASE_ENV, CI: 'true' });
    expect(present.env['CI']).toBe('true');
  });
});

describe('injection', () => {
  test('$VIBES_OUT_DIR points at the gitignored received dir, never the baseline', async () => {
    const root = await temp();
    const ctx = ctxFor(root);
    const { env } = buildProducerEnv(ctx, [], BASE_ENV);
    expect(env['VIBES_OUT_DIR']).toBe(ctx.receivedDir);
    expect(env['VIBES_OUT_DIR']).toContain(join('.vibes', 'received'));
    expect(env['VIBES_COMPONENT']).toBe('control');
    expect(env['VIBES_PRODUCER']).toBe('domain');
    expect(env['VIBES']).toBe('1');
    expect(env['SOURCE_DATE_EPOCH']).toBe('1577836800');
  });

  test('a producer CANNOT redirect its own out dir, and is told so', async () => {
    const root = await temp();
    const ctx = ctxFor(root);
    const { env, overridden } = buildProducerEnv(
      ctx,
      [{ VIBES_OUT_DIR: join(root, 'Software/Control/vibes/snapshots/domain'), VIBES: '0' }],
      BASE_ENV,
    );
    expect(env['VIBES_OUT_DIR']).toBe(ctx.receivedDir);
    expect(env['VIBES']).toBe('1');
    // Reported rather than silently applied: an author who wrote this deserves
    // to know it was ignored instead of debugging why nothing landed.
    expect(overridden).toEqual(['VIBES', 'VIBES_OUT_DIR']);
  });

  test('VIBES=1 doubles as the recursion guard', async () => {
    const root = await temp();
    expect(injectedEnv(ctxFor(root))['VIBES']).toBe('1');
  });
});

describe('PATH', () => {
  test('prepends exactly two dirs, each only when it exists, in order', async () => {
    const root = await temp();
    const ctx = ctxFor(root);
    const rootBin = join(ctx.absRoot, 'node_modules', '.bin');
    const vibesBin = join(ctx.absVibesDir, 'node_modules', '.bin');

    expect(producerPath(ctx, '/usr/bin')).toBe('/usr/bin');

    await mkdir(vibesBin, { recursive: true });
    expect(producerPath(ctx, '/usr/bin')).toBe([vibesBin, '/usr/bin'].join(delimiter));

    await mkdir(rootBin, { recursive: true });
    // No ancestor walk: npm's own rule climbs to <repoRoot>/node_modules/.bin,
    // then $HOME/node_modules/.bin, then /node_modules/.bin — outside the repo
    // entirely, so a binary could resolve from a machine the CI runner is not.
    expect(producerPath(ctx, '/usr/bin')).toBe([rootBin, vibesBin, '/usr/bin'].join(delimiter));
  });

  test('an empty inherited PATH does not produce a leading empty entry', async () => {
    const root = await temp();
    const ctx = ctxFor(root);
    await mkdir(join(ctx.absRoot, 'node_modules', '.bin'), { recursive: true });
    expect(producerPath(ctx, '')).toBe(join(ctx.absRoot, 'node_modules', '.bin'));
    expect(producerPath(ctx, undefined)).toBe(join(ctx.absRoot, 'node_modules', '.bin'));
  });

  test('a Windows-cased `Path` cannot shadow the PATH we just computed', async () => {
    const root = await temp();
    const ctx = ctxFor(root);
    const rootBin = join(ctx.absRoot, 'node_modules', '.bin');
    await mkdir(rootBin, { recursive: true });

    // Node exposes both spellings on Windows and resolves them
    // case-insensitively. A stale `Path` left behind would win the lookup and
    // silently discard the prepends.
    const { env } = buildProducerEnv(ctx, [], { Path: '/win/bin' });
    expect(env['PATH']).toBe([rootBin, '/win/bin'].join(delimiter));
    expect('Path' in env).toBe(false);
  });
});

describe('envDiff', () => {
  test('reports only what Vibes changed — the inherited env carries tokens', async () => {
    const root = await temp();
    const { env } = buildProducerEnv(ctxFor(root), [], { ...BASE_ENV, SECRET_TOKEN: 'hunter2' });
    const diff = envDiff(env, { ...BASE_ENV, SECRET_TOKEN: 'hunter2' });
    // A report is an artifact that gets uploaded; dumping the full environment
    // into it is a credential leak with a changelog.
    expect('SECRET_TOKEN' in diff).toBe(false);
    expect('HOME' in diff).toBe(false);
    expect(diff['TZ']).toBe('UTC');
    expect(diff['VIBES']).toBe('1');
  });
});
