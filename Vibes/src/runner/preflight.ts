/**
 * Preflight — everything that must be true BEFORE the first spawn.
 *
 * All-or-nothing by design. A run that cannot be compared should not be run at
 * all: producing half a report costs the same CI minutes and teaches a reader
 * to trust a number that does not mean what it says.
 */

import type { RepoPath } from '../types.js';
import type { GitRepo, StatusEntry } from '../git/index.js';
import { GITIGNORE_BLOCK, POLICY_LOCK_PATH, RECEIVED_DIR, STATE_DIR } from './constants.js';
import { dirtySubmodules } from './escapes.js';
import { finding, hasError, sortFindings, type RunnerFinding } from './findings.js';
import type { RunPlan } from './plan.js';

export interface PreflightInput {
  readonly repo: GitRepo;
  readonly plan: RunPlan;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** R-M4. A dirty submodule means the run measures an unknown tree. */
  readonly abortOnDirtySubmodule?: boolean | undefined;
  /** Reuse the run's "before" status snapshot instead of paying for a second. */
  readonly status?: readonly StatusEntry[] | undefined;
}

export interface PreflightResult {
  readonly findings: readonly RunnerFinding[];
  readonly ok: boolean;
  readonly submodules: readonly RepoPath[];
  readonly status: readonly StatusEntry[];
}

export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const findings: RunnerFinding[] = [...input.plan.findings];
  const env = input.env ?? process.env;

  /* ── recursion ──────────────────────────────────────────────────────── */
  // `VIBES=1` is injected into every producer, so seeing it here means a
  // producer is invoking Vibes. Left alone, the inner run would wipe the outer
  // run's received dirs mid-flight.
  if (env['VIBES'] === '1') {
    findings.push(
      finding({
        code: 'V090_RECURSION',
        severity: 'error',
        file: 'vibes.config.mjs',
        message: 'VIBES=1 is already set: a producer is invoking Vibes recursively',
        evidence: [`VIBES_RUN_ID=${env['VIBES_RUN_ID'] ?? '(unset)'}`],
        fix: 'remove the nested `vibes run` from the producer command',
      }),
    );
  }

  /* ── the managed .gitignore block ───────────────────────────────────── */
  findings.push(...(await checkIgnoreBlock(input.repo)));

  /* ── submodule cleanliness ──────────────────────────────────────────── */
  const submodules = await safeSubmodules(input.repo);
  const status = input.status ?? (await input.repo.status());
  const dirty = dirtySubmodules(status, submodules);
  if (dirty.length > 0) {
    findings.push(
      finding({
        code: 'V086_SUBMODULE_DIRTY',
        severity: input.abortOnDirtySubmodule === false ? 'warn' : 'error',
        file: '.gitmodules',
        message: 'a submodule is dirty at run start; the run would measure an unknown tree',
        evidence: dirty.map((p) => `${p}: run \`git -C ${p} status --porcelain\``),
        fix: 'commit or stash the submodule changes, or re-run with the dirty-submodule abort disabled',
      }),
    );
  }

  return { findings: sortFindings(findings), ok: !hasError(findings), submodules, status };
}

/**
 * Two probes, and both matter.
 *
 * VERIFIED: `.vibes/` + `!.vibes/policy.lock.json` does NOT work — git never
 * descends into an excluded directory, so `git add` silently no-ops and
 * `git show <base>:.vibes/policy.lock.json` fails forever. The self-governance
 * layer then dies at `info` severity, which is worse than dying loudly.
 *
 * `check-ignore -q` semantics only: `-v` exits 0 for a path re-included by a
 * negation and prints the negation rule as though it were the offender, so its
 * exit status is unusable as a decision.
 */
async function checkIgnoreBlock(repo: GitRepo): Promise<readonly RunnerFinding[]> {
  const out: RunnerFinding[] = [];

  const lockIgnored = await safeIsIgnored(repo, POLICY_LOCK_PATH);
  if (lockIgnored === true) {
    out.push(
      finding({
        code: 'V091_GITIGNORE_BLOCK',
        severity: 'error',
        file: '.gitignore',
        message: '.vibes/policy.lock.json is gitignored, which disables self-governance entirely',
        evidence: [
          '`.vibes/` excludes the directory, so a nested `!` re-include can never take effect',
          `git show <base>:${POLICY_LOCK_PATH} would fail forever`,
        ],
        fix: `replace the vibes block in .gitignore with:\n${GITIGNORE_BLOCK}`,
      }),
    );
  }

  // The mirror image: producer scratch MUST be ignored, or every run leaves the
  // worktree dirty and `git add -A` commits the received tree.
  const probe = `${STATE_DIR}/${RECEIVED_DIR}/probe/probe/probe.txt`;
  const receivedIgnored = await safeIsIgnored(repo, probe);
  if (receivedIgnored === false) {
    out.push(
      finding({
        code: 'V094_RECEIVED_NOT_IGNORED',
        severity: 'error',
        file: '.gitignore',
        message: 'the received dir is not gitignored; producer output would pollute the worktree',
        evidence: [`git check-ignore -q -- ${probe} exits 1 (not ignored)`],
        fix: `add the vibes block to .gitignore:\n${GITIGNORE_BLOCK}`,
      }),
    );
  }

  return out;
}

async function safeIsIgnored(repo: GitRepo, path: RepoPath): Promise<boolean | null> {
  try {
    return await repo.isIgnored(path);
  } catch {
    // Inside a submodule, or a git that refused the query. Either way this is
    // not the check's job to diagnose.
    return null;
  }
}

async function safeSubmodules(repo: GitRepo): Promise<readonly RepoPath[]> {
  try {
    return await repo.submodulePaths();
  } catch {
    return [];
  }
}
