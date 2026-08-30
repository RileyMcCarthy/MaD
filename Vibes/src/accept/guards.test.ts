/**
 * The eight refusals.
 *
 * Each one must exit non-zero and write NOTHING, so these tests assert on the
 * refusal set alone — `run.test.ts` proves that a refusal really does leave the
 * tree untouched. Refusals 7 and the unmerged-index addition are checked
 * against a REAL working tree, because both are claims about `git status`
 * output whose exact shape has bitten this design before.
 */

import { afterEach, describe, expect, test } from 'vitest';

import type { RepoPath, Sha } from '../types.js';
import type { StatusEntry } from '../git/index.js';
import { DEFAULT_ACCEPT_OPTIONS, type AcceptOptions } from './model.js';
import { buildPlan, selectTargets } from './plan.js';
import { checkRefusals, isCiEnv, type AcceptGitPort, type GuardInput } from './guards.js';
import type { DoctorAttestation } from './doctor.js';
import { DOCTOR_ATTESTATION_SCHEMA } from './doctor.js';
import {
  baseFacts,
  makeFixture,
  sha256,
  snap,
  target,
  type AcceptFixture,
} from './fixtures.test.js';

const HEAD: Sha = 'b'.repeat(40);

const live: AcceptFixture[] = [];
async function fixture(): Promise<AcceptFixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

function cleanGit(over: Partial<AcceptGitPort> = {}): AcceptGitPort {
  return {
    async status(): Promise<readonly StatusEntry[]> {
      return [];
    },
    async unmergedPaths(): Promise<readonly RepoPath[]> {
      return [];
    },
    ...over,
  };
}

interface InputInit {
  readonly f: AcceptFixture;
  readonly targets?: ReturnType<typeof target>[];
  readonly options?: Partial<AcceptOptions>;
  readonly env?: Record<string, string | undefined>;
  readonly isTTY?: boolean;
  readonly git?: AcceptGitPort;
  readonly attestation?: DoctorAttestation | null;
  readonly base?: ReturnType<typeof baseFacts>;
  readonly reportBaseSha?: Sha;
  readonly reportHeadSha?: Sha;
}

function input(init: InputInit): GuardInput {
  const options: AcceptOptions = { ...DEFAULT_ACCEPT_OPTIONS, ...init.options };
  const targets = init.targets ?? [target(init.f, { files: [snap({ file: 'a.gcode' })] })];
  const selection = selectTargets(targets, options);
  const base = init.base ?? baseFacts();
  return {
    base,
    headSha: HEAD,
    reportBaseSha: init.reportBaseSha ?? base.sha,
    reportHeadSha: init.reportHeadSha ?? HEAD,
    plan: buildPlan(selection.selected),
    selection,
    options,
    env: init.env ?? {},
    isTTY: init.isTTY ?? true,
    git: init.git ?? cleanGit(),
    attestation: init.attestation ?? null,
  };
}

function codes(rs: readonly { code: string }[]): string[] {
  return rs.map((r) => r.code);
}

describe('refusal 1 — CI', () => {
  test('is absolute, and short-circuits every other check', async () => {
    // Even a tree that would fail four other ways reports only this, because
    // nothing will be written whatever else we find. No --force, no override.
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        env: { CI: 'true' },
        options: { yes: true, bootstrap: true },
        targets: [target(f, { outcome: 'failed', files: [snap({ file: 'a' })] })],
        base: baseFacts({ sameAsHead: true }),
      }),
    );
    expect(codes(r)).toEqual(['ci-environment']);
    expect(r[0]?.remediation).toContain('no override');
  });

  test('CI=false / 0 / empty is how a laptop says "not CI"', () => {
    for (const v of [undefined, '', '0', 'false', 'no', 'off', 'FALSE']) {
      expect(isCiEnv({ CI: v })).toBe(false);
    }
    for (const v of ['1', 'true', 'yes', 'anything']) {
      expect(isCiEnv({ CI: v })).toBe(true);
    }
  });
});

describe('refusal 2 — the producer did not run ok', () => {
  test('a crashed producer\'s partial output is never a baseline', async () => {
    const f = await fixture();
    for (const outcome of ['failed', 'timedOut', 'spawnError', 'emptyOutput', 'blocked'] as const) {
      const r = await checkRefusals(
        input({ f, targets: [target(f, { outcome, files: [snap({ file: 'a' })] })] }),
      );
      expect(codes(r)).toContain('producer-not-ok');
      expect(r.find((x) => x.code === 'producer-not-ok')?.message).toContain(outcome);
    }
  });

  test('ok passes', async () => {
    const f = await fixture();
    expect(codes(await checkRefusals(input({ f })))).not.toContain('producer-not-ok');
  });
});

describe('refusal 3 — the base is not a usable comparison point', () => {
  test('sameAsHead means nothing was actually compared', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, base: baseFacts({ sameAsHead: true }) }));
    expect(codes(r)).toContain('base-not-exact');
    expect(r.find((x) => x.code === 'base-not-exact')?.message).toContain('there is no range');
  });

  test('an approximate base may be against the wrong tree', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({ f, base: baseFacts({ confidence: 'approximate', source: 'first-parent' }) }),
    );
    expect(codes(r)).toContain('base-not-exact');
    expect(r.find((x) => x.code === 'base-not-exact')?.remediation).toContain('fetch-depth: 0');
  });
});

describe('refusal 4 — deletions with no declared cause', () => {
  const del = (f: AcceptFixture, over = {}) =>
    target(f, { files: [snap({ file: 'gone.gcode', verdict: 'deleted' })], ...over });

  test('refused when no corpus source-of-truth changed in the same diff', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, targets: [del(f)] }));
    const d = r.find((x) => x.code === 'deletions-unauthorized');
    expect(d).toBeDefined();
    expect(d?.remediation).toContain('--accept-deletions=1');
    expect(d?.paths).toEqual([`${f.outRepo}/gone.gcode`]);
  });

  test('allowed with the exact count AND a reason, both recorded', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({ f, targets: [del(f)], options: { acceptDeletions: 1, reason: 'cases retired' } }),
    );
    expect(codes(r)).not.toContain('deletions-unauthorized');
  });

  test('a count that does not match refuses — you have to have LOOKED', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({ f, targets: [del(f)], options: { acceptDeletions: 7, reason: 'x' } }),
    );
    expect(r.find((x) => x.code === 'deletions-unauthorized')?.message).toContain(
      '--accept-deletions=7 but 1 file(s)',
    );
  });

  test('a count with no reason still refuses', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, targets: [del(f)], options: { acceptDeletions: 1 } }));
    expect(r.find((x) => x.code === 'deletions-unauthorized')?.message).toContain('requires --reason');
  });

  test('a corpus change in the same diff explains the deletion by itself', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        targets: [del(f, { corpusChangedPaths: ['Software/Control/vibes/producers/matrix.json'] })],
      }),
    );
    expect(codes(r)).not.toContain('deletions-unauthorized');
  });

  test('a stale --accept-deletions with nothing to delete is reported, not ignored', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, options: { acceptDeletions: 3, reason: 'x' } }));
    expect(r.find((x) => x.code === 'deletions-unauthorized')?.message).toContain(
      'no baseline file would be deleted',
    );
  });
});

describe('refusal 5 — the producer has never completed in CI', () => {
  test('refused by default, naming the job', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({ f, targets: [target(f, { everCIVerified: false, files: [snap({ file: 'a' })] })] }),
    );
    expect(r.find((x) => x.code === 'never-ci-verified')?.message).toContain('wasm-control-ci');
  });

  test('a producer with no declared CI job says so plainly', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        targets: [target(f, { everCIVerified: false, ciJob: null, files: [snap({ file: 'a' })] })],
      }),
    );
    expect(r.find((x) => x.code === 'never-ci-verified')?.message).toContain('declares no CI job');
  });

  test('--unverified-producer allows it, and that is what gets recorded', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        targets: [target(f, { everCIVerified: false, files: [snap({ file: 'a' })] })],
        options: { unverifiedProducer: true },
      }),
    );
    expect(codes(r)).not.toContain('never-ci-verified');
  });

  test('a producer with nothing to accept is not refused over CI history', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        targets: [
          target(f, {
            everCIVerified: false,
            files: [snap({ file: 'a', verdict: 'identical' })],
          }),
        ],
      }),
    );
    expect(codes(r)).not.toContain('never-ci-verified');
  });
});

describe('refusal 6 — --bootstrap inside a behaviour change', () => {
  const attested: DoctorAttestation = {
    schema: DOCTOR_ATTESTATION_SCHEMA,
    headSha: HEAD,
    producers: [
      { producer: 'control/domain', repeat: 3, runShas: ['t', 't', 't'], stable: true },
    ],
  };

  test('a changed witness path sends adoption to its own PR', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        options: { bootstrap: true, reason: 'adopting' },
        targets: [
          target(f, {
            hasBaseline: false,
            changedWitnessPaths: ['Software/Control/src/domain/gcode.ts'],
            files: [snap({ file: 'a', verdict: 'added' })],
          }),
        ],
        attestation: attested,
      }),
    );
    const b = r.find((x) => x.code === 'bootstrap-touches-witnesses');
    expect(b?.paths).toEqual(['Software/Control/src/domain/gcode.ts']);
    expect(b?.remediation).toContain('own PR');
  });

  test('a clean adoption branch with three agreeing doctor runs passes', async () => {
    const f = await fixture();
    await f.received('a', 'G0 X1\n');
    const r = await checkRefusals(
      input({
        f,
        options: { bootstrap: true, reason: 'adopting' },
        targets: [
          target(f, {
            hasBaseline: false,
            changedWitnessPaths: [],
            exercisedWitnessPaths: [],
            files: [snap({ file: 'a', verdict: 'added' })],
          }),
        ],
        attestation: attested,
      }),
    );
    expect(r).toEqual([]);
  });

  test('bootstrap without an attestation is refused', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        options: { bootstrap: true, reason: 'adopting' },
        targets: [
          target(f, {
            hasBaseline: false,
            changedWitnessPaths: [],
            files: [snap({ file: 'a', verdict: 'added' })],
          }),
        ],
      }),
    );
    expect(r.find((x) => x.code === 'bootstrap-not-attested')?.remediation).toContain('--repeat=3');
  });

  test('bootstrap over an existing baseline is an ordinary accept in a costume', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        options: { bootstrap: true, reason: 'x' },
        targets: [
          target(f, { hasBaseline: true, changedWitnessPaths: [], files: [snap({ file: 'a' })] }),
        ],
        attestation: attested,
      }),
    );
    expect(r.find((x) => x.code === 'bootstrap-has-baseline')?.message).toContain(
      'already contains committed baselines',
    );
  });

  test('a non-added file under --bootstrap means this is a comparison', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        options: { bootstrap: true, reason: 'x' },
        targets: [
          target(f, {
            hasBaseline: false,
            changedWitnessPaths: [],
            files: [snap({ file: 'a', verdict: 'different' })],
          }),
        ],
        attestation: attested,
      }),
    );
    expect(r.find((x) => x.code === 'bootstrap-has-baseline')?.message).toContain('not "added"');
  });
});

describe('refusal 7 — the baseline dir was hand-edited', () => {
  test('an unstaged modification under the out dir refuses, against a real tree', async () => {
    const f = await fixture();
    await f.baseline('a.gcode', 'G0 X1\n');
    await f.commit('init');
    await f.baseline('a.gcode', 'G0 X999\n'); // someone edited a snapshot by hand
    const repo = await f.repo();

    const r = await checkRefusals(input({ f, git: repo }));
    const d = r.find((x) => x.code === 'baseline-dir-dirty');
    expect(d).toBeDefined();
    expect(d?.paths).toEqual([`${f.outRepo}/a.gcode`]);
    expect(d?.remediation).toContain('git checkout --');
  });

  test('an untracked stray file under the out dir also refuses', async () => {
    const f = await fixture();
    await f.baseline('a.gcode', 'G0 X1\n');
    await f.commit('init');
    await f.baseline('stray.gcode', 'G0 X2\n');
    const r = await checkRefusals(input({ f, git: await f.repo() }));
    expect(r.find((x) => x.code === 'baseline-dir-dirty')?.message).toContain('1 untracked');
  });

  test('a STAGED earlier accept is fine — two producers in a row must work', async () => {
    const f = await fixture();
    await f.baseline('a.gcode', 'G0 X1\n');
    await f.commit('init');
    await f.baseline('a.gcode', 'G0 X2\n');
    await f.git('add', '-A');
    const r = await checkRefusals(input({ f, git: await f.repo() }));
    expect(codes(r)).not.toContain('baseline-dir-dirty');
  });

  test('changes OUTSIDE the out dir are not this check\'s business', async () => {
    const f = await fixture();
    await f.baseline('a.gcode', 'G0 X1\n');
    await f.write('Software/Control/src/domain/gcode.ts', 'export const a = 1;\n');
    await f.commit('init');
    await f.write('Software/Control/src/domain/gcode.ts', 'export const a = 2;\n');
    const r = await checkRefusals(input({ f, git: await f.repo() }));
    expect(codes(r)).not.toContain('baseline-dir-dirty');
  });

  test('a real conflicted index refuses, because a worktree diff hides it', async () => {
    // git reports a conflicted file as an ordinary `M` in a worktree diff, so
    // the run would have measured a half-merged tree and reported conflict
    // markers as behaviour. Only `unmergedPaths()` can see it.
    const f = await fixture();
    await f.write('src.txt', 'base\n');
    await f.commit('base');
    await f.git('checkout', '-q', '-b', 'other');
    await f.write('src.txt', 'theirs\n');
    await f.commit('theirs');
    await f.git('checkout', '-q', 'main');
    await f.write('src.txt', 'ours\n');
    await f.commit('ours');
    await f.git('merge', 'other').catch(() => undefined); // conflicts, exits 1

    const repo = await f.repo();
    expect((await repo.unmergedPaths()).length).toBeGreaterThan(0);
    const r = await checkRefusals(input({ f, git: repo }));
    expect(r.find((x) => x.code === 'unmerged-index')?.remediation).toContain('Finish the merge');
  });
});

describe('refusal 8 — a non-reviewed mode with no stated reason', () => {
  test('bulk without a reason is unattributable', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, options: { yes: true, all: true } }));
    const d = r.find((x) => x.code === 'reason-required');
    expect(d?.message).toContain('unattributable');
    expect(d?.remediation).toContain('recorded verbatim');
  });

  test('whitespace is not a reason', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, options: { yes: true, reason: '   ' } }));
    expect(codes(r)).toContain('reason-required');
  });

  test('a reviewed accept needs no reason', async () => {
    const f = await fixture();
    expect(codes(await checkRefusals(input({ f })))).not.toContain('reason-required');
  });

  test('a stated reason satisfies it', async () => {
    const f = await fixture();
    await f.received('a.gcode', 'G0 X1\n');
    const r = await checkRefusals(input({ f, options: { yes: true, reason: 'epsilon widened' } }));
    expect(r).toEqual([]);
  });
});

describe('additions', () => {
  test('non-TTY without --yes is an ERROR — non-interactive must be explicit', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, isTTY: false }));
    expect(r.find((x) => x.code === 'non-interactive-requires-yes')?.remediation).toContain(
      'mode: bulk',
    );
  });

  test('non-TTY with --dry-run is fine — it writes nothing anyway', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, isTTY: false, options: { dryRun: true } }));
    expect(codes(r)).not.toContain('non-interactive-requires-yes');
  });

  test('an unknown selector is a typo, not an empty selection', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, options: { producers: ['control/domian'] } }));
    expect(r.find((x) => x.code === 'unknown-target')?.message).toContain('control/domian');
  });

  test('a run report describing another tree is refused', async () => {
    const f = await fixture();
    const r = await checkRefusals(input({ f, reportHeadSha: 'f'.repeat(40) }));
    expect(r.find((x) => x.code === 'run-stale')?.remediation).toContain('Re-run');
  });

  test('an unsafe emitted path is refused rather than written', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({ f, targets: [target(f, { files: [snap({ file: '../escape.txt' })] })] }),
    );
    expect(r.find((x) => x.code === 'unsafe-path')?.paths?.[0]).toContain('..');
  });

  test('received bytes that no longer hash to what the report judged are refused', async () => {
    // The laundering path on the INPUT side: anything rewriting the received
    // dir between run and accept would get its bytes committed under a verdict
    // computed from different content.
    const f = await fixture();
    await f.received('a.gcode', 'G0 X2\n');
    const r = await checkRefusals(
      input({
        f,
        targets: [
          target(f, { files: [snap({ file: 'a.gcode', receivedSha256: sha256('something else') })] }),
        ],
      }),
    );
    expect(r.find((x) => x.code === 'received-mismatch')?.remediation).toContain('Re-run');
  });

  test('a received file that vanished is refused, not silently skipped', async () => {
    const f = await fixture();
    const r = await checkRefusals(
      input({ f, targets: [target(f, { files: [snap({ file: 'a.gcode' })] })] }),
    );
    expect(codes(r)).toContain('received-missing');
  });

  test('matching received bytes pass', async () => {
    const f = await fixture();
    await f.received('a.gcode', 'G0 X2\n');
    const r = await checkRefusals(
      input({
        f,
        targets: [
          target(f, { files: [snap({ file: 'a.gcode', receivedSha256: sha256('G0 X2\n') })] }),
        ],
      }),
    );
    expect(r).toEqual([]);
  });
});

describe('every refusal is collected in one pass', () => {
  test('a thoroughly broken invocation reports all of them at once', async () => {
    // A tool that refuses one reason at a time teaches people to fight it one
    // flag at a time.
    const f = await fixture();
    const r = await checkRefusals(
      input({
        f,
        options: { yes: true },
        isTTY: false,
        base: baseFacts({ sameAsHead: true }),
        targets: [
          target(f, {
            outcome: 'failed',
            everCIVerified: false,
            files: [snap({ file: 'a.gcode' })],
          }),
        ],
      }),
    );
    expect(new Set(codes(r))).toEqual(
      new Set([
        'producer-not-ok',
        'base-not-exact',
        'never-ci-verified',
        'reason-required',
        'received-missing',
      ]),
    );
  });
});
