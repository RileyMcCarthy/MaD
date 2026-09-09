/**
 * The refusals. Every one of them exits non-zero and writes NOTHING.
 *
 * They are all evaluated before any decision is made, and all reported at once,
 * because a tool that refuses one reason at a time teaches people to fight it
 * one flag at a time.
 *
 * The eight from §5.4 are implemented exactly as written. Eight more are added
 * here; each is marked ADDITION and carries its justification, because adding
 * refusals to a tool whose whole thesis is "make the honest path the easy one"
 * needs to be argued, not assumed.
 */

import { promises as fs } from 'node:fs';

import type { RepoPath, Sha } from '../types.js';
import type { BaseConfidence, BaseSource, StatusEntry } from '../git/index.js';
import { sha256 } from '../git/index.js';
import type { DoctorAttestation } from './doctor.js';
import { BOOTSTRAP_MIN_REPEAT, DOCTOR_ATTESTATION_PATH, checkAttestation } from './doctor.js';
import type { AcceptOptions, AcceptPlan, Refusal, TargetPlan } from './model.js';
import { acceptModeOf, targetId } from './model.js';
import type { SelectionResult } from './plan.js';

/** Structurally satisfied by `GitRepo`; narrowed so tests need no real repo. */
export interface AcceptGitPort {
  status(): Promise<readonly StatusEntry[]>;
  unmergedPaths(): Promise<readonly RepoPath[]>;
}

/** Structurally satisfied by `BaseResolution`. */
export interface BaseFacts {
  readonly sha: Sha;
  readonly source: BaseSource;
  readonly confidence: BaseConfidence;
  readonly sameAsHead: boolean;
}

export interface GuardInput {
  readonly base: BaseFacts;
  readonly headSha: Sha;
  /** What the run report said it compared against. */
  readonly reportBaseSha: Sha;
  readonly reportHeadSha: Sha;
  readonly plan: AcceptPlan;
  readonly selection: SelectionResult;
  readonly options: AcceptOptions;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
  readonly git: AcceptGitPort;
  readonly attestation: DoctorAttestation | null;
}

/**
 * `CI=false` and `CI=` are how a developer says "not CI"; treating any defined
 * value as truthy would make accept unusable on a laptop whose shell exports a
 * disabled flag.
 */
export function isCiEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env['CI'];
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
}

export async function checkRefusals(input: GuardInput): Promise<readonly Refusal[]> {
  const out: Refusal[] = [];
  const { options, plan, selection } = input;
  const mode = acceptModeOf(options);
  const selectedPlans = plan.targets;

  /* ── 1. CI ─────────────────────────────────────────────────────────────
   * No --force, no override, no escape. This makes "run accept to turn CI
   * green" mechanically impossible from inside CI.
   *
   * Be honest about what this is worth: any wrapper can `env -u CI` and this
   * check evaporates. It is hygiene against the ACCIDENTAL case — a workflow
   * step that calls accept, a script copied from a laptop — not a security
   * boundary. The receipt in the diff is the real defence, and it survives
   * every unset variable.
   */
  if (isCiEnv(input.env)) {
    out.push({
      code: 'ci-environment',
      target: null,
      message: `CI=${JSON.stringify(input.env['CI'])} — baselines are writable only from a workstation.`,
      remediation:
        'Run `vibes accept` locally, review the change, and commit the receipt. There is no override flag, by design.',
    });
    // Everything else is moot: nothing will be written whatever we find.
    return out;
  }

  /* ── ADDITION: an unknown selector is a typo, not an empty selection ────
   * `vibes accept --producer domian` silently accepting nothing, exiting 0,
   * would read as "there was nothing to accept" and the operator would commit
   * a stale baseline believing it had been refreshed.
   */
  if (selection.unmatched.length > 0) {
    out.push({
      code: 'unknown-target',
      target: null,
      message: `no producer matched: ${selection.unmatched.join(', ')}`,
      remediation: 'Use `component/producer` as printed in the report roster.',
    });
  }

  /* ── ADDITION: a conflicted index means the tree is a merge in progress ──
   * A worktree diff reports a conflicted file as an ordinary `M`, so the run
   * would have measured a half-merged tree and reported conflict markers as
   * behaviour. Accepting that writes them into the baseline.
   */
  const unmerged = await input.git.unmergedPaths();
  if (unmerged.length > 0) {
    out.push({
      code: 'unmerged-index',
      target: null,
      message: `${unmerged.length} path(s) are unmerged — this tree is mid-merge.`,
      remediation: 'Finish the merge, re-run `vibes run`, then accept.',
      paths: [...unmerged],
    });
  }

  /* ── 2. the producer did not run ok ─────────────────────────────────── */
  for (const p of selectedPlans) {
    if (p.target.outcome === 'ok') continue;
    out.push({
      code: 'producer-not-ok',
      target: targetId(p.target),
      message: `outcome is "${p.target.outcome}" — a crashed producer's partial output is never a baseline.`,
      remediation:
        'Fix the producer and re-run `vibes run`. To accept a different producer from the same run, name it with --producer.',
    });
  }

  /* ── 3. the base is not a usable comparison point ────────────────────── */
  if (input.base.sameAsHead) {
    out.push({
      code: 'base-not-exact',
      target: null,
      message: `base ${input.base.sha.slice(0, 12)} is HEAD — there is no range, so nothing was actually compared.`,
      remediation:
        'Accept from a branch with commits ahead of its base, or pass --base <rev> naming a real ancestor.',
    });
  } else if (input.base.confidence !== 'exact') {
    out.push({
      code: 'base-not-exact',
      target: null,
      message: `base resolved as "${input.base.source}" with confidence "${input.base.confidence}" — the comparison may be against the wrong tree.`,
      remediation:
        'Fetch full history (`git fetch --unshallow` / `fetch-depth: 0`) or pass an explicit --base <sha>.',
    });
  }

  /* ── ADDITION: the run report describes a different tree ─────────────── */
  if (input.reportHeadSha !== input.headSha || input.reportBaseSha !== input.base.sha) {
    out.push({
      code: 'run-stale',
      target: null,
      message:
        `the run report compared ${input.reportBaseSha.slice(0, 12)}..${input.reportHeadSha.slice(0, 12)}, ` +
        `but HEAD is now ${input.headSha.slice(0, 12)} and base resolves to ${input.base.sha.slice(0, 12)}.`,
      remediation:
        'Re-run `vibes run`. Accepting bytes produced against a different tree would commit verdicts that describe something else.',
    });
  }

  /* ── 4. deletions without a declared cause ───────────────────────────── */
  const deletionRefusals = checkDeletions(selectedPlans, plan, options);
  out.push(...deletionRefusals);

  /* ── 5. the producer has never completed in CI ───────────────────────── */
  if (!options.unverifiedProducer) {
    for (const p of selectedPlans) {
      if (p.candidates.length === 0) continue;
      if (p.target.everCIVerified) continue;
      out.push({
        code: 'never-ci-verified',
        target: targetId(p.target),
        message:
          p.target.ciJob === null
            ? 'this producer declares no CI job, so nothing has ever reproduced its output.'
            : `this producer has never completed in CI job "${p.target.ciJob}".`,
        remediation:
          'Land the producer in CI first, or pass --unverified-producer — which is recorded in the receipt as `locally-accepted, never CI-verified`.',
      });
    }
  }

  /* ── 6. bootstrap inside a behaviour change ──────────────────────────── */
  if (options.bootstrap) {
    for (const p of selectedPlans) {
      if (p.target.changedWitnessPaths.length === 0) continue;
      out.push({
        code: 'bootstrap-touches-witnesses',
        target: targetId(p.target),
        message: `${p.target.changedWitnessPaths.length} witnessed source path(s) changed in this diff.`,
        remediation:
          'Adoption gets its own PR. Bootstrap the baselines on a branch that changes no witnessed source, then make the behaviour change on top of it.',
        paths: [...p.target.changedWitnessPaths],
      });
    }
  }

  /* ── 7. someone hand-edited a snapshot ───────────────────────────────── */
  out.push(...(await checkWorktreeClean(input)));

  /* ── 8. a non-reviewed mode with no stated reason ────────────────────── */
  if (mode !== 'reviewed' && (options.reason === null || options.reason.trim() === '')) {
    out.push({
      code: 'reason-required',
      target: null,
      message: `mode "${mode}" requires --reason. An unreviewed acceptance with no stated cause is unattributable.`,
      remediation: 'Add --reason="<why these bytes are correct>". It is recorded verbatim in the receipt.',
    });
  }

  /* ── ADDITION: non-interactive must be explicit ──────────────────────── */
  if (
    !input.isTTY &&
    !options.yes &&
    !options.all &&
    !options.dryRun &&
    plan.candidates.length > 0
  ) {
    out.push({
      code: 'non-interactive-requires-yes',
      target: null,
      message: 'stdin is not a TTY and no --yes was given, so no file can be reviewed.',
      remediation:
        'Run from a terminal, or pass --yes --reason="…" — which marks the receipt `mode: bulk` so the report can say it was never reviewed.',
    });
  }

  /* ── ADDITION: unsafe paths in the roster ────────────────────────────── */
  for (const p of selectedPlans) {
    if (p.unsafe.length === 0) continue;
    out.push({
      code: 'unsafe-path',
      target: targetId(p.target),
      message: `${p.unsafe.length} snapshot path(s) escape the out dir or are not POSIX-relative.`,
      remediation: 'Fix the producer so every emitted path is relative to $VIBES_OUT_DIR.',
      paths: p.unsafe,
    });
  }

  /* ── ADDITION: bootstrap preconditions ───────────────────────────────── */
  if (options.bootstrap) out.push(...checkBootstrap(input, selectedPlans));

  /* ── ADDITION: the bytes on disk are not the bytes the report judged ─── */
  out.push(...(await checkReceivedIntegrity(plan)));

  return out;
}

function checkDeletions(
  selectedPlans: readonly TargetPlan[],
  plan: AcceptPlan,
  options: AcceptOptions,
): readonly Refusal[] {
  const out: Refusal[] = [];
  const total = plan.deletions.length;
  if (total === 0) {
    // A stray --accept-deletions with nothing to delete is a stale command
    // line, and the next one may not be. Say so rather than ignoring it.
    if (options.acceptDeletions !== null && options.acceptDeletions !== 0) {
      out.push({
        code: 'deletions-unauthorized',
        target: null,
        message: `--accept-deletions=${options.acceptDeletions} was given but no baseline file would be deleted.`,
        remediation: 'Drop the flag.',
      });
    }
    return out;
  }

  // A deletion is self-explanatory when the producer's INPUT corpus changed in
  // the same diff: the case that produced this snapshot is gone, so its output
  // should be too. With no corpus change, a deletion is a corpus shrinking for
  // no stated reason — the cheapest way to make a failing snapshot disappear.
  const unexplained = selectedPlans.filter(
    (p) => p.candidates.some((c) => c.action === 'delete') && p.target.corpusChangedPaths.length === 0,
  );

  if (unexplained.length > 0 && options.acceptDeletions === null) {
    out.push({
      code: 'deletions-unauthorized',
      target: null,
      message: `${total} baseline file(s) would be deleted and no corpus source-of-truth changed in this diff.`,
      remediation: `Pass --accept-deletions=${total} --reason="<why the corpus shrank>". Both are recorded in the receipt.`,
      paths: plan.deletions.map((d) => d.repoPath),
    });
  } else if (options.acceptDeletions !== null && options.acceptDeletions !== total) {
    out.push({
      code: 'deletions-unauthorized',
      target: null,
      message: `--accept-deletions=${options.acceptDeletions} but ${total} file(s) would be deleted.`,
      remediation: `Pass the exact count — --accept-deletions=${total} — after checking the list is what you meant.`,
      paths: plan.deletions.map((d) => d.repoPath),
    });
  }

  if (unexplained.length > 0 && (options.reason === null || options.reason.trim() === '')) {
    out.push({
      code: 'deletions-unauthorized',
      target: null,
      message: 'deleting baselines requires --reason as well as --accept-deletions.',
      remediation: 'Add --reason="<why the corpus shrank>".',
    });
  }
  return out;
}

async function checkWorktreeClean(input: GuardInput): Promise<readonly Refusal[]> {
  if (input.plan.targets.length === 0) return [];
  const status = await input.git.status();
  const out: Refusal[] = [];

  for (const p of input.plan.targets) {
    const prefix = `${p.target.outRepo}/`;
    const dirty = status.filter(
      (s) =>
        (s.path === p.target.outRepo || s.path.startsWith(prefix)) &&
        // Index-only changes are fine: that is what a previous accept plus
        // `git add` looks like, and refusing there would make it impossible to
        // accept two producers in a row.
        s.worktree !== ' ',
    );
    if (dirty.length === 0) continue;
    const untracked = dirty.filter((s) => s.index === '?').map((s) => s.path);
    const modified = dirty.filter((s) => s.index !== '?').map((s) => s.path);
    out.push({
      code: 'baseline-dir-dirty',
      target: targetId(p.target),
      message:
        `${dirty.length} file(s) under ${p.target.outRepo} have unstaged changes` +
        (untracked.length > 0 ? ` (${untracked.length} untracked)` : '') +
        ' — a snapshot was edited by something other than accept.',
      remediation:
        'Resolve first: `git checkout -- <dir>` to discard, or `git add <dir>` to keep. Accept refuses to overwrite edits it cannot explain.',
      paths: [...modified, ...untracked],
    });
  }
  return out;
}

function checkBootstrap(input: GuardInput, plans: readonly TargetPlan[]): readonly Refusal[] {
  const out: Refusal[] = [];
  for (const p of plans) {
    const id = targetId(p.target);

    // Bootstrap means "there is no baseline". If one exists, this is an
    // ordinary accept wearing a costume that skips the comparison.
    const nonAdded = p.candidates.filter((c) => c.verdict.kind !== 'added');
    if (p.target.hasBaseline || nonAdded.length > 0) {
      out.push({
        code: 'bootstrap-has-baseline',
        target: id,
        message: p.target.hasBaseline
          ? `${p.target.outRepo} already contains committed baselines.`
          : `${nonAdded.length} file(s) are not "added" — this is a comparison, not a first baseline.`,
        remediation: 'Drop --bootstrap and accept normally, so each file is compared and reviewed.',
        ...(nonAdded.length > 0 ? { paths: nonAdded.map((c) => c.repoPath) } : {}),
      });
      continue;
    }

    const attested = checkAttestation(input.attestation, id, input.headSha);
    if (!attested.ok) {
      out.push({
        code: 'bootstrap-not-attested',
        target: id,
        message: `${attested.reason ?? 'not attested'}.`,
        remediation:
          `Run \`vibes doctor --repeat=${BOOTSTRAP_MIN_REPEAT} --producer ${id}\` on this commit. It writes ` +
          `${DOCTOR_ATTESTATION_PATH}, and the agreeing run digests go into the receipt. A producer whose ` +
          'repeats disagree is nondeterministic and cannot be bootstrapped at all.',
      });
    }
  }
  return out;
}

/**
 * ADDITION: verify the received bytes still hash to what the report judged.
 *
 * Without this, anything that rewrites the received dir between `run` and
 * `accept` — a second run, an editor, a helpful script — gets its bytes
 * committed under a verdict computed from different content, and the receipt
 * signs a statement that was never true. That is the exact laundering path the
 * receipt exists to close, so it cannot be left open on the input side.
 */
async function checkReceivedIntegrity(plan: AcceptPlan): Promise<readonly Refusal[]> {
  const out: Refusal[] = [];
  for (const c of plan.writes) {
    if (c.absReceived === null) continue;
    let buf: Buffer;
    try {
      buf = await fs.readFile(c.absReceived);
    } catch {
      out.push({
        code: 'received-missing',
        target: `${c.component}/${c.producer}`,
        message: `${c.file} is in the report but missing from the received dir.`,
        remediation: 'Re-run `vibes run`; the received dir is scratch and may have been cleaned.',
      });
      continue;
    }
    if (c.receivedSha256 !== null && sha256(buf) !== c.receivedSha256) {
      out.push({
        code: 'received-mismatch',
        target: `${c.component}/${c.producer}`,
        message: `${c.file} on disk does not match the sha256 the report judged.`,
        remediation:
          'Something rewrote the received dir after the run. Re-run `vibes run` so the verdict describes the bytes being committed.',
      });
    }
  }
  return out;
}
