/**
 * Turning a run into an offer.
 *
 * The classification here is the "what accept writes" rule from §5.5, and the
 * one line that matters is that `identical` and `equivalent` never become
 * candidates. A tolerance producer legitimately emits slightly different bytes
 * every run; if accept wrote those, every accept would commit a fresh sample of
 * noise, the baseline would churn on every PR, and reviewers would learn that
 * snapshot diffs mean nothing. Skipping them is what keeps a moved snapshot a
 * signal.
 *
 * The second rule with teeth: `not-selected` files are NEVER candidates, in
 * either direction. A partial-corpus producer (MaD's smoke subset is 18 of 32)
 * emits a subset by design, and treating the other 14 as deletions would
 * delete two thirds of the corpus the first time someone typed `--all --yes`.
 */

import { join } from 'node:path';

import type { RepoPath } from '../types.js';
import { checkRelPath, normalizeRel } from '../config/index.js';
import type { AcceptOptions, AcceptPlan, AcceptTarget, Candidate, TargetPlan } from './model.js';
import {
  isEquivalentVerdict,
  isReservedBaselineFile,
  isWritableVerdict,
  targetId,
} from './model.js';

export interface SelectionResult {
  readonly selected: readonly AcceptTarget[];
  /** Selectors the operator typed that matched nothing. */
  readonly unmatched: readonly string[];
  /** Explicitly named, as opposed to swept up by the default. */
  readonly explicit: boolean;
}

/**
 * Which producers this invocation is about.
 *
 * The default deliberately includes producers that ran and FAILED, because
 * refusal 2 must be able to fire. If the default quietly dropped them, a run
 * with one crashed producer would accept the rest without ever mentioning the
 * crash, and "a crashed producer's partial output is never a baseline" would
 * be a comment rather than a rule. Narrow with `--producer` to accept anyway.
 *
 * `not-selected` producers ARE excluded: they were not run this invocation by
 * design (tier, --only), so refusing on them would make accept impossible
 * inside any sharded run.
 */
export function selectTargets(
  targets: readonly AcceptTarget[],
  options: AcceptOptions,
): SelectionResult {
  const selectors = [...options.producers];
  const components = new Set(options.components);
  if (selectors.length === 0 && components.size === 0) {
    return {
      selected: targets.filter((t) => t.outcome !== 'not-selected'),
      unmatched: [],
      explicit: false,
    };
  }

  const chosen: AcceptTarget[] = [];
  const unmatched: string[] = [];
  const matchedSelectors = new Set<string>();

  for (const t of targets) {
    const id = targetId(t);
    const bySelector = selectors.some((s) => {
      const hit = s === id || s === t.producer;
      if (hit) matchedSelectors.add(s);
      return hit;
    });
    const byComponent = components.has(t.component);
    if (bySelector || byComponent) chosen.push(t);
  }
  for (const s of selectors) if (!matchedSelectors.has(s)) unmatched.push(s);
  for (const c of components) {
    if (!targets.some((t) => t.component === c)) unmatched.push(c);
  }
  return { selected: chosen, unmatched, explicit: true };
}

function bytewise(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Classify one producer's snapshot roster into offers, skips and no-touches. */
export function planTarget(target: AcceptTarget): TargetPlan {
  const candidates: Candidate[] = [];
  const skippedEquivalent: string[] = [];
  const untouched: string[] = [];
  const reserved: string[] = [];
  const unsafe: string[] = [];

  for (const f of [...target.files].sort((a, b) => bytewise(a.file, b.file))) {
    const rel = normalizeRel(f.file);

    // A receipt or .gitattributes appearing in the snapshot roster means the
    // categorizer did not subtract RESERVED_BASELINE_FILES. Never act on it —
    // acting would delete this producer's own audit trail on the first accept.
    if (isReservedBaselineFile(rel)) {
      reserved.push(f.file);
      continue;
    }
    const problem = checkRelPath(f.file);
    if (problem !== null) {
      unsafe.push(`${f.file} — ${problem.reason}`);
      continue;
    }

    // State wins over verdict: a producer that did not run ok has no verdicts
    // worth reading, and `not-selected` is a claim about the corpus, not the
    // content. Either way the file is untouchable.
    if (f.state === 'not-run' || f.state === 'not-selected') {
      untouched.push(f.file);
      continue;
    }

    const kind = f.verdict.kind;
    if (isEquivalentVerdict(kind)) {
      skippedEquivalent.push(f.file);
      continue;
    }
    if (kind === 'not-run' || kind === 'not-selected') {
      untouched.push(f.file);
      continue;
    }

    const absBaseline = join(target.baselineDir, ...rel.split('/'));
    const repoPath: RepoPath = `${target.outRepo}/${rel}`;

    if (isWritableVerdict(kind)) {
      candidates.push({
        component: target.component,
        producer: target.producer,
        file: rel,
        action: 'write',
        state: f.state,
        verdict: f.verdict,
        baselineSha256: f.baselineSha256,
        receivedSha256: f.receivedSha256,
        bytes: f.bytes,
        absReceived: join(target.receivedDir, ...rel.split('/')),
        absBaseline,
        repoPath,
      });
      continue;
    }

    if (kind === 'deleted') {
      candidates.push({
        component: target.component,
        producer: target.producer,
        file: rel,
        action: 'delete',
        state: f.state,
        verdict: f.verdict,
        baselineSha256: f.baselineSha256,
        receivedSha256: null,
        bytes: f.bytes,
        absReceived: null,
        absBaseline,
        repoPath,
      });
      continue;
    }

    untouched.push(f.file);
  }

  return { target, candidates, skippedEquivalent, untouched, reserved, unsafe };
}

export function buildPlan(targets: readonly AcceptTarget[]): AcceptPlan {
  const plans = targets.map(planTarget);
  const candidates = plans.flatMap((p) => p.candidates);
  return {
    targets: plans,
    candidates,
    writes: candidates.filter((c) => c.action === 'write'),
    deletions: candidates.filter((c) => c.action === 'delete'),
    skippedEquivalent: plans.reduce((n, p) => n + p.skippedEquivalent.length, 0),
  };
}

/** One line per candidate, for `--dry-run` and the pre-review summary. */
export function describeCandidate(c: Candidate): string {
  const verb = c.action === 'delete' ? 'delete' : c.verdict.kind;
  const summary = c.verdict.summary === undefined ? '' : ` — ${c.verdict.summary}`;
  return `${verb.padEnd(10)} ${c.repoPath}${summary}`;
}
