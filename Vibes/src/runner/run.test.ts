/**
 * Running the producers, end to end.
 *
 * Real repos, real `/bin/sh`, real `check-ignore`. The rule every assertion
 * here defends: ANY non-`ok` outcome invalidates a producer's ENTIRE output,
 * including the files that look fine, because "some of these bytes are
 * trustworthy" is not a claim anyone can check.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import type { CompareSpec } from '../types.js';
import { openRepo, type GitRepo } from '../git/index.js';
import { makeRunnerFixture, makeTempDir, type RunnerFixture } from './fixtures.test.js';
import { acquireLease, type LockOptions } from './locks.js';
import { runProducers, type ProducerRun } from './run.js';
import type { ProducerTask, RunPlan } from './plan.js';

const live: { cleanup(): Promise<void> }[] = [];
async function fixture(): Promise<RunnerFixture> {
  const f = await makeRunnerFixture();
  live.push(f);
  return f;
}
async function temp(): Promise<string> {
  const t = await makeTempDir('vibes-runlock-');
  live.push(t);
  return t.dir;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((t) => t.cleanup()));
});

const EXACT: CompareSpec = { kind: 'exact' };

interface TaskOverrides {
  readonly cmd?: string;
  readonly component?: string;
  readonly name?: string;
  readonly resources?: readonly string[];
  readonly after?: readonly string[];
  readonly minCases?: number | null;
  readonly clean?: boolean;
  readonly timeoutMs?: number;
  readonly selected?: boolean;
  readonly hasBaseline?: boolean;
  readonly absRoot?: string;
  readonly env?: Readonly<Record<string, string | null>>;
}

function makeTask(repoRoot: string, o: TaskOverrides = {}): ProducerTask {
  const component = o.component ?? 'app';
  const name = o.name ?? 'domain';
  const absRoot = o.absRoot ?? join(repoRoot, 'App');
  return {
    id: `${component}/${name}`,
    component,
    name,
    cmd: o.cmd ?? 'true',
    absCwd: absRoot,
    absRoot,
    absVibesDir: join(absRoot, 'vibes'),
    receivedDir: join(repoRoot, '.vibes', 'received', component, name),
    receivedRepo: `.vibes/received/${component}/${name}`,
    baselineDir: join(absRoot, 'vibes', 'snapshots', name),
    outRepo: `App/vibes/snapshots/${name}`,
    env: o.env ?? {},
    timeoutMs: o.timeoutMs ?? 20_000,
    clean: o.clean ?? true,
    tier: 'pr',
    ciJob: 'vibes',
    minCases: o.minCases ?? null,
    compare: EXACT,
    runWhen: 'always',
    forcedAlways: false,
    hasBaseline: o.hasBaseline ?? false,
    resources: o.resources ?? [`component:${component}`],
    after: o.after ?? [],
    selected: o.selected ?? true,
    notSelectedReason: null,
    manifestRepo: 'App/vibes/vibes.manifest.mjs',
  };
}

function planOf(tasks: readonly ProducerTask[]): RunPlan {
  return {
    tasks,
    outRepos: [...new Set(tasks.map((t) => t.outRepo))].sort(),
    findings: [],
    tierTotals: {},
    ok: true,
  };
}

async function baseRepo(extra: Readonly<Record<string, string>> = {}): Promise<{
  f: RunnerFixture;
  repo: GitRepo;
  head: string;
}> {
  const f = await fixture();
  await f.write('.gitignore', '.vibes/*\n!.vibes/policy.lock.json\n*.log\n*.tmp\n');
  await f.write('App/src/domain.ts', 'export const a = 1;\n');
  await f.write('App/vibes/vibes.manifest.mjs', 'export default {};\n');
  for (const [rel, body] of Object.entries(extra)) await f.write(rel, body);
  const head = await f.commit('init');
  return { f, repo: await openRepo({ cwd: f.dir }), head };
}

async function run(
  repo: GitRepo,
  head: string,
  tasks: readonly ProducerTask[],
  over: { concurrency?: number; lockDir?: string; lockWaitMs?: number } = {},
): Promise<readonly ProducerRun[]> {
  const report = await runProducers({
    repo,
    plan: planOf(tasks),
    runId: 'test-run',
    baseSha: head,
    headSha: head,
    vibesVersion: '0.1.0-test',
    concurrency: over.concurrency ?? 1,
    lockDir: over.lockDir ?? (await temp()),
    ...(over.lockWaitMs === undefined ? {} : { limits: { lockWaitMs: over.lockWaitMs } }),
  });
  return report.runs;
}

const codes = (r: ProducerRun): string[] => r.findings.map((x) => x.code);

/* ─────────────────────────── the happy path ──────────────────────────── */

describe('a producer that writes files', () => {
  test('lands in the GITIGNORED received dir, never in the committed baseline', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, { cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"; printf b > "$VIBES_OUT_DIR/b.txt"' }),
    ]);

    expect(r?.outcome).toBe('ok');
    expect(r?.trust).toBe('verified');
    expect(r?.result.emitted).toEqual(['a.txt', 'b.txt']);
    expect(existsSync(join(f.dir, '.vibes/received/app/domain/a.txt'))).toBe(true);
    // The committed baseline is opened O_RDONLY by `vibes run`. If a producer
    // could write there, `vibes accept` would no longer be the only writer and
    // the review step would be gone.
    expect(existsSync(join(f.dir, 'App/vibes/snapshots/domain'))).toBe(false);
    expect(r?.escapes).toEqual([]);
    expect(r?.findings).toEqual([]);
  }, 30_000);

  test('gets the injected environment and inherits nothing it should not', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, {
        cmd: 'printf "%s|%s|%s|%s" "$VIBES" "$VIBES_COMPONENT" "$VIBES_PRODUCER" "$TZ" > "$VIBES_OUT_DIR/env.txt"',
      }),
    ]);
    expect(r?.outcome).toBe('ok');
    const body = await readFile(join(f.dir, '.vibes/received/app/domain/env.txt'), 'utf8');
    expect(body).toBe('1|app|domain|UTC');
  }, 30_000);

  test('writes stdout and stderr under .vibes/logs, never into the out dir', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, { cmd: 'echo hello; echo problem 1>&2; printf x > "$VIBES_OUT_DIR/a.txt"' }),
    ]);
    expect(r?.result.stdoutPath).toBe('.vibes/logs/app/domain.out.log');
    expect(await readFile(join(f.dir, '.vibes/logs/app/domain.out.log'), 'utf8')).toBe('hello\n');
    expect(await readFile(join(f.dir, '.vibes/logs/app/domain.err.log'), 'utf8')).toBe('problem\n');
    // A log inside `out` would be swallowed by the repo-wide `*.log` rule and
    // then reported as a missing snapshot.
    expect(r?.result.emitted).toEqual(['a.txt']);
  }, 30_000);
});

/* ─────────────────────── outcomes that must not collapse ─────────────── */

describe('outcomes', () => {
  test('a nonzero exit is `failed`, and its output is invalidated wholesale', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, { cmd: 'printf good > "$VIBES_OUT_DIR/a.txt"; exit 7' }),
    ]);
    expect(r?.outcome).toBe('failed');
    expect(r?.trust).toBe('unverified');
    expect(r?.result.exitCode).toBe(7);
    // The file is still inventoried — the report shows what landed — but the
    // producer is not verified, so nothing downstream may call it unchanged.
    expect(r?.files.map((x) => x.file)).toEqual(['a.txt']);
  }, 30_000);

  test('exit 0 with zero files is `emptyOutput`, its own state', async () => {
    // This is the "point a producer at an empty directory" move. Reporting the
    // whole baseline as deleted instead would be the worst available outcome for
    // an honesty tool, and calling it `ok` would be a lie.
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [makeTask(f.dir, { cmd: 'echo did nothing' })]);
    expect(r?.outcome).toBe('emptyOutput');
    expect(r?.trust).toBe('unverified');
  }, 30_000);

  test('a timeout is `timedOut`, distinct from `failed`', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, { cmd: 'printf x > "$VIBES_OUT_DIR/a.txt"; sleep 30', timeoutMs: 400 }),
    ]);
    expect(r?.outcome).toBe('timedOut');
    expect(r?.result.durationMs).toBeLessThan(15_000);
  }, 30_000);

  test('`not-selected` never runs the command and carries its reason', async () => {
    const { repo, head, f } = await baseRepo();
    const marker = join(f.dir, 'ran.txt');
    const task = {
      ...makeTask(f.dir, { cmd: `printf x > "${marker}"` }),
      selected: false,
      notSelectedReason: 'unchanged' as const,
    };
    const [r] = await run(repo, head, [task]);

    expect(r?.outcome).toBe('not-selected');
    expect(existsSync(marker)).toBe(false);
    // The reason is mandatory: `not-selected` may never share a rendering with
    // `verified-unchanged`, and the renderer needs a sentence to print.
    expect(r?.result.warnings.join(' ')).toContain('unchanged');
  }, 30_000);

  test('a component root that has vanished is `not-discovered`', async () => {
    // An uninitialised submodule or a stale checkout. Never "unchanged".
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, { absRoot: join(f.dir, 'NotThere'), cmd: 'echo hi' }),
    ]);
    expect(r?.outcome).toBe('not-discovered');
  }, 30_000);
});

/* ──────────────────── the check that actually matters ────────────────── */

describe('gitignored output', () => {
  test('a produced run.log is invisible to git, and that fails the producer', async () => {
    // VERIFIED behaviour, and it is invisible to any directory-shaped check:
    // `App/vibes/snapshots/domain/` is NOT ignored, while
    // `App/vibes/snapshots/domain/run.log` IS, via a bare `*.log` at the repo
    // root. A baseline containing it would silently lose the file on commit and
    // then read as a deletion forever after.
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, { cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"; printf b > "$VIBES_OUT_DIR/run.log"' }),
    ]);

    expect(r?.ignoredOutput).toEqual(['App/vibes/snapshots/domain/run.log']);
    expect(r?.disqualifications).toContain('ignored-output');
    expect(codes(r as ProducerRun)).toContain('V046_OUT_IGNORED_FILE');
    // Loud: the producer is unverified even though it exited 0.
    expect(r?.outcome).toBe('failed');
    expect(r?.spawn?.code).toBe(0);
  }, 30_000);

  test('ordinary filenames in the same directory are clean', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, { cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"; printf b > "$VIBES_OUT_DIR/b.json"' }),
    ]);
    expect(r?.ignoredOutput).toEqual([]);
    expect(r?.outcome).toBe('ok');
  }, 30_000);
});

/* ─────────────────────────── the received dir ────────────────────────── */

describe('clean', () => {
  test('wiping is what makes a DELETED corpus entry visible', async () => {
    const { repo, head, f } = await baseRepo();
    const dir = join(f.dir, '.vibes/received/app/domain');
    await f.mkdirp('.vibes/received/app/domain');
    await writeFile(join(dir, 'removed-case.txt'), 'output of a case that no longer exists\n');

    const [r] = await run(repo, head, [makeTask(f.dir, { cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"' })]);
    expect(r?.result.emitted).toEqual(['a.txt']);
    expect(existsSync(join(dir, 'removed-case.txt'))).toBe(false);
  }, 30_000);

  test('clean:false keeps the stale file, and the deletion goes unnoticed', async () => {
    // Documenting the cost of the opt-out, not endorsing it.
    const { repo, head, f } = await baseRepo();
    const dir = join(f.dir, '.vibes/received/app/domain');
    await f.mkdirp('.vibes/received/app/domain');
    await writeFile(join(dir, 'removed-case.txt'), 'stale\n');

    const [r] = await run(repo, head, [
      makeTask(f.dir, { clean: false, cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"' }),
    ]);
    expect(r?.result.emitted).toEqual(['a.txt', 'removed-case.txt']);
  }, 30_000);
});

/* ──────────────────────────── the corpus floor ───────────────────────── */

describe('minCases, enforced both ways', () => {
  test('the declared floor is enforced', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, { minCases: 3, cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"' }),
    ]);
    expect(codes(r as ProducerRun)).toContain('V088_CORPUS_FLOOR');
    expect(r?.disqualifications).toContain('corpus-floor');
    expect(r?.outcome).toBe('failed');
  }, 30_000);

  test('emitting FEWER cases than the committed baseline is a shrink, whatever minCases says', async () => {
    // The declared floor alone is not a guard: the same agent that shrinks the
    // corpus can lower the number in the same PR. The monotonic comparison
    // against the baseline is the one that bites.
    const { repo, head, f } = await baseRepo({
      'App/vibes/snapshots/domain/a.txt': 'a\n',
      'App/vibes/snapshots/domain/b.txt': 'b\n',
      'App/vibes/snapshots/domain/c.txt': 'c\n',
    });
    const [r] = await run(repo, head, [
      makeTask(f.dir, { hasBaseline: true, cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"' }),
    ]);

    expect(r?.baselineCaseCount).toBe(3);
    expect(r?.caseCount).toBe(1);
    expect(codes(r as ProducerRun)).toContain('V097_CORPUS_SHRANK');
    expect(r?.disqualifications).toContain('corpus-shrank');
    expect(r?.outcome).toBe('failed');
  }, 30_000);

  test('emitting the same count as the baseline is fine', async () => {
    const { repo, head, f } = await baseRepo({
      'App/vibes/snapshots/domain/a.txt': 'a\n',
      'App/vibes/snapshots/domain/b.txt': 'b\n',
    });
    const [r] = await run(repo, head, [
      makeTask(f.dir, {
        hasBaseline: true,
        cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"; printf B > "$VIBES_OUT_DIR/b.txt"',
      }),
    ]);
    expect(r?.outcome).toBe('ok');
    expect(codes(r as ProducerRun)).not.toContain('V097_CORPUS_SHRANK');
  }, 30_000);

  test('a declared .vibes-selected narrows the expectation instead of firing 14 false deletions', async () => {
    // MaD's smoke lane emits a subset. Without this contract every CI run would
    // report the rest as deletions, and a permanent wall of false deletions is
    // exactly what disarms the real shrink signal.
    const { repo, head, f } = await baseRepo({
      'App/vibes/snapshots/domain/a.txt': 'a\n',
      'App/vibes/snapshots/domain/b.txt': 'b\n',
      'App/vibes/snapshots/domain/c.txt': 'c\n',
    });
    const [r] = await run(repo, head, [
      makeTask(f.dir, {
        hasBaseline: true,
        cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"; printf "a\\n" > "$VIBES_OUT_DIR/.vibes-selected"',
      }),
    ]);
    expect(r?.selectedIds).toEqual(['a']);
    expect(codes(r as ProducerRun)).not.toContain('V097_CORPUS_SHRANK');
    expect(r?.outcome).toBe('ok');
  }, 30_000);

  test('the census, when present, is what gets counted', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, {
        minCases: 3,
        cmd: `printf a > "$VIBES_OUT_DIR/all.json"; printf '{"producer":"domain","cases":["x","y","z"]}' > "$VIBES_OUT_DIR/_vibes-census.json"`,
      }),
    ]);
    // One emitted file, three declared cases: a producer that packs many cases
    // into one artifact is normal, and a file count would misjudge it.
    expect(r?.caseCount).toBe(3);
    expect(codes(r as ProducerRun)).not.toContain('V088_CORPUS_FLOOR');
    expect(r?.outcome).toBe('ok');
  }, 30_000);
});

/* ──────────────────────────── escaped writes ─────────────────────────── */

describe('writes outside the out dir', () => {
  test('mutating a tracked source file fails the producer', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, {
        cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"; printf "// touched\\n" >> "$VIBES_REPO_ROOT/App/src/domain.ts"',
      }),
    ]);
    expect(r?.escapes.map((e) => e.kind)).toEqual(['mutated-source']);
    expect(codes(r as ProducerRun)).toContain('V084_MUTATED_SOURCE');
    // The run measured a tree it also changed; nothing it reports is a
    // statement about the committed code.
    expect(r?.outcome).toBe('failed');
  }, 30_000);

  test('a new untracked file outside every out dir is a stray write', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, { cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"; printf x > "$VIBES_REPO_ROOT/scratch.txt"' }),
    ]);
    expect(r?.escapes.map((e) => e.kind)).toEqual(['stray-write']);
    expect(codes(r as ProducerRun)).toContain('V083_STRAY_WRITE');
  }, 30_000);

  test('writing into the COMMITTED baseline is caught — that is the accept step', async () => {
    const { repo, head, f } = await baseRepo({ 'App/vibes/snapshots/domain/a.txt': 'a\n' });
    const [r] = await run(repo, head, [
      makeTask(f.dir, {
        hasBaseline: true,
        cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"; printf tampered > "$VIBES_REPO_ROOT/App/vibes/snapshots/domain/a.txt"',
      }),
    ]);
    expect(r?.escapes.map((e) => e.kind)).toEqual(['baseline-write']);
    expect(codes(r as ProducerRun)).toContain('V085_CROSS_OUT');
    expect(r?.outcome).toBe('failed');
  }, 30_000);

  test('a well-behaved producer trips nothing', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [makeTask(f.dir, { cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"' })]);
    expect(r?.escapes).toEqual([]);
  }, 30_000);
});

/* ────────────────────────────── resources ────────────────────────────── */

describe('machine-scoped leases', () => {
  test('a lease held by another run makes the producer `blocked`, not a warning', async () => {
    const { repo, head, f } = await baseRepo();
    const lockDir = await temp();
    const opts: LockOptions = {
      lockDir,
      gitCommonDir: repo.gitCommonDir,
      runId: 'the-other-agent',
      staleLockMs: 3_600_000,
      waitMs: 0,
      pollMs: 5,
    };
    const foreign = await acquireLease('sil-emulator', opts);
    expect(foreign.ok).toBe(true);

    const marker = join(f.dir, 'ran.txt');
    const [r] = await run(
      repo,
      head,
      [makeTask(f.dir, { resources: ['sil-emulator'], cmd: `printf x > "${marker}"` })],
      // The real default waits 30 s for a foreign holder before giving up; a
      // test asserting the refusal should not pay for the patience.
      { lockDir, lockWaitMs: 0 },
    );

    // A producer that could not take the lease on the resource it declared has
    // NOT been verified. The command must not have run at all.
    expect(r?.outcome).toBe('blocked');
    expect(existsSync(marker)).toBe(false);
    expect(codes(r as ProducerRun)).toContain('V095_RESOURCE_HELD');
    expect(r?.findings[0]?.evidence.join(' ')).toContain('the-other-agent');
  }, 30_000);

  test('two producers sharing a token never overlap, even at concurrency 2', async () => {
    const { repo, head, f } = await baseRepo();
    // Each writes a marker, sleeps, then records whether the other was mid-flight.
    const body = (n: string): string =>
      `touch "$VIBES_REPO_ROOT/.vibes/busy"; sleep 0.3; ls "$VIBES_REPO_ROOT/.vibes" > "$VIBES_OUT_DIR/${n}.txt"; rm -f "$VIBES_REPO_ROOT/.vibes/busy"; printf ok >> "$VIBES_OUT_DIR/${n}.txt"`;
    const runs = await run(
      repo,
      head,
      [
        makeTask(f.dir, { name: 'one', resources: ['sil-emulator'], cmd: body('one') }),
        makeTask(f.dir, { name: 'two', resources: ['sil-emulator'], cmd: body('two') }),
      ],
      { concurrency: 2 },
    );
    expect(runs.every((r) => r.outcome === 'ok')).toBe(true);
    // Serialised: each saw the busy marker only from its own turn, so neither
    // observed the other still holding it at exit.
    expect(runs.map((r) => r.task.name).sort()).toEqual(['one', 'two']);
    for (const r of runs) expect(r.startedAt).toBeTypeOf('number');
    const [a, b] = [...runs].sort((x, y) => x.startedAt - y.startedAt);
    expect(a?.endedAt).toBeLessThanOrEqual((b?.startedAt ?? 0) + 50);
  }, 60_000);
});

/* ───────────────────────────── run bookkeeping ───────────────────────── */

describe('the run report', () => {
  test('records attribution mode, because concurrency makes stray writes unattributable', async () => {
    const { repo, head, f } = await baseRepo();
    const serial = await runProducers({
      repo,
      plan: planOf([makeTask(f.dir, { cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"' })]),
      runId: 'r',
      baseSha: head,
      headSha: head,
      vibesVersion: '0.1.0',
      concurrency: 1,
      lockDir: await temp(),
    });
    expect(serial.attribution).toBe('per-producer');
    expect(serial.allSelectedOk).toBe(true);

    const parallel = await runProducers({
      repo,
      plan: planOf([
        makeTask(f.dir, { name: 'one', cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"' }),
        makeTask(f.dir, { name: 'two', cmd: 'printf b > "$VIBES_OUT_DIR/b.txt"' }),
      ]),
      runId: 'r',
      baseSha: head,
      headSha: head,
      vibesVersion: '0.1.0',
      concurrency: 2,
      lockDir: await temp(),
    });
    // Degrading honestly beats inventing an attribution nobody can check.
    expect(parallel.attribution).toBe('run-level');
  }, 60_000);

  test('allSelectedOk is false as soon as one selected producer is not ok', async () => {
    const { repo, head, f } = await baseRepo();
    const report = await runProducers({
      repo,
      plan: planOf([
        makeTask(f.dir, { name: 'one', cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"' }),
        makeTask(f.dir, { name: 'two', cmd: 'exit 1' }),
      ]),
      runId: 'r',
      baseSha: head,
      headSha: head,
      vibesVersion: '0.1.0',
      lockDir: await temp(),
    });
    expect(report.allSelectedOk).toBe(false);
    // One bad producer never aborts the others.
    expect(report.runs.find((r) => r.task.name === 'one')?.outcome).toBe('ok');
  }, 60_000);

  test('everCIVerified defaults to false — locally accepted until proven otherwise', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [makeTask(f.dir, { cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"' })]);
    expect(r?.result.everCIVerified).toBe(false);
  }, 30_000);

  test('SOURCE_DATE_EPOCH comes from the HEAD commit, not the wall clock', async () => {
    // A producer that stamps a date then emits the SAME bytes on every re-run of
    // the same commit — the difference between a snapshot that churns on every
    // CI run and one that only moves when behaviour does.
    const { repo, head, f } = await baseRepo();
    const [first] = await run(repo, head, [
      makeTask(f.dir, { cmd: 'printf "%s" "$SOURCE_DATE_EPOCH" > "$VIBES_OUT_DIR/stamp.txt"' }),
    ]);
    const stamp = await readFile(join(f.dir, '.vibes/received/app/domain/stamp.txt'), 'utf8');
    expect(stamp).toBe('1577836800'); // the fixture's fixed commit date
    expect(first?.outcome).toBe('ok');
  }, 30_000);
});

/* ─────────────────────────── output shape faults ─────────────────────── */

describe('output shape', () => {
  test('a symlink in the out dir disqualifies the producer', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, {
        cmd: 'printf a > "$VIBES_OUT_DIR/a.txt"; ln -s "$VIBES_REPO_ROOT/App/src/domain.ts" "$VIBES_OUT_DIR/link.ts"',
      }),
    ]);
    // A link lets the comparator read bytes the producer never emitted.
    expect(codes(r as ProducerRun)).toContain('V098_SYMLINK_OUTPUT');
    expect(r?.outcome).toBe('failed');
  }, 30_000);

  test('two produced paths differing only by case disqualify the producer', async () => {
    const { repo, head, f } = await baseRepo();
    const [r] = await run(repo, head, [
      makeTask(f.dir, {
        cmd: 'printf a > "$VIBES_OUT_DIR/Case.txt"; printf b > "$VIBES_OUT_DIR/case.txt"',
      }),
    ]);
    // On APFS (and this repo sets core.ignorecase=true) one of them silently
    // disappears when the baseline is checked out. On the ubuntu runner both
    // survive, so the two platforms would disagree about the corpus.
    if ((r?.files.length ?? 0) > 1) {
      expect(codes(r as ProducerRun)).toContain('V099_CASE_COLLISION');
      expect(r?.outcome).toBe('failed');
    } else {
      // Case-insensitive filesystem: the second write clobbered the first, so
      // there is only one file and nothing to collide.
      expect(r?.files.length).toBe(1);
    }
  }, 30_000);
});
