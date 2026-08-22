/**
 * `vibes accept`, composed.
 *
 * The order below is the whole safety property: SELECT → PLAN → REFUSE →
 * REVIEW → APPLY. Every refusal is computed before a single byte is written,
 * so "exits non-zero and writes nothing" is a structural fact rather than a
 * promise each check has to keep individually.
 */

import { readFileSync, promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  AcceptMode,
  ComponentId,
  Finding,
  RepoPath,
  RunReport,
  Sha,
  SnapshotResult,
} from '../types.js';
import type { ResolvedConfig } from '../config/index.js';
import { sha256 } from '../git/index.js';
import { DOCTOR_ATTESTATION_PATH, checkAttestation, readDoctorAttestation } from './doctor.js';
import type { DoctorAttestation } from './doctor.js';
import type { AcceptGitPort, BaseFacts } from './guards.js';
import { checkRefusals } from './guards.js';
import type { AcceptIo, ReviewRenderOptions } from './interactive.js';
import { candidateKey, renderCandidate, reviewCandidates } from './interactive.js';
import type {
  AcceptOptions,
  AcceptTarget,
  AcceptedFile,
  Candidate,
  Refusal,
  RunAcceptResult,
  TargetPlan,
} from './model.js';
import {
  EXIT_APPLY_FAILED,
  EXIT_OK,
  EXIT_QUIT,
  EXIT_REFUSED,
  RECEIPT_BASENAME,
  acceptModeOf,
  acceptedByOf,
  formatRefusal,
  targetId,
} from './model.js';
import { buildPlan, describeCandidate, selectTargets } from './plan.js';
import type { PruneProbe, StoredReceipt } from './receipt.js';
import { findingsForReceipt } from './receipt.js';
import { ReceiptFileCorruptError, applyTarget, readReceipts } from './apply.js';

/** `GitRepo` satisfies this structurally. */
export interface AcceptRepoPort extends AcceptGitPort {
  readBlob(rev: string, path: RepoPath): Promise<Buffer | null>;
}

export interface AcceptRunInput {
  readonly repoRoot: string;
  readonly targets: readonly AcceptTarget[];
  readonly base: BaseFacts;
  readonly headSha: Sha;
  /** What the run report says it compared. Guards refuse when they disagree. */
  readonly reportBaseSha: Sha;
  readonly reportHeadSha: Sha;
  readonly options: AcceptOptions;
  readonly git: AcceptRepoPort;
  readonly io: AcceptIo;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Injected in tests; otherwise read from `.vibes/doctor.json`. */
  readonly attestation?: DoctorAttestation | null | undefined;
  readonly render?: ReviewRenderOptions | undefined;
}

export interface AcceptRunOutcome extends RunAcceptResult {
  readonly findings: readonly Finding[];
  readonly receipts: readonly StoredReceipt[];
}

export async function runAccept(input: AcceptRunInput): Promise<AcceptRunOutcome> {
  try {
    return await acceptOnce(input);
  } finally {
    // The review loop is the only thing that opens a stdin handle, and an open
    // stdin handle keeps node alive. Closing here means `runAccept` cannot
    // leave the process hanging whichever of the eight refusal paths it took.
    // `io.write` still works afterwards — it is plain stdout.
    input.io.close();
  }
}

async function acceptOnce(input: AcceptRunInput): Promise<AcceptRunOutcome> {
  const { options, io } = input;
  const env = input.env ?? process.env;
  const mode = acceptModeOf(options);
  const acceptedBy = acceptedByOf(options);
  const selection = selectTargets(input.targets, options);
  const plan = buildPlan(selection.selected);

  const attestation =
    input.attestation !== undefined
      ? input.attestation
      : options.bootstrap
        ? await readDoctorAttestation(attestationPath(input.repoRoot, options))
        : null;

  // Read every existing receipt BEFORE any decision: a corrupt one is a
  // refusal, and the entries also tell us which base blobs to probe for
  // pruning. Doing it here keeps the apply step free of async lookups.
  const existing = new Map<string, readonly StoredReceipt[]>();
  const refusals: Refusal[] = [];
  for (const p of plan.targets) {
    const abs = join(p.target.baselineDir, RECEIPT_BASENAME);
    try {
      const file = await readReceipts(abs, p.target.component, p.target.producer);
      existing.set(targetId(p.target), file.receipts);
    } catch (err) {
      if (!(err instanceof ReceiptFileCorruptError)) throw err;
      refusals.push({
        code: 'receipt-corrupt',
        target: targetId(p.target),
        message: `${p.target.outRepo}/${RECEIPT_BASENAME} is not a valid receipt file.`,
        remediation:
          'Restore it from git (`git checkout -- <path>`). Reading it as "no receipts" would make corrupting it the cheapest way to erase the audit trail, so accept refuses instead.',
        paths: [...err.problems],
      });
    }
  }

  refusals.push(
    ...(await checkRefusals({
      base: input.base,
      headSha: input.headSha,
      reportBaseSha: input.reportBaseSha,
      reportHeadSha: input.reportHeadSha,
      plan,
      selection,
      options,
      env,
      isTTY: io.isTTY,
      git: input.git,
      attestation,
    })),
  );

  if (refusals.length > 0) {
    for (const r of refusals) io.write(`${formatRefusal(r)}\n`);
    io.write(`\nNothing was written.\n`);
    return finish(input, mode, acceptedBy, refusals, [], [], plan, 0, 0, EXIT_REFUSED);
  }

  if (plan.candidates.length === 0) {
    const skipped = plan.skippedEquivalent;
    io.write(
      skipped === 0
        ? 'Nothing to accept.\n'
        : `Nothing to accept. ${skipped} file(s) were identical or within tolerance and were skipped.\n`,
    );
    return finish(input, mode, acceptedBy, [], [], [], plan, 0, 0, EXIT_OK);
  }

  if (options.dryRun) {
    io.write(`Would accept ${plan.candidates.length} file(s):\n`);
    for (const c of plan.candidates) io.write(`  ${describeCandidate(c)}\n`);
    io.write(`  (${plan.skippedEquivalent} identical/equivalent file(s) skipped)\n`);
    io.write('--dry-run: nothing was written.\n');
    return finish(input, mode, acceptedBy, [], [], [], plan, 0, 0, EXIT_OK);
  }

  // §5.6: a bootstrap must render every added snapshot, whether or not anyone
  // is watching. The point is that the review is PHYSICALLY POSSIBLE — the
  // bytes appear in the terminal and in the CI log of whoever runs it — not
  // that a human necessarily read them.
  if (mode === 'bootstrap' && (options.yes || !io.isTTY)) {
    for (const c of plan.candidates) {
      io.write(`\n── ${c.repoPath}\n`);
      io.write(`${await renderCandidate(c, input.render ?? {})}\n`);
    }
  }

  let decisions: ReadonlyMap<string, 'accept' | 'reject' | 'skip'>;
  let rejected = 0;
  let skipped = 0;
  if (options.yes) {
    decisions = new Map(plan.candidates.map((c) => [candidateKey(c), 'accept' as const]));
    io.write(`Accepting ${plan.candidates.length} file(s) without review (mode ${mode}):\n`);
    for (const c of plan.candidates) io.write(`  ${describeCandidate(c)}\n`);
  } else {
    const outcome = await reviewCandidates(plan.candidates, io, input.render ?? {});
    if (outcome.quit) {
      io.write('\nQuit. Nothing was written.\n');
      return finish(input, mode, acceptedBy, [], [], [], plan, 0, 0, EXIT_QUIT);
    }
    decisions = outcome.decisions;
    for (const d of decisions.values()) {
      if (d === 'reject') rejected += 1;
      if (d === 'skip') skipped += 1;
    }
  }

  const acceptedFiles: AcceptedFile[] = [];
  const receipts: StoredReceipt[] = [];
  const receiptPaths: RepoPath[] = [];
  try {
    for (const p of plan.targets) {
      const accepted = p.candidates.filter((c) => decisions.get(candidateKey(c)) === 'accept');
      if (accepted.length === 0) continue;
      const probe = await buildProbe(input, p, existing.get(targetId(p.target)) ?? []);
      const attested =
        mode === 'bootstrap'
          ? checkAttestation(attestation, targetId(p.target), input.headSha)
          : null;
      const result = await applyTarget({
        plan: p,
        accepted,
        rejected: countIn(decisions, p, 'reject'),
        skipped: countIn(decisions, p, 'skip'),
        mode,
        acceptedBy,
        reason: options.reason ?? '',
        baseSha: input.base.sha,
        headSha: input.headSha,
        unverifiedProducer: options.unverifiedProducer,
        doctorRuns: attested === null ? null : [...attested.runShas],
        acceptDeletionsDeclared: options.acceptDeletions,
        probe,
        repoRoot: input.repoRoot,
      });
      acceptedFiles.push(...result.files);
      if (result.receipt !== null) receipts.push(result.receipt);
      if (result.receiptPath !== null) receiptPaths.push(result.receiptPath);
      for (const extra of result.extraPaths) receiptPaths.push(extra);
      if (result.prunedReceipts.length > 0) {
        io.write(
          `  ${targetId(p.target)}: pruned ${result.prunedReceipts.length} receipt(s) the base tree now vouches for\n`,
        );
      }
    }
  } catch (err) {
    io.write(`\nERROR while applying: ${(err as Error).message}\n`);
    io.write(
      'Some baseline files may have been written without a receipt. `vibes run` will report them as unreceipted-baseline; `git checkout -- <dir>` restores them.\n',
    );
    return finish(
      input,
      mode,
      acceptedBy,
      [],
      acceptedFiles,
      receiptPaths,
      plan,
      rejected,
      skipped,
      EXIT_APPLY_FAILED,
    );
  }

  const findings = receipts.flatMap((r) => findingsForReceipt(r));
  const out = finish(
    input,
    mode,
    acceptedBy,
    [],
    acceptedFiles,
    receiptPaths,
    plan,
    rejected,
    skipped,
    EXIT_OK,
  );
  io.write(`\n${out.summary}\n`);
  for (const f of findings) io.write(`  ${f.severity}: ${f.title}\n`);
  if (receiptPaths.length > 0) {
    io.write(`\nCommit the baselines together with:\n`);
    for (const p of receiptPaths) io.write(`  ${p}\n`);
  }
  return { ...out, findings, receipts };
}

function countIn(
  decisions: ReadonlyMap<string, 'accept' | 'reject' | 'skip'>,
  p: TargetPlan,
  kind: 'reject' | 'skip',
): number {
  let n = 0;
  for (const c of p.candidates) if (decisions.get(candidateKey(c)) === kind) n += 1;
  return n;
}

function finish(
  input: AcceptRunInput,
  mode: AcceptMode,
  acceptedBy: string,
  refusals: readonly Refusal[],
  accepted: readonly AcceptedFile[],
  receiptsWritten: readonly RepoPath[],
  plan: { candidates: readonly Candidate[]; skippedEquivalent: number },
  rejected: number,
  skipped: number,
  exitCode: number,
): AcceptRunOutcome {
  const deleted = accepted.filter((a) => a.action === 'delete').length;
  const counts = {
    offered: plan.candidates.length,
    accepted: accepted.length,
    rejected,
    skipped,
    skippedEquivalent: plan.skippedEquivalent,
    deleted,
  };
  const summary =
    exitCode === EXIT_REFUSED
      ? `Refused (${refusals.length} reason(s)). Nothing was written.`
      : `Accepted ${counts.accepted} file(s) of ${counts.offered} offered` +
        (deleted > 0 ? `, including ${deleted} deletion(s)` : '') +
        `; ${counts.skippedEquivalent} identical/equivalent skipped` +
        (rejected > 0 ? `; ${rejected} rejected` : '') +
        (skipped > 0 ? `; ${skipped} skipped` : '') +
        `. mode=${mode} acceptedBy=${acceptedBy}`;
  return {
    exitCode,
    refusals,
    counts,
    accepted,
    receiptsWritten,
    mode,
    acceptedBy,
    baseSha: input.base.sha,
    headSha: input.headSha,
    summary,
    dryRun: input.options.dryRun,
    findings: [],
    receipts: [],
  };
}

/**
 * The prune probe.
 *
 * `baseSha256` is resolved EAGERLY (async git, before anything is written) and
 * `currentSha256` LAZILY (sync fs, read at prune time) — and the asymmetry is
 * the point. Pruning happens after this accept's own writes, so a file it just
 * overwrote must hash to the NEW bytes and a file it just deleted must read as
 * absent. Snapshotting the current shas up front would prune against the tree
 * as it was before the accept, which is the wrong tree by exactly one step.
 */
async function buildProbe(
  input: AcceptRunInput,
  p: TargetPlan,
  receipts: readonly StoredReceipt[],
): Promise<PruneProbe> {
  const files = new Set<string>();
  for (const r of receipts) for (const e of r.entries) files.add(e.file);
  const baseShas = new Map<string, string | null>();
  for (const f of files) {
    const blob = await input.git.readBlob(input.base.sha, `${p.target.outRepo}/${f}`);
    baseShas.set(f, blob === null ? null : sha256(blob));
  }
  const dir = p.target.baselineDir;
  return {
    baseSha256: (file) => baseShas.get(file) ?? null,
    currentSha256: (file) => {
      try {
        return sha256(readFileSync(join(dir, ...file.split('/'))));
      } catch {
        // Absent, or unreadable. Both mean "no content here to vouch for";
        // `pruneReceipts` treats that as not-load-bearing, never as a keep.
        return null;
      }
    },
  };
}

function attestationPath(repoRoot: string, options: AcceptOptions): string {
  const p = options.doctorAttestation;
  if (p === null) return join(repoRoot, ...DOCTOR_ATTESTATION_PATH.split('/'));
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

/* ───────────────────── composing from a run report ───────────────────── */

export interface TargetsFromReportInput {
  readonly report: RunReport;
  readonly config: ResolvedConfig;
  /**
   * Changed source paths matching each component's `witnesses`.
   *
   * REQUIRED, and deliberately not defaulted to `ComponentResult`'s
   * `exercisedWitnessPaths`. `exercised` means a pre-existing snapshot MOVED;
   * during a bootstrap none exist, so that field is empty by construction and
   * refusal 6 — "--bootstrap must not be combined with a witness change" —
   * would never fire. A guard that silently cannot fire is worse than no guard,
   * so the composer is made to compute the claimed set explicitly.
   */
  readonly changedWitnessPaths: ReadonlyMap<ComponentId, readonly RepoPath[]>;
  /**
   * Producer INPUT corpus paths that changed, per component.
   *
   * The contract's `VibesManifest` has no `corpus` field, so nothing computes
   * this yet. Absent, EVERY deletion needs `--accept-deletions`, which is the
   * safe direction: it over-asks rather than silently authorising a shrinking
   * corpus.
   */
  readonly corpusChanged?: ReadonlyMap<ComponentId, readonly RepoPath[]> | undefined;
}

export interface TargetsFromReport {
  readonly targets: readonly AcceptTarget[];
  readonly warnings: readonly string[];
}

export function targetsFromRunReport(input: TargetsFromReportInput): TargetsFromReport {
  const targets: AcceptTarget[] = [];
  const warnings: string[] = [];
  const byComponent = new Map(input.config.components.map((c) => [c.id, c]));

  for (const comp of input.report.components) {
    const plan = byComponent.get(comp.component);
    if (plan === undefined) {
      warnings.push(
        `component "${comp.component}" is in the run report but not in the registry; skipping`,
      );
      continue;
    }
    const snapshotsByProducer = new Map<string, SnapshotResult[]>();
    for (const s of comp.snapshots) {
      const list = snapshotsByProducer.get(s.producer) ?? [];
      list.push(s);
      snapshotsByProducer.set(s.producer, list);
    }

    for (const pr of comp.producers) {
      const pp = plan.producers.find((x) => x.resolved.name === pr.producer);
      if (pp === undefined) {
        warnings.push(
          `producer "${comp.component}/${pr.producer}" is in the run report but not in the manifest; skipping`,
        );
        continue;
      }
      targets.push({
        component: comp.component,
        producer: pr.producer,
        outcome: pr.outcome,
        everCIVerified: pr.everCIVerified,
        ciJob: pp.resolved.ciJob ?? null,
        baselineDir: pp.resolved.baselineDir,
        receivedDir: pp.resolved.receivedDir,
        outRepo: pp.outRepo,
        files: snapshotsByProducer.get(pr.producer) ?? [],
        changedWitnessPaths: [...(input.changedWitnessPaths.get(comp.component) ?? [])],
        exercisedWitnessPaths: [...comp.exercisedWitnessPaths],
        corpusChangedPaths: [...(input.corpusChanged?.get(comp.component) ?? [])],
        hasBaseline: pp.hasBaseline,
      });
    }
  }
  return { targets, warnings };
}

/* ──────────────────────── loading the run report ─────────────────────── */

export interface LoadedRunReport {
  readonly report: RunReport | null;
  readonly errors: readonly string[];
}

/**
 * A shallow structural check, not a schema validator.
 *
 * The run report is produced by this same tool moments earlier, so the failure
 * we actually guard against is "no report" or "a report from a different
 * version", not a hostile one. Both must be loud: accepting against a report
 * that does not describe this run is the one thing worse than not accepting.
 */
export async function loadRunReport(absPath: string): Promise<LoadedRunReport> {
  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf8');
  } catch {
    return {
      report: null,
      errors: [`no run report at ${absPath} — run \`vibes run\` first`],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    return { report: null, errors: [`${absPath} is not valid JSON: ${(err as Error).message}`] };
  }
  if (raw === null || typeof raw !== 'object') {
    return { report: null, errors: [`${absPath} is not an object`] };
  }
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (o['version'] !== 1) errors.push(`unsupported report version ${JSON.stringify(o['version'])}`);
  for (const k of ['baseSha', 'headSha'] as const) {
    if (typeof o[k] !== 'string') errors.push(`missing "${k}"`);
  }
  if (!Array.isArray(o['components'])) errors.push('missing "components" array');
  if (errors.length > 0) return { report: null, errors };
  return { report: raw as unknown as RunReport, errors: [] };
}
