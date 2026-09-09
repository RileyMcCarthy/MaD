import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT, type ExitCode } from './exit.js';
import { str, list, type ParsedCommand } from './args.js';
import { validateAll } from '../config/index.js';
import { openRepo, resolveBase } from '../git/index.js';
import { buildPlan, runProducers } from '../runner/index.js';
import {
  DOCTOR_ATTESTATION_PATH, DOCTOR_ATTESTATION_SCHEMA,
  type DoctorAttestation, type DoctorProducerAttestation,
} from '../accept/index.js';
import { VIBES_VERSION } from './main.js';
import type { Sha } from '../types.js';
import type { Diagnostic } from '../config/index.js';

/**
 * One digest of the WHOLE received tree, not per-file.
 *
 * A producer that emits a different SET of files each run is exactly as
 * nondeterministic as one that emits different bytes, and per-file hashes
 * would miss it entirely.
 */
async function treeDigest(files: readonly { file: string; sha256: string }[]): Promise<string> {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    h.update(f.file);
    h.update('\0');
    h.update(f.sha256);
    h.update('\0');
  }
  return h.digest('hex');
}

/** Validate every manifest WITHOUT running a producer, and optionally prove
 *  byte-stability with --repeat=N. The repeat gate is what `accept --bootstrap`
 *  requires: a nondeterministic producer must not be able to bootstrap at all. */
export async function cmdDoctor(p: ParsedCommand, log: (s: string) => void): Promise<ExitCode> {
  const cwd = str(p, 'cwd') ?? process.cwd();
  const repo = await openRepo({ cwd });
  const head = (await repo.revParse('HEAD')) ?? ('0'.repeat(40) as Sha);

  let baseSha: Sha = head;
  try {
    const base = await resolveBase({ repo, baseRef: 'origin/main', explicit: str(p, 'base') ?? null, requireExact: false });
    baseSha = base.sha;
  } catch { /* doctor validates shape even when no base resolves */ }

  const summary = await validateAll({
    repoRoot: repo.repoRoot,
    baseRef: 'origin/main',
    baseSha, headSha: head,
    git: repo,
  });

  // Every diagnostic carries file, component, evidence and a REQUIRED fix.
  // Printing only the message throws away the half that makes it actionable.
  const show = (label: string, ds: readonly Diagnostic[]): void => {
    for (const d of ds) {
      const who = d.component === undefined ? d.file : `${d.component} (${d.file})`;
      log(`${label}  ${who}`);
      log(`       ${d.message}${d.locator === undefined ? '' : `  [${d.locator}]`}`);
      for (const e of d.evidence) log(`         ${e}`);
      log(`       fix: ${d.fix}`);
    }
  };
  show('ERROR', summary.errors);
  show('warn ', summary.warnings);
  show('info ', summary.infos);

  const n = summary.config.components.length;
  const producerCount = summary.config.components.reduce((a, c) => a + c.producers.length, 0);
  log(summary.ok
    ? `vibes doctor: ${n} component(s), ${producerCount} producer(s) — config is valid.`
    : `vibes doctor: ${summary.errors.length} error(s). No producer may run.`);

  const repeat = Number(str(p, 'repeat') ?? '0');
  if (!Number.isFinite(repeat) || repeat <= 0) {
    return summary.ok ? EXIT.OK : EXIT.CONFIG;
  }
  if (!summary.ok) {
    log('vibes doctor: config is invalid; not running producers.');
    return EXIT.CONFIG;
  }

  /* ── determinism attestation ────────────────────────────────────────────
   * Run each selected producer `repeat` times and compare whole-tree digests.
   * This is the registration gate for `accept --bootstrap`: a producer whose
   * repeats disagree is nondeterministic and must not be able to bootstrap at
   * all, because every later run would show a diff nobody caused. */
  const wanted = new Set(list(p, 'producer'));
  const plan = buildPlan(summary.config, {});
  const tasks = plan.tasks.filter((t) => wanted.size === 0 || wanted.has(t.id) || wanted.has(t.name));
  if (tasks.length === 0) {
    log('vibes doctor: no producer matched.');
    return EXIT.USAGE;
  }

  const digests = new Map<string, string[]>();
  for (let i = 0; i < repeat; i++) {
    log(`vibes doctor: repeat ${String(i + 1)}/${String(repeat)}`);
    const rep = await runProducers({
      repo,
      plan: { ...plan, tasks },
      runId: `doctor-${String(i)}`,
      baseSha, headSha: head,
      vibesVersion: VIBES_VERSION,
      concurrency: summary.config.concurrency,
    });
    for (const r of rep.runs) {
      const list_ = digests.get(r.task.id) ?? [];
      list_.push(r.outcome === 'ok' ? await treeDigest(r.inventory?.files ?? []) : `FAILED:${r.outcome}`);
      digests.set(r.task.id, list_);
    }
  }

  const producers: DoctorProducerAttestation[] = [];
  let allStable = true;
  for (const [id, runShas] of [...digests].sort()) {
    const stable = runShas.length > 1 && runShas.every((x) => x === runShas[0]) && !runShas[0]!.startsWith('FAILED');
    if (!stable) allStable = false;
    producers.push({ producer: id, repeat: runShas.length, runShas, stable });
    log(stable
      ? `  stable      ${id}  ${runShas[0]!.slice(0, 12)}`
      : `  UNSTABLE    ${id}  ${[...new Set(runShas)].map((x) => x.slice(0, 12)).join(' != ')}`);
  }

  const attestation: DoctorAttestation = {
    schema: DOCTOR_ATTESTATION_SCHEMA,
    headSha: head,
    producers,
  };
  await mkdir(join(repo.repoRoot, '.vibes'), { recursive: true });
  await writeFile(
    join(repo.repoRoot, DOCTOR_ATTESTATION_PATH),
    JSON.stringify(attestation, null, 2) + '\n',
    'utf8',
  );
  log(`vibes doctor: wrote ${DOCTOR_ATTESTATION_PATH}`);
  if (!allStable) {
    log('vibes doctor: at least one producer is NOT byte-stable. It cannot be bootstrapped.');
    return EXIT.PRODUCER;
  }
  return EXIT.OK;
}
