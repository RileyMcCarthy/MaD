/**
 * Everything that must be true BEFORE the first spawn.
 *
 * All-or-nothing by design: a run that cannot be compared should not be run at
 * all, because half a report costs the same CI minutes and teaches a reader to
 * trust a number that does not mean what it says.
 *
 * The `.gitignore` checks here run against REAL git. The exact behaviour they
 * pin — that `.vibes/` plus a `!` re-include silently disables self-governance
 * while `.vibes/*` plus the same re-include works — is the kind of thing a mock
 * would have agreed with either way.
 */

import { afterEach, describe, expect, test } from 'vitest';

import { openRepo } from '../git/index.js';
import { makeRunnerFixture, type RunnerFixture } from './fixtures.test.js';
import { preflight } from './preflight.js';
import type { RunPlan } from './plan.js';

const live: RunnerFixture[] = [];
async function fixture(): Promise<RunnerFixture> {
  const f = await makeRunnerFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

const EMPTY_PLAN: RunPlan = {
  tasks: [],
  outRepos: [],
  findings: [],
  tierTotals: {},
  ok: true,
};

const GOOD_IGNORE = '.vibes/*\n!.vibes/policy.lock.json\n';
const BROKEN_IGNORE = '.vibes/\n!.vibes/policy.lock.json\n';

const codes = (fs: readonly { code: string }[]): string[] => fs.map((f) => f.code);

describe('the managed .gitignore block', () => {
  test('the correct block passes both probes', async () => {
    const f = await fixture();
    await f.write('.gitignore', GOOD_IGNORE);
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const r = await preflight({ repo, plan: EMPTY_PLAN, env: {} });
    expect(codes(r.findings)).not.toContain('V091_GITIGNORE_BLOCK');
    expect(codes(r.findings)).not.toContain('V094_RECEIVED_NOT_IGNORED');
    expect(r.ok).toBe(true);
  });

  test('`.vibes/` with a negation kills self-governance, at ERROR severity', async () => {
    // VERIFIED: git never descends into an excluded DIRECTORY, so the `!`
    // re-include can never take effect. `git add` silently no-ops and
    // `git show <base>:.vibes/policy.lock.json` fails forever — the whole
    // self-governance layer dies without a single error being printed.
    const f = await fixture();
    await f.write('.gitignore', BROKEN_IGNORE);
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const r = await preflight({ repo, plan: EMPTY_PLAN, env: {} });
    const hit = r.findings.find((x) => x.code === 'V091_GITIGNORE_BLOCK');
    expect(hit?.severity).toBe('error');
    expect(hit?.fix).toContain('.vibes/*');
    expect(r.ok).toBe(false);
  });

  test('no vibes block at all means the received dir would pollute the worktree', async () => {
    const f = await fixture();
    await f.write('.gitignore', 'node_modules/\n');
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const r = await preflight({ repo, plan: EMPTY_PLAN, env: {} });
    expect(codes(r.findings)).toContain('V094_RECEIVED_NOT_IGNORED');
    // The lock is not ignored either, so THAT probe is silent — the two checks
    // are mirror images and only one fires here.
    expect(codes(r.findings)).not.toContain('V091_GITIGNORE_BLOCK');
  });
});

describe('recursion', () => {
  test('VIBES=1 in the ambient env means a producer is invoking Vibes', async () => {
    // Left alone, the inner run would wipe the outer run's received dirs
    // mid-flight and both reports would be fiction.
    const f = await fixture();
    await f.write('.gitignore', GOOD_IGNORE);
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const r = await preflight({
      repo,
      plan: EMPTY_PLAN,
      env: { VIBES: '1', VIBES_RUN_ID: 'outer-run' },
    });
    const hit = r.findings.find((x) => x.code === 'V090_RECURSION');
    expect(hit?.severity).toBe('error');
    expect(hit?.evidence.join(' ')).toContain('outer-run');
    expect(r.ok).toBe(false);
  });
});

describe('submodule cleanliness', () => {
  test('a dirty submodule aborts by default and can be downgraded', async () => {
    const f = await fixture();
    await f.write('.gitignore', GOOD_IGNORE);
    await f.write('.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ./nowhere\n');
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    // A synthesized status entry: building a real nested submodule for this
    // assertion would test git's submodule machinery, not the runner's policy.
    const status = [{ path: 'sub', index: ' ', worktree: 'M' }];
    const strict = await preflight({ repo, plan: EMPTY_PLAN, env: {}, status });
    const hit = strict.findings.find((x) => x.code === 'V086_SUBMODULE_DIRTY');
    expect(hit?.severity).toBe('error');
    expect(hit?.evidence.join(' ')).toContain('git -C sub status');
    expect(strict.ok).toBe(false);

    const lenient = await preflight({
      repo,
      plan: EMPTY_PLAN,
      env: {},
      status,
      abortOnDirtySubmodule: false,
    });
    expect(lenient.findings.find((x) => x.code === 'V086_SUBMODULE_DIRTY')?.severity).toBe('warn');
    expect(lenient.ok).toBe(true);
  });

  test('a clean tree with declared submodules is fine', async () => {
    const f = await fixture();
    await f.write('.gitignore', GOOD_IGNORE);
    await f.write('.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ./nowhere\n');
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const r = await preflight({ repo, plan: EMPTY_PLAN, env: {}, status: [] });
    expect(r.submodules).toContain('sub');
    expect(r.ok).toBe(true);
  });
});

describe('plan findings are carried through', () => {
  test('a plan-level error makes preflight refuse', async () => {
    const f = await fixture();
    await f.write('.gitignore', GOOD_IGNORE);
    await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });

    const r = await preflight({
      repo,
      plan: {
        ...EMPTY_PLAN,
        ok: false,
        findings: [
          {
            code: 'V092_TIER_BUDGET',
            severity: 'error',
            file: 'vibes.config.mjs',
            message: 'over budget',
            evidence: [],
            fix: 'lower it',
          },
        ],
      },
      env: {},
    });
    expect(codes(r.findings)).toContain('V092_TIER_BUDGET');
    expect(r.ok).toBe(false);
  });
});
