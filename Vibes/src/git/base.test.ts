import { afterEach, describe, expect, test } from 'vitest';

import { makeFixture, type Fixture } from './fixtures.test.js';
import { openRepo, EMPTY_TREE_SHA, type GitRepo } from './repo.js';
import { BaseUnresolvableError, branchOf, refCandidates, resolveBase } from './base.js';

const live: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

/** A linear history: base <- mid <- head, all on `main`. */
async function linear(): Promise<{
  f: Fixture;
  repo: GitRepo;
  first: string;
  mid: string;
  head: string;
}> {
  const f = await fixture();
  await f.write('a.txt', '1\n');
  const first = await f.commit('one');
  await f.write('a.txt', '2\n');
  const mid = await f.commit('two');
  await f.write('a.txt', '3\n');
  const head = await f.commit('three');
  const repo = await openRepo({ cwd: f.dir });
  return { f, repo, first, mid, head };
}

/** Never fetch, never touch the network, in every test. */
// NOTE: this deliberately does NOT pin `env`. It is spread LAST at most call
// sites, so an `env` here would clobber the environment a test set for itself.
// Every call must therefore pass its own `env` — including `env: {}` when it
// wants none. Inheriting process.env passes locally and fails in CI, where
// GITHUB_EVENT_NAME is set and resolveBase takes a different rung entirely.
const OFFLINE = { allowFetch: 'never' as const };
/** No ambient environment. Use when the test is about git state, not CI context. */
const NO_ENV = { env: {} as Record<string, string | undefined> };

describe('resolveBase — rung 1, explicit', () => {
  test('an explicit sha wins over everything and is exact', async () => {
    const { repo, first } = await linear();
    const r = await resolveBase({
      repo,
      baseRef: 'origin/main',
      explicit: first,
      env: { GITHUB_EVENT_NAME: 'pull_request' },
      ...OFFLINE,
    });
    expect(r).toMatchObject({ sha: first, source: 'explicit-sha', confidence: 'exact' });
  });

  test('VIBES_BASE_SHA is honoured, and VIBES_BASE_REF below it', async () => {
    const { repo, first, mid } = await linear();
    const bySha = await resolveBase({
      repo,
      baseRef: 'origin/main',
      env: { VIBES_BASE_SHA: first, VIBES_BASE_REF: mid },
      ...OFFLINE,
    });
    expect(bySha.sha).toBe(first);

    const byRef = await resolveBase({
      repo,
      baseRef: 'origin/main',
      env: { VIBES_BASE_REF: 'HEAD~1' },
      ...OFFLINE,
    });
    expect(byRef).toMatchObject({ sha: mid, source: 'explicit-ref' });
  });

  test('an explicit base that does not resolve THROWS — never substitutes', async () => {
    const { repo } = await linear();
    await expect(
      resolveBase({ repo, baseRef: 'origin/main', explicit: 'no-such-ref', ...OFFLINE, ...NO_ENV }),
    ).rejects.toBeInstanceOf(BaseUnresolvableError);
  });
});

describe('resolveBase — rung 2, pull_request', () => {
  test('uses HEAD^1 only when HEAD^2 also exists (the merge-ref guard)', async () => {
    const f = await fixture();
    await f.write('a.txt', 'base\n');
    const baseTip = await f.commit('base');
    await f.git('checkout', '-q', '-b', 'feature');
    await f.write('b.txt', 'feature\n');
    await f.commit('feature work');
    await f.git('checkout', '-q', 'main');
    await f.write('c.txt', 'more main\n');
    const mainTip = await f.commit('main moves on');
    // Simulate refs/pull/N/merge: a merge commit whose FIRST parent is the base.
    await f.git('merge', '--no-ff', '-q', '-m', 'merge', 'feature');

    const repo = await openRepo({ cwd: f.dir });
    const r = await resolveBase({
      repo,
      baseRef: 'origin/main',
      env: { GITHUB_EVENT_NAME: 'pull_request' },
      ...OFFLINE,
    });
    expect(r).toMatchObject({ source: 'pr-merge-parent', confidence: 'exact' });
    expect(r.sha).toBe(mainTip);
    expect(r.sha).not.toBe(baseTip);
  });

  test('falls to pull_request.base.sha when HEAD is not the merge ref', async () => {
    // A workflow checking out `pull_request.head.sha`: HEAD^1 resolves (it is
    // just the previous commit) but HEAD^2 does not. Without the HEAD^2 guard
    // this would silently report one commit as the whole PR.
    const { repo, first, mid } = await linear();
    const r = await resolveBase({
      repo,
      baseRef: 'origin/main',
      env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/fake/event.json' },
      readEventPayload: async () => ({ pull_request: { base: { sha: first } } }),
      ...OFFLINE,
    });
    expect(r).toMatchObject({ source: 'pr-base-sha', confidence: 'approximate' });
    expect(r.sha).toBe(first);
    expect(r.sha).not.toBe(mid);
    expect(r.warnings.map((w) => w.code)).toContain('base-pr-base-sha');
  });

  test('does NOT fall through to merge-base on a PR event', async () => {
    // merge-base against a merge commit yields the fork point, which shows the
    // reviewer other people's changes. Throwing is the specified behaviour.
    const { repo } = await linear();
    await expect(
      resolveBase({
        repo,
        baseRef: 'origin/main',
        env: { GITHUB_EVENT_NAME: 'pull_request' },
        ...OFFLINE,
      }),
    ).rejects.toBeInstanceOf(BaseUnresolvableError);
  });
});

describe('resolveBase — rung 3, push', () => {
  test('uses github.event.before when it resolves', async () => {
    const { repo, first } = await linear();
    const r = await resolveBase({
      repo,
      baseRef: 'origin/main',
      env: { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/fake' },
      readEventPayload: async () => ({ before: first }),
      ...OFFLINE,
    });
    expect(r).toMatchObject({ sha: first, source: 'push-before', confidence: 'exact' });
  });

  test('an all-zeros `before` (branch creation) falls to HEAD^', async () => {
    const { repo, mid } = await linear();
    const r = await resolveBase({
      repo,
      baseRef: 'origin/main',
      env: { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/fake' },
      readEventPayload: async () => ({ before: '0'.repeat(40) }),
      ...OFFLINE,
    });
    expect(r).toMatchObject({ sha: mid, source: 'first-parent', confidence: 'exact' });
  });

  test('a tag build uses HEAD^ rather than comparing HEAD to itself', async () => {
    const { repo, mid } = await linear();
    const r = await resolveBase({
      repo,
      baseRef: 'origin/main',
      env: { GITHUB_REF_TYPE: 'tag' },
      ...OFFLINE,
    });
    expect(r).toMatchObject({ sha: mid, source: 'first-parent' });
    expect(r.sameAsHead).toBe(false);
  });

  test('a push of the very first commit uses the empty tree', async () => {
    const f = await fixture();
    await f.write('a.txt', '1\n');
    await f.commit('one');
    const repo = await openRepo({ cwd: f.dir });
    const r = await resolveBase({
      repo,
      baseRef: 'origin/main',
      env: { GITHUB_EVENT_NAME: 'push' },
      ...OFFLINE,
    });
    expect(r).toMatchObject({ sha: EMPTY_TREE_SHA, source: 'empty-tree' });
  });
});

describe('resolveBase — rung 4, merge-base', () => {
  test('resolves a branch base through merge-base', async () => {
    const f = await fixture();
    await f.write('a.txt', '1\n');
    const forkPoint = await f.commit('one');
    await f.git('checkout', '-q', '-b', 'feature');
    await f.write('b.txt', 'x\n');
    await f.commit('feature');

    const repo = await openRepo({ cwd: f.dir });
    const r = await resolveBase({ repo, baseRef: 'main', ...OFFLINE, ...NO_ENV });
    expect(r).toMatchObject({ sha: forkPoint, source: 'merge-base', confidence: 'exact' });
    expect(r.resolvedRef).toBe('main');
  });

  test('an unresolvable base ref throws WITH the fetch-depth remediation', async () => {
    const { repo } = await linear();
    const err = await resolveBase({ repo, baseRef: 'origin/main', ...OFFLINE, ...NO_ENV }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BaseUnresolvableError);
    expect((err as BaseUnresolvableError).remediation).toMatch(/fetch-depth: 0/);
    // The ladder is reported so a report can show what was tried.
    expect((err as BaseUnresolvableError).ladder.some((s) => !s.ok)).toBe(true);
  });
});

describe('the sameAsHead hard gate', () => {
  test('base === HEAD is reported, not silently green', async () => {
    // Push to main: `merge-base main main` is the tip. A zero-diff all-green
    // report about nothing is the failure mode this gate exists for.
    const { repo, head } = await linear();
    const r = await resolveBase({ repo, baseRef: 'HEAD', explicit: 'HEAD', ...OFFLINE, ...NO_ENV });
    expect(r.sha).toBe(head);
    expect(r.sameAsHead).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('base-same-as-head');
  });
});

describe('unborn HEAD', () => {
  test('resolves to the empty tree before any other rung is tried', async () => {
    const f = await fixture();
    await f.write('a.txt', 'x\n');
    const repo = await openRepo({ cwd: f.dir });
    const r = await resolveBase({
      repo,
      baseRef: 'origin/main',
      env: { GITHUB_EVENT_NAME: 'pull_request' },
      ...OFFLINE,
    });
    expect(r).toMatchObject({ sha: EMPTY_TREE_SHA, source: 'empty-tree' });
    expect(r.sameAsHead).toBe(false);
  });
});

describe('requireExact', () => {
  test('aborts on an approximate result rather than reporting one', async () => {
    const { repo, first } = await linear();
    await expect(
      resolveBase({
        repo,
        baseRef: 'origin/main',
        env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/fake' },
        readEventPayload: async () => ({ pull_request: { base: { sha: first } } }),
        requireExact: true,
        ...OFFLINE,
      }),
    ).rejects.toBeInstanceOf(BaseUnresolvableError);
  });
});

describe('ref candidates', () => {
  test('expands the spellings a base ref might actually have', () => {
    expect(refCandidates('origin/main', {}, 'origin')).toEqual([
      'origin/main',
      'refs/remotes/origin/main',
      'refs/remotes/origin/HEAD',
    ]);
    expect(refCandidates('main', { GITHUB_BASE_REF: 'release' }, 'origin')).toEqual([
      'main',
      'refs/remotes/main',
      'origin/main',
      'refs/heads/main',
      'origin/release',
      'refs/remotes/origin/release',
      'refs/remotes/origin/HEAD',
    ]);
  });

  test('branchOf strips every remote spelling', () => {
    expect(branchOf('origin/main', 'origin')).toBe('main');
    expect(branchOf('refs/remotes/origin/main', 'origin')).toBe('main');
    expect(branchOf('refs/heads/main', 'origin')).toBe('main');
    expect(branchOf('main', 'origin')).toBe('main');
  });
});

describe('fetch policy', () => {
  test("'ci' does not fetch outside CI, and the failure is honest", async () => {
    const { repo } = await linear();
    const commands: string[] = [];
    await resolveBase({
      repo,
      baseRef: 'origin/main',
      allowFetch: 'ci',
      env: {},
      recorder: (r) => commands.push(r.argv.join(' ')),
    }).catch(() => undefined);
    expect(commands.some((c) => c.includes('fetch'))).toBe(false);
  });
});
