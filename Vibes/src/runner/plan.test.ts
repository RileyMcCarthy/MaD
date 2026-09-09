/**
 * ResolvedConfig → an executable plan.
 *
 * Built against a REAL resolved config over a REAL repo, because the plan's job
 * is to translate one module's vocabulary into another's, and a hand-written
 * `ResolvedConfig` literal would only prove that I can restate my own
 * assumptions.
 *
 * The property that matters most here: a producer that will NOT run this
 * invocation still appears in the plan, with `selected: false` and a reason. A
 * plan that simply omitted it would let a component vanish from the report and
 * read as silence — and silence reads as "fine".
 */

import { afterEach, describe, expect, test } from 'vitest';

import { resolveConfig, type ResolvedConfig } from '../config/index.js';
import { openRepo } from '../git/index.js';
import { makeRunnerFixture, type RunnerFixture } from './fixtures.test.js';
import { buildPlan, checkTierBudget, totalsByTier, type ProducerTask } from './plan.js';

const live: RunnerFixture[] = [];
async function fixture(): Promise<RunnerFixture> {
  const f = await makeRunnerFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

const ROOT_CONFIG = `export default {
  version: 1,
  baseRef: 'origin/main',
  report: { out: '.vibes/report', formats: ['md', 'json'] },
  components: [
    { id: 'gen', root: 'Gen', generates: ['App/src/generated/**'] },
    { id: 'app', root: 'App', dependsOn: ['gen'] },
  ],
};
`;

const APP_MANIFEST = `export default {
  component: 'app',
  witnesses: ['src/**'],
  producers: [
    { name: 'domain', cmd: 'node emit.mjs', out: 'snapshots/domain', ciJob: 'vibes', minCases: 2 },
    { name: 'wire', cmd: 'node wire.mjs', out: 'snapshots/wire', ciJob: 'vibes', resources: ['sil-emulator'] },
  ],
};
`;

const GEN_MANIFEST = `export default {
  component: 'gen',
  witnesses: ['src/**'],
  producers: [
    { name: 'codegen', cmd: 'node gen.mjs', out: 'snapshots/codegen', ciJob: 'vibes' },
  ],
};
`;

async function resolved(
  f: RunnerFixture,
  extra: Readonly<Record<string, string>> = {},
): Promise<ResolvedConfig> {
  await f.write('.gitignore', '.vibes/*\n!.vibes/policy.lock.json\n');
  await f.write('vibes.config.mjs', ROOT_CONFIG);
  await f.write('App/vibes/vibes.manifest.mjs', APP_MANIFEST);
  await f.write('App/src/domain.ts', 'export const a = 1;\n');
  await f.write('App/src/generated/proto.ts', 'export const p = 1;\n');
  await f.write('Gen/vibes/vibes.manifest.mjs', GEN_MANIFEST);
  await f.write('Gen/src/schema.yaml', 'x: 1\n');
  for (const [rel, body] of Object.entries(extra)) await f.write(rel, body);
  const head = await f.commit('init');
  const repo = await openRepo({ cwd: f.dir });
  return resolveConfig({
    repoRoot: f.dir,
    baseRef: 'HEAD',
    baseSha: head,
    headSha: head,
    git: repo,
  });
}

const byId = (tasks: readonly ProducerTask[]): Map<string, ProducerTask> =>
  new Map(tasks.map((t) => [t.id, t]));

describe('translation', () => {
  test('one task per producer, ids stable and sorted', async () => {
    const f = await fixture();
    const plan = await buildPlan(await resolved(f));
    expect(plan.tasks.map((t) => t.id)).toEqual(['app/domain', 'app/wire', 'gen/codegen']);
    expect(plan.ok).toBe(true);
  });

  test('the out dir is COMMITTED and the received dir is gitignored scratch', async () => {
    const f = await fixture();
    const plan = await buildPlan(await resolved(f));
    const t = byId(plan.tasks).get('app/domain');

    expect(t?.outRepo).toBe('App/vibes/snapshots/domain');
    expect(t?.receivedRepo).toBe('.vibes/received/app/domain');
    // The separation is the whole anti-gaming structure: a producer writes to
    // scratch, and only `vibes accept` writes the baseline.
    expect(t?.receivedDir).not.toContain('snapshots');
    expect(t?.baselineDir).toContain('App/vibes/snapshots/domain');
    expect(plan.outRepos).toEqual([
      'App/vibes/snapshots/domain',
      'App/vibes/snapshots/wire',
      'Gen/vibes/snapshots/codegen',
    ]);
  });

  test('a producer with no declared resources gets a per-component token', async () => {
    const f = await fixture();
    const plan = await buildPlan(await resolved(f));
    const tasks = byId(plan.tasks);
    // NOT the empty set. "Parallel with everything" means the first author who
    // adds an emulator producer silently corrupts every concurrent run;
    // serialising within a component is cheap and wrong in the safe direction.
    expect(tasks.get('app/domain')?.resources).toEqual(['component:app']);
    expect(tasks.get('app/wire')?.resources).toEqual(['sil-emulator']);
  });

  test('component dependsOn becomes producer-level ordering edges', async () => {
    const f = await fixture();
    const plan = await buildPlan(await resolved(f));
    const tasks = byId(plan.tasks);
    expect(tasks.get('app/domain')?.after).toEqual(['gen/codegen']);
    expect(tasks.get('gen/codegen')?.after).toEqual([]);
  });

  test('carries the manifest fields the runner and comparator need', async () => {
    const f = await fixture();
    const plan = await buildPlan(await resolved(f));
    const t = byId(plan.tasks).get('app/domain');
    expect(t?.minCases).toBe(2);
    expect(t?.ciJob).toBe('vibes');
    expect(t?.clean).toBe(true); // types.ts default: without it a deleted corpus entry is invisible
    expect(t?.timeoutMs).toBeGreaterThan(0);
    expect(t?.manifestRepo).toBe('App/vibes/vibes.manifest.mjs');
  });
});

describe('selection is recorded, never elided', () => {
  test('an omitted change set runs everything — the safe direction', async () => {
    // "Cannot tell" must not become "unchanged": that would mint verified
    // verdicts for producers that never executed.
    const f = await fixture();
    const plan = await buildPlan(await resolved(f));
    expect(plan.tasks.every((t) => t.selected)).toBe(true);
  });

  test('an explicit change set skips unchanged components WITH a reason', async () => {
    const f = await fixture();
    const config = await resolved(f);
    const plan = buildPlan(config, { changedComponents: new Set(['gen']) });
    const tasks = byId(plan.tasks);

    expect(tasks.get('gen/codegen')?.selected).toBe(true);
    // `app` consumes `App/src/generated/**`, which `gen` declares it generates,
    // so input-closure forcing raises it to runWhen:'always' and it can never
    // resolve to "skipped, unchanged".
    expect(tasks.get('app/domain')?.forcedAlways).toBe(true);
    expect(tasks.get('app/domain')?.runWhen).toBe('always');
    expect(tasks.get('app/domain')?.selected).toBe(true);
  });

  test('a component with no forcing and no change is skipped, and says why', async () => {
    const f = await fixture();
    const config = await resolved(f);
    const plan = buildPlan(config, { changedComponents: new Set(['app']) });
    const gen = byId(plan.tasks).get('gen/codegen');
    expect(gen?.selected).toBe(false);
    expect(gen?.notSelectedReason).toBe('unchanged');
    // Still present in the plan. A report that omitted it would read as silence.
    expect(plan.tasks.length).toBe(3);
  });
});

describe('lints', () => {
  test('flags shell syntax /bin/sh will reject on the runner', async () => {
    const f = await fixture();
    const config = await resolved(f, {
      'App/vibes/vibes.manifest.mjs': `export default {
        component: 'app',
        witnesses: ['src/**'],
        producers: [
          { name: 'domain', cmd: 'diff <(a) <(b) > "$VIBES_OUT_DIR/d.txt"', out: 'snapshots/domain', ciJob: 'vibes' },
        ],
      };`,
    });
    const plan = buildPlan(config);
    const hit = plan.findings.find((x) => x.code === 'V093_SH_PORTABILITY');
    expect(hit?.severity).toBe('warn');
    // A warning, not an error: it works on macOS and dies on Ubuntu, which is
    // a CI-only failure and the least debuggable kind — but it is still the
    // author's call.
    expect(plan.ok).toBe(true);
  });

  test('flags a selected producer with no CI job', async () => {
    const f = await fixture();
    const config = await resolved(f, {
      'Gen/vibes/vibes.manifest.mjs': `export default {
        component: 'gen',
        witnesses: ['src/**'],
        producers: [{ name: 'codegen', cmd: 'node gen.mjs', out: 'snapshots/codegen' }],
      };`,
    });
    const plan = buildPlan(config);
    const hit = plan.findings.find((x) => x.code === 'V04G_CIJOB_MISSING');
    // Its snapshots can only ever be `locally-accepted, never CI-verified`.
    expect(hit?.producer).toBe('codegen');
  });
});

describe('the tier wall-clock budget', () => {
  test('sums only SELECTED producers', async () => {
    const f = await fixture();
    const config = await resolved(f);
    // Nothing changed: `gen` is skipped, `app` is still forced (it consumes
    // generated input), so the selected sum drops by exactly one producer.
    const narrow = buildPlan(config, { changedComponents: new Set<string>() });
    const all = buildPlan(config);
    expect(narrow.tasks.filter((t) => t.selected).length).toBe(2);
    expect(totalsByTier(narrow.tasks)['pr']).toBeLessThan(totalsByTier(all.tasks)['pr'] ?? 0);
  });

  test('is OPT-IN: with no budget supplied, a default config is not flagged', async () => {
    // The default per-producer timeout is 600 s and the recommended pr budget is
    // also 600 s, so a default-on check would fire for any config with two
    // producers — and `VibesRootConfig` has no `tiers` block to turn it off.
    const f = await fixture();
    const plan = buildPlan(await resolved(f));
    expect(plan.findings.some((x) => x.code === 'V092_TIER_BUDGET')).toBe(false);
    expect(plan.ok).toBe(true);
    expect(checkTierBudget({ pr: 10_000_000 })).toEqual([]);
  });

  test('fires at PREFLIGHT rather than at minute 55 of a ten-minute gate', () => {
    const over = checkTierBudget({ pr: 900_000 }, { pr: 600_000 });
    expect(over[0]?.code).toBe('V092_TIER_BUDGET');
    expect(over[0]?.severity).toBe('error');
    expect(over[0]?.evidence.join(' ')).toContain('900000');

    expect(checkTierBudget({ pr: 500_000 }, { pr: 600_000 })).toEqual([]);
    // An infinite budget (the `manual` tier) never fires.
    expect(checkTierBudget({ manual: 10_000_000 })).toEqual([]);
  });

  test('an over-budget plan is not ok', async () => {
    const f = await fixture();
    const config = await resolved(f);
    const plan = buildPlan(config, { tierBudgetMs: { pr: 1 } });
    expect(plan.ok).toBe(false);
    expect(plan.findings.some((x) => x.code === 'V092_TIER_BUDGET')).toBe(true);
  });
});
