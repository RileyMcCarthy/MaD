/**
 * Runner findings.
 *
 * The config module deliberately declared the whole `V0xx` vocabulary in ONE
 * union — including the `V08x` run-time codes it never emits — so the tool has
 * one code vocabulary rather than two. This module honours that: every check
 * that already has a code uses it verbatim.
 *
 * Five runner-only preconditions have no code in that union (recursion, the
 * `.gitignore` managed block, the tier budget, `/bin/sh` portability, corpus
 * monotonicity, and a few output-shape faults). Rather than edit another
 * module's closed union mid-flight, they are declared here as `RunnerCode` and
 * `RunnerFinding.code` accepts either. Folding `RunnerCode` into
 * `DiagnosticCode` is a one-line change for the integration pass.
 */

import type { ComponentId, ProducerName, RepoPath, Severity } from '../types.js';
import type { DiagnosticCode } from '../config/index.js';

export type RunnerCode =
  /** `VIBES=1` was already set: a producer is invoking Vibes recursively. */
  | 'V090_RECURSION'
  /** `.vibes/policy.lock.json` is ignored, so self-governance is dead. */
  | 'V091_GITIGNORE_BLOCK'
  /** Selected producers cannot fit the tier's wall-clock budget. */
  | 'V092_TIER_BUDGET'
  /** `cmd` uses bash/zsh syntax that `/bin/sh` (dash on Ubuntu) rejects. */
  | 'V093_SH_PORTABILITY'
  /** The received dir is NOT gitignored — producer output would pollute the tree. */
  | 'V094_RECEIVED_NOT_IGNORED'
  /** A machine-scoped lease is held by a live foreign process. */
  | 'V095_RESOURCE_HELD'
  /** The process group survived SIGKILL. An orphan can hold a PTY or a port. */
  | 'V096_ORPHANED_GROUP'
  /** Fewer cases than the committed baseline emitted. The corpus shrank. */
  | 'V097_CORPUS_SHRANK'
  /** A symlink landed in the received dir. */
  | 'V098_SYMLINK_OUTPUT'
  /** Two produced paths differ only by case; one of them dies on APFS. */
  | 'V099_CASE_COLLISION'
  /** More files, or a larger file, than the budget allows. */
  | 'V09A_OUTPUT_BUDGET'
  /** A declared `after`/`dependsOn` edge made the plan unschedulable. */
  | 'V09B_PLAN_DEADLOCK';

export interface RunnerFinding {
  readonly code: DiagnosticCode | RunnerCode;
  readonly severity: Severity;
  /** Repo-relative POSIX. A finding with no file is unactionable. */
  readonly file: RepoPath;
  readonly locator?: string;
  readonly component?: ComponentId;
  readonly producer?: ProducerName;
  /** ≤100 chars, no trailing period; the detail belongs in `evidence`. */
  readonly message: string;
  /** Computed facts only: resolved paths, verbatim tool output, counts. */
  readonly evidence: readonly string[];
  /** REQUIRED, imperative. A check with no remedy is not a check. */
  readonly fix: string;
}

export interface RunnerFindingInit {
  readonly code: DiagnosticCode | RunnerCode;
  readonly severity: Severity;
  readonly file: RepoPath;
  readonly message: string;
  readonly fix: string;
  readonly locator?: string | undefined;
  readonly component?: ComponentId | undefined;
  readonly producer?: ProducerName | undefined;
  readonly evidence?: readonly string[] | undefined;
}

export function finding(init: RunnerFindingInit): RunnerFinding {
  // exactOptionalPropertyTypes: an explicit `undefined` is not assignable to an
  // optional property, so absent keys have to actually be absent.
  const base = {
    code: init.code,
    severity: init.severity,
    file: init.file,
    message: init.message,
    fix: init.fix,
    evidence: init.evidence ?? [],
  };
  return {
    ...base,
    ...(init.locator === undefined ? {} : { locator: init.locator }),
    ...(init.component === undefined ? {} : { component: init.component }),
    ...(init.producer === undefined ? {} : { producer: init.producer }),
  };
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warn: 1, info: 2 };

/** Stable order: severity, then file, then code. Two runs on the same tree
 *  print the same list in the same order. */
export function sortFindings(items: readonly RunnerFinding[]): readonly RunnerFinding[] {
  return [...items].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

export function formatFinding(f: RunnerFinding): string {
  const where = f.locator === undefined ? f.file : `${f.file} ${f.locator}`;
  const lines = [`${f.severity}: ${f.code} ${where}`, `  ${f.message}`];
  for (const e of f.evidence) lines.push(`    ${e}`);
  lines.push(`  fix: ${f.fix}`);
  return lines.join('\n');
}

export function hasError(items: readonly RunnerFinding[]): boolean {
  return items.some((f) => f.severity === 'error');
}
