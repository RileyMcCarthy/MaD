/**
 * `vibes accept`, end to end, against real repositories.
 *
 * Two properties are checked here that no unit test can establish:
 *
 * 1. A REFUSAL LEAVES THE TREE BYTE-IDENTICAL. Every refusal path asserts that
 *    the baseline file still holds its old content and that no receipt exists.
 *    "exits non-zero and writes nothing" is only worth stating if it is true of
 *    the filesystem, not of the return value.
 * 2. WHAT IT WRITES PARSES BACK. Every accepted receipt is read with the same
 *    parser the honesty check uses, and asked whether it vouches for the exact
 *    bytes now on disk. That round trip is the guardrail; if it ever breaks,
 *    every accepted snapshot reads `unreceipted-baseline` in the next run.
 */

import { afterEach, describe, expect, test } from 'vitest';

import type { Sha } from '../types.js';
import { EXIT_APPLY_FAILED, EXIT_OK, EXIT_QUIT, EXIT_REFUSED } from './model.js';
import { DEFAULT_ACCEPT_OPTIONS, type AcceptOptions, type AcceptTarget } from './model.js';
import { DOCTOR_ATTESTATION_SCHEMA, type DoctorAttestation } from './doctor.js';
import { parseReceiptFile, vouchesFor } from './receipt.js';
import { runAccept, type AcceptRunOutcome } from './run.js';
import {
  baseFacts,
  fakeIo,
  makeFixture,
  sha256,
  snap,
  target,
  type AcceptFixture,
  type FakeIo,
} from './fixtures.test.js';

const live: AcceptFixture[] = [];
async function fixture(): Promise<AcceptFixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

const OLD = 'G0 X1\n';
const NEW = 'G0 X2\n';

interface Scene {
  readonly f: AcceptFixture;
  readonly baseSha: Sha;
  readonly headSha: Sha;
}

/**
 * One committed baseline at `base`, a source change at HEAD, and a received
 * dir holding different bytes. The ordinary shape of a real accept.
 */
async function scene(files: Record<string, [string, string]> = { 'a.gcode': [OLD, NEW] }): Promise<Scene> {
  const f = await fixture();
  for (const [name, [old]] of Object.entries(files)) await f.baseline(name, old);
  await f.write('Software/Control/src/domain/gcode.ts', 'export const v = 1;\n');
  const baseSha = await f.commit('base');
  await f.write('Software/Control/src/domain/gcode.ts', 'export const v = 2;\n');
  const headSha = await f.commit('change');
  for (const [name, [, next]] of Object.entries(files)) await f.received(name, next);
  return { f, baseSha, headSha };
}

async function accept(
  s: Scene,
  over: {
    options?: Partial<AcceptOptions>;
    targets?: readonly AcceptTarget[];
    io?: FakeIo;
    env?: Record<string, string | undefined>;
    attestation?: DoctorAttestation | null;
    sameAsHead?: boolean;
  } = {},
): Promise<{ out: AcceptRunOutcome; io: FakeIo }> {
  const io = over.io ?? fakeIo([], true);
  const targets =
    over.targets ??
    [
      target(s.f, {
        files: [
          snap({
            file: 'a.gcode',
            baselineSha256: sha256(OLD),
            receivedSha256: sha256(NEW),
            bytes: NEW.length,
          }),
        ],
      }),
    ];
  const out = await runAccept({
    repoRoot: s.f.dir,
    targets,
    base: baseFacts({ sha: s.baseSha, sameAsHead: over.sameAsHead ?? false }),
    headSha: s.headSha,
    reportBaseSha: s.baseSha,
    reportHeadSha: s.headSha,
    options: { ...DEFAULT_ACCEPT_OPTIONS, ...over.options },
    git: await s.f.repo(),
    io,
    env: over.env ?? {},
    attestation: over.attestation ?? null,
  });
  return { out, io };
}

async function receiptOf(f: AcceptFixture) {
  const text = await f.read(`${f.outRepo}/.vibes-accept.json`);
  const parsed = parseReceiptFile(text);
  expect(parsed.errors).toEqual([]);
  return parsed.file!;
}

/* ─────────────────────────── the accepting path ──────────────────────── */

describe('a reviewed accept', () => {
  test('copies received over baseline and files a receipt that vouches for it', async () => {
    const s = await scene();
    const { out } = await accept(s, { io: fakeIo(['a']) });

    expect(out.exitCode).toBe(EXIT_OK);
    expect(await s.f.read(`${s.f.outRepo}/a.gcode`)).toBe(NEW);

    const file = await receiptOf(s.f);
    const r = file.receipts[0]!;
    expect(r.mode).toBe('reviewed');
    expect(r.acceptedBy).toBe('cli');
    expect(r.baseSha).toBe(s.baseSha);
    expect(r.headSha).toBe(s.headSha);
    expect(r.counts).toMatchObject({ changed: 1, accepted: 1, acceptRatio: 1 });
    // The round trip the honesty check performs.
    expect(vouchesFor(file.receipts, 'a.gcode', sha256(NEW))).toBe(r.id);
    expect(vouchesFor(file.receipts, 'a.gcode', sha256(OLD))).toBeNull();
  });

  test('records the sha of the bytes actually written, not the reported one', async () => {
    const s = await scene();
    const { out } = await accept(s, { io: fakeIo(['a']) });
    const written = await s.f.read(`${s.f.outRepo}/a.gcode`);
    expect(out.accepted[0]?.sha256).toBe(sha256(written));
    expect(out.accepted[0]?.previousSha256).toBe(sha256(OLD));
  });

  test('a rejected file is neither written nor vouched for', async () => {
    const s = await scene();
    const { out } = await accept(s, { io: fakeIo(['r']) });
    expect(out.exitCode).toBe(EXIT_OK);
    expect(out.counts.rejected).toBe(1);
    expect(await s.f.read(`${s.f.outRepo}/a.gcode`)).toBe(OLD);
    // Nothing moved, so no receipt: an empty one would be a diff hunk saying
    // "I ran the tool".
    expect(await s.f.exists(`${s.f.outRepo}/.vibes-accept.json`)).toBe(false);
  });

  test('identical and equivalent files are counted as skipped, never committed', async () => {
    const s = await scene();
    await s.f.received('noise.csv', 'x\n');
    const { out } = await accept(s, {
      io: fakeIo(['a']),
      targets: [
        target(s.f, {
          files: [
            snap({ file: 'a.gcode', baselineSha256: sha256(OLD), receivedSha256: sha256(NEW) }),
            snap({ file: 'noise.csv', verdict: 'equivalent' }),
          ],
        }),
      ],
    });
    expect(out.counts.skippedEquivalent).toBe(1);
    expect(await s.f.exists(`${s.f.outRepo}/noise.csv`)).toBe(false);
    const r = (await receiptOf(s.f)).receipts[0]!;
    expect(r.counts.skippedEquivalent).toBe(1);
    expect(r.entries.map((e) => e.file)).toEqual(['a.gcode']);
  });
});

describe('a blind --all --yes', () => {
  test('WORKS, and the receipt makes it obvious what happened', async () => {
    // The design goal is visible and attributable, NOT prevented.
    const s = await scene();
    const { out } = await accept(s, {
      options: { yes: true, all: true, reason: 'regenerated after the refactor' },
      io: fakeIo([], false), // no TTY either; --yes makes that explicit
    });

    expect(out.exitCode).toBe(EXIT_OK);
    expect(out.mode).toBe('bulk');
    expect(out.acceptedBy).toBe('--all');
    expect(await s.f.read(`${s.f.outRepo}/a.gcode`)).toBe(NEW);

    const r = (await receiptOf(s.f)).receipts[0]!;
    expect(r.mode).toBe('bulk');
    expect(r.acceptedBy).toBe('--all');
    expect(r.counts.acceptRatio).toBe(1);
    expect(r.reason).toBe('regenerated after the refactor');

    const bulk = out.findings.find((x) => x.id.startsWith('bulk-accept:'));
    expect(bulk?.alwaysExpanded).toBe(true);
    expect(bulk?.severity).toBe('warn');
  });
});

/* ──────────────────────── the refusals, on disk ──────────────────────── */

async function expectUntouched(f: AcceptFixture): Promise<void> {
  expect(await f.read(`${f.outRepo}/a.gcode`)).toBe(OLD);
  expect(await f.exists(`${f.outRepo}/.vibes-accept.json`)).toBe(false);
}

describe('refusals write nothing at all', () => {
  test('CI=true, with no override anywhere', async () => {
    const s = await scene();
    const { out, io } = await accept(s, {
      env: { CI: 'true' },
      options: { yes: true, all: true, reason: 'make the build green' },
    });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    expect(io.text()).toContain('REFUSED ci-environment');
    expect(io.text()).toContain('Nothing was written.');
    await expectUntouched(s.f);
  });

  test('a crashed producer', async () => {
    const s = await scene();
    const { out } = await accept(s, {
      io: fakeIo(['a']),
      targets: [
        target(s.f, {
          outcome: 'failed',
          files: [snap({ file: 'a.gcode', baselineSha256: sha256(OLD), receivedSha256: sha256(NEW) })],
        }),
      ],
    });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    await expectUntouched(s.f);
  });

  test('base === HEAD', async () => {
    const s = await scene();
    const { out } = await accept(s, { io: fakeIo(['a']), sameAsHead: true });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    await expectUntouched(s.f);
  });

  test('an unauthorised deletion', async () => {
    const s = await scene();
    await s.f.baseline('gone.gcode', 'G0 Z0\n');
    await s.f.commit('add a second baseline');
    const { out } = await accept(s, {
      io: fakeIo(['a', 'a']),
      targets: [
        target(s.f, {
          files: [
            snap({ file: 'a.gcode', baselineSha256: sha256(OLD), receivedSha256: sha256(NEW) }),
            snap({ file: 'gone.gcode', verdict: 'deleted', baselineSha256: sha256('G0 Z0\n') }),
          ],
        }),
      ],
    });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    await expectUntouched(s.f);
    expect(await s.f.read(`${s.f.outRepo}/gone.gcode`)).toBe('G0 Z0\n');
  });

  test('a producer CI has never run', async () => {
    const s = await scene();
    const { out } = await accept(s, {
      io: fakeIo(['a']),
      targets: [
        target(s.f, {
          everCIVerified: false,
          files: [snap({ file: 'a.gcode', baselineSha256: sha256(OLD), receivedSha256: sha256(NEW) })],
        }),
      ],
    });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    await expectUntouched(s.f);
  });

  test('a hand-edited baseline', async () => {
    const s = await scene();
    await s.f.baseline('a.gcode', 'G0 X-999\n'); // edited outside accept
    const { out } = await accept(s, { io: fakeIo(['a']) });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    expect(await s.f.read(`${s.f.outRepo}/a.gcode`)).toBe('G0 X-999\n');
    expect(await s.f.exists(`${s.f.outRepo}/.vibes-accept.json`)).toBe(false);
  });

  test('--yes with no reason', async () => {
    const s = await scene();
    const { out } = await accept(s, { options: { yes: true } });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    await expectUntouched(s.f);
  });

  test('a non-TTY with no --yes', async () => {
    const s = await scene();
    const { out } = await accept(s, { io: fakeIo([], false) });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    await expectUntouched(s.f);
  });

  test('a corrupt receipt file refuses rather than reading as "no receipts"', async () => {
    // Otherwise mangling the JSON is the cheapest way to erase an audit trail.
    const s = await scene();
    await s.f.write(`${s.f.outRepo}/.vibes-accept.json`, '{ not json');
    await s.f.commit('corrupt the receipt');
    const { out, io } = await accept(s, { io: fakeIo(['a']) });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    expect(io.text()).toContain('REFUSED receipt-corrupt');
    expect(await s.f.read(`${s.f.outRepo}/a.gcode`)).toBe(OLD);
  });
});

describe('the non-refusal exits that also write nothing', () => {
  test('q quits', async () => {
    const s = await scene();
    const { out, io } = await accept(s, { io: fakeIo(['q']) });
    expect(out.exitCode).toBe(EXIT_QUIT);
    expect(io.text()).toContain('Quit. Nothing was written.');
    await expectUntouched(s.f);
  });

  test('--dry-run prints the plan and stops', async () => {
    const s = await scene();
    const { out, io } = await accept(s, { options: { dryRun: true }, io: fakeIo([], false) });
    expect(out.exitCode).toBe(EXIT_OK);
    expect(io.text()).toContain(`different  ${s.f.outRepo}/a.gcode`);
    expect(io.text()).toContain('nothing was written');
    await expectUntouched(s.f);
  });

  test('nothing to accept says so, and says how many were skipped', async () => {
    const s = await scene();
    const { out, io } = await accept(s, {
      targets: [target(s.f, { files: [snap({ file: 'a.gcode', verdict: 'identical' })] })],
    });
    expect(out.exitCode).toBe(EXIT_OK);
    expect(io.text()).toContain('1 file(s) were identical or within tolerance');
    await expectUntouched(s.f);
  });
});

/* ──────────────────────────── deletions ──────────────────────────────── */

describe('an authorised deletion', () => {
  test('removes the file and records it in the receipt', async () => {
    const s = await scene();
    await s.f.baseline('gone.gcode', 'G0 Z0\n');
    await s.f.commit('add a second baseline');
    const { out } = await accept(s, {
      io: fakeIo(['a', 'a']),
      options: { acceptDeletions: 1, reason: 'case retired in matrix-catalog.json' },
      targets: [
        target(s.f, {
          corpusChangedPaths: ['Software/Control/vibes/producers/matrix-catalog.json'],
          files: [
            snap({ file: 'a.gcode', baselineSha256: sha256(OLD), receivedSha256: sha256(NEW) }),
            snap({ file: 'gone.gcode', verdict: 'deleted', baselineSha256: sha256('G0 Z0\n') }),
          ],
        }),
      ],
    });
    expect(out.exitCode).toBe(EXIT_OK);
    expect(out.counts.deleted).toBe(1);
    expect(await s.f.exists(`${s.f.outRepo}/gone.gcode`)).toBe(false);

    const r = (await receiptOf(s.f)).receipts[0]!;
    expect(r.deletions).toEqual([{ file: 'gone.gcode', previousSha256: sha256('G0 Z0\n') }]);
    expect(r.acceptDeletionsDeclared).toBe(1);
    expect(r.reason).toContain('retired');
    // A deletion is NOT an entry: `ReceiptEntry` requires a digest, and a
    // sentinel there would be a value the content scan could match against.
    expect(r.entries.map((e) => e.file)).toEqual(['a.gcode']);
  });
});

/* ──────────────────────────── bootstrap ──────────────────────────────── */

describe('--bootstrap', () => {
  async function adoptionScene(): Promise<Scene> {
    const f = await fixture();
    await f.write('Software/Control/src/domain/gcode.ts', 'export const v = 1;\n');
    const baseSha = await f.commit('base');
    const headSha = await f.commit('empty adoption commit');
    await f.received('a.gcode', NEW);
    await f.received('b.gcode', 'G0 Y2\n');
    return { f, baseSha, headSha };
  }

  function attested(headSha: Sha): DoctorAttestation {
    return {
      schema: DOCTOR_ATTESTATION_SCHEMA,
      headSha,
      producers: [
        { producer: 'control/domain', repeat: 3, runShas: ['t', 't', 't'], stable: true },
      ],
    };
  }

  function bootstrapTargets(f: AcceptFixture): AcceptTarget[] {
    return [
      target(f, {
        hasBaseline: false,
        changedWitnessPaths: [],
        exercisedWitnessPaths: [],
        files: [
          snap({ file: 'a.gcode', verdict: 'added', receivedSha256: sha256(NEW) }),
          snap({ file: 'b.gcode', verdict: 'added', receivedSha256: sha256('G0 Y2\n') }),
        ],
      }),
    ];
  }

  test('writes the first baselines, a .gitattributes and the doctor run shas', async () => {
    const s = await adoptionScene();
    const { out, io } = await accept(s, {
      options: { bootstrap: true, yes: true, reason: 'adopting vibes for the domain producer' },
      targets: bootstrapTargets(s.f),
      attestation: attested(s.headSha),
      io: fakeIo([], false),
    });

    expect(out.exitCode).toBe(EXIT_OK);
    expect(out.mode).toBe('bootstrap');
    expect(await s.f.read(`${s.f.outRepo}/a.gcode`)).toBe(NEW);
    expect(await s.f.read(`${s.f.outRepo}/.gitattributes`)).toContain('linguist-generated=true');

    const r = (await receiptOf(s.f)).receipts[0]!;
    expect(r.mode).toBe('bootstrap');
    expect(r.doctorRuns).toEqual(['t', 't', 't']);
    expect(r.reason).toContain('adopting');

    // §5.6: review must be PHYSICALLY POSSIBLE, so every added snapshot is
    // rendered even when nobody is watching.
    expect(io.text()).toContain('G0 X2');
    expect(io.text()).toContain('G0 Y2');
  });

  test('refuses when the same commit touches a witnessed source path', async () => {
    const s = await adoptionScene();
    const targets = bootstrapTargets(s.f).map((t) => ({
      ...t,
      changedWitnessPaths: ['Software/Control/src/domain/gcode.ts'],
    }));
    const { out } = await accept(s, {
      options: { bootstrap: true, yes: true, reason: 'adopting' },
      targets,
      attestation: attested(s.headSha),
      io: fakeIo([], false),
    });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    expect(await s.f.exists(`${s.f.outRepo}/a.gcode`)).toBe(false);
  });

  test('a nondeterministic producer cannot bootstrap at all', async () => {
    const s = await adoptionScene();
    const { out, io } = await accept(s, {
      options: { bootstrap: true, yes: true, reason: 'adopting' },
      targets: bootstrapTargets(s.f),
      attestation: {
        schema: DOCTOR_ATTESTATION_SCHEMA,
        headSha: s.headSha,
        producers: [
          { producer: 'control/domain', repeat: 3, runShas: ['t1', 't2', 't3'], stable: true },
        ],
      },
      io: fakeIo([], false),
    });
    expect(out.exitCode).toBe(EXIT_REFUSED);
    expect(io.text()).toContain('nondeterministic');
    expect(await s.f.exists(`${s.f.outRepo}/a.gcode`)).toBe(false);
  });
});

/* ─────────────────── the receipt log across two accepts ──────────────── */

describe('two accepts on one branch', () => {
  test('the second keeps the first alive while it is still load-bearing', async () => {
    // After accept #2, accept #1's bytes for an untouched file still differ
    // from <base> and nothing else vouches for them. Overwriting the log would
    // turn every multi-commit branch into a wall of unreceipted-baseline.
    const s = await scene({ 'a.gcode': [OLD, NEW], 'b.gcode': ['G0 Y1\n', 'G0 Y2\n'] });

    const first = await accept(s, {
      io: fakeIo(['a', 'r']), // accept a.gcode, reject b.gcode
    });
    expect(first.out.exitCode).toBe(EXIT_OK);
    const firstId = (await receiptOf(s.f)).receipts[0]!.id;

    // Stage the first accept, as a real workflow would before continuing.
    await s.f.git('add', '-A');

    const second = await accept(s, {
      io: fakeIo(['a']),
      targets: [
        target(s.f, {
          files: [
            snap({
              file: 'b.gcode',
              baselineSha256: sha256('G0 Y1\n'),
              receivedSha256: sha256('G0 Y2\n'),
            }),
          ],
        }),
      ],
    });
    expect(second.out.exitCode).toBe(EXIT_OK);

    const file = await receiptOf(s.f);
    expect(file.receipts.map((r) => r.id)).toContain(firstId);
    expect(file.receipts).toHaveLength(2);
    expect(vouchesFor(file.receipts, 'a.gcode', sha256(NEW))).toBe(firstId);
    expect(vouchesFor(file.receipts, 'b.gcode', sha256('G0 Y2\n'))).not.toBeNull();
  });

  test('a superseded receipt is pruned, because it vouches for nothing present', async () => {
    const s = await scene();
    await accept(s, { io: fakeIo(['a']) });
    const firstId = (await receiptOf(s.f)).receipts[0]!.id;
    await s.f.git('add', '-A');

    // A third revision of the same file supersedes accept #1 entirely.
    const NEWER = 'G0 X3\n';
    await s.f.received('a.gcode', NEWER);
    const { out, io } = await accept(s, {
      io: fakeIo(['a']),
      targets: [
        target(s.f, {
          files: [
            snap({ file: 'a.gcode', baselineSha256: sha256(NEW), receivedSha256: sha256(NEWER) }),
          ],
        }),
      ],
    });
    expect(out.exitCode).toBe(EXIT_OK);

    const file = await receiptOf(s.f);
    expect(file.receipts.map((r) => r.id)).not.toContain(firstId);
    expect(file.receipts).toHaveLength(1);
    expect(vouchesFor(file.receipts, 'a.gcode', sha256(NEWER))).not.toBeNull();
    expect(io.text()).toContain('pruned 1 receipt');
  });

  test('re-accepting identical content is a no-op id, not a new log entry', async () => {
    const s = await scene();
    await accept(s, { io: fakeIo(['a']) });
    const before = await s.f.read(`${s.f.outRepo}/.vibes-accept.json`);
    await s.f.git('add', '-A');
    await accept(s, { io: fakeIo(['a']) });
    expect(await s.f.read(`${s.f.outRepo}/.vibes-accept.json`)).toBe(before);
  });
});

/* ───────────────────────────── plumbing ──────────────────────────────── */

describe('exit codes', () => {
  test('are distinct, so a wrapper can tell refusal from quit from a bad write', () => {
    expect(new Set([EXIT_OK, EXIT_REFUSED, EXIT_QUIT, EXIT_APPLY_FAILED]).size).toBe(4);
    expect(EXIT_OK).toBe(0);
  });
});
