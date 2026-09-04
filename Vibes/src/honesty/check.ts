/**
 * `checkHonesty` — the join, and the only place that decides what the report is
 * ALLOWED to claim.
 *
 * Everything upstream answers "what happened": git says which paths changed,
 * the runner says which producers ran, compare says which bytes moved, ingest
 * says which tests passed. This function answers a different and strictly
 * smaller question — "given all that, what may we say?" — and the difference
 * between those two questions is the entire product.
 *
 * Three properties are enforced here and nowhere else:
 *
 *  1. NOTHING IS CLAIMED UNCHANGED THAT WAS NOT EXECUTED. A component whose
 *     producers did not run reaches the report as `not-run` or `partial`, with
 *     a reason, and no arithmetic in this file can promote it.
 *
 *  2. EVERY COMMITTED BASELINE BYTE IS VOUCHED FOR — by the base tree or by a
 *     receipt. The third case is an error that a re-run cannot clear.
 *
 *  3. SILENCING IS NEVER INVISIBLE. A suppressed finding is still listed, with
 *     the rule, the reason and the expiry that govern it, and the guardrail
 *     codes cannot be suppressed at all.
 *
 * It is PURE: no fs, no git, no clock except the injected `now`. Every input is
 * a value some other module already computed, which is what makes the whole
 * honesty layer testable without a repo — and why the tests below construct
 * scenarios directly instead of mocking a git port.
 */

import { notMeasuredSentence } from '../git/index.js';
import type { ChangedSourcePath } from '../git/index.js';
import type { ComponentId, Finding, RepoPath, Severity, Sha } from '../types.js';
import {
  OVERBROAD_FRACTION,
  attribute,
  compileClaims,
  witnessBreadth,
  type AttributionComponent,
  type AttributionResult,
  type ComponentAttribution,
} from './attribution.js';
import { FindingBag, applySuppressions, describePaths, toContractFinding } from './findings.js';
import {
  EMPTY_IGNORE,
  evaluateIgnore,
  matchingRule,
  daysExpired,
  type IgnoreEvaluation,
  type IgnoreFile,
} from './ignore.js';
import {
  ATTRIBUTION_DISCLOSURE,
  DEFAULT_SEVERITY_POLICY,
  severityOf,
  type FindingCode,
  type HonestyFinding,
  type SeverityPolicy,
  type SuppressionRef,
} from './model.js';
import type { LockLiveComparison, PolicyDrift } from './policyLock.js';
import {
  ACCEPT_RATIO_THRESHOLD,
  acceptSignals,
  acceptWithoutSourceChange,
  type ReceiptVerification,
} from './receipts.js';
import {
  componentTally,
  runCoverage,
  unrunSnapshotViolations,
  verificationCoverage,
  type ComponentTally,
  type RosterEntry,
  type RunCoverageLine,
  type UnrunViolation,
  type VerificationCoverage,
} from './state.js';

/* ──────────────────────────────── input ──────────────────────────────── */

/**
 * How loudly to report changed paths that no component claims.
 *
 * The default is `count`, and the reason is a false-positive budget rather than
 * timidity: `docs/**`, `Hardware/**`, `.github/**` and the like will never be
 * claimed in a real repo, and warning about each of them drowns the findings
 * that matter. A check nobody reads is worth nothing.
 */
export type UnclaimedMode = 'silent' | 'count' | 'list' | 'warn';

export interface HonestyInput {
  readonly baseRef: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
  /** From `git/categorize` — changed source, already excluding out dirs. */
  readonly changed: readonly ChangedSourcePath[];
  readonly components: readonly AttributionComponent[];
  /** One per producer whose committed baseline was scanned. */
  readonly verifications?: readonly ReceiptVerification[] | undefined;
  /** The COMMITTED policy-lock roster. Empty ⇒ completeness is unassertable. */
  readonly roster?: readonly RosterEntry[] | undefined;
  readonly drift?: PolicyDrift | null | undefined;
  readonly lockLive?: LockLiveComparison | null | undefined;
  /** The committed lock exists but does not parse. */
  readonly lockError?: string | null | undefined;
  readonly ignore?: IgnoreFile | null | undefined;
  /** `vibes.ignore` itself moved in this diff. */
  readonly ignoreFileChanged?: boolean | undefined;
  /** `git ls-files` at HEAD. Enables the advisory breadth check. */
  readonly tracked?: readonly RepoPath[] | undefined;
  readonly baseConfidence?: 'exact' | 'approximate' | undefined;
  readonly policy?: Partial<SeverityPolicy> | undefined;
  readonly unclaimedMode?: UnclaimedMode | undefined;
  readonly renameIsCosmetic?: boolean | undefined;
  /** Emit `producer-failed`/`producer-empty` from producer outcomes.
   *  Default true. Turn it off only if the composer already lifts the runner's
   *  own diagnostics into `RunReport.findings` — two vocabularies describing
   *  one crash reads as two crashes. */
  readonly emitProducerOutcomes?: boolean | undefined;
  readonly now?: Date | undefined;
}

/* ─────────────────────────────── output ──────────────────────────────── */

export interface HonestyResult {
  readonly attribution: AttributionResult;
  readonly tallies: readonly ComponentTally[];
  readonly coverage: VerificationCoverage;
  readonly runCoverage: RunCoverageLine;
  readonly ignore: IgnoreEvaluation;
  /** Every finding, suppressed ones included and marked. */
  readonly findings: readonly HonestyFinding[];
  /** The findings that count towards failure. */
  readonly effective: readonly HonestyFinding[];
  readonly suppressed: readonly HonestyFinding[];
  readonly counts: Readonly<Record<Severity, number>> & { readonly suppressed: number };
  readonly fullyVerified: boolean;
  /** 0 clean · 1 findings. `2` is the CLI's, for a tool/environment error. */
  readonly exitCode: 0 | 1;
  /** A caller invariant was broken: a producer that did not run ok has
   *  snapshot files in a state other than `not-run`. Never empty in a correct
   *  run; see `assertInvariants`. */
  readonly invariantViolations: readonly UnrunViolation[];
  readonly severityPolicy: SeverityPolicy;
  /** Renders verbatim, uncollapsed. The ceiling, stated to the reader. */
  readonly disclosure: string;
}

export function assertInvariants(r: HonestyResult): void {
  if (r.invariantViolations.length === 0) return;
  const first = r.invariantViolations[0];
  throw new Error(
    `honesty invariant V2 broken: ${String(r.invariantViolations.length)} snapshot file(s) under a producer that did not run ok are not stamped \`not-run\` — ` +
      `e.g. ${first?.component ?? '?'}/${first?.producer ?? '?'} ${first?.file ?? '?'} is \`${first?.state ?? '?'}\`. ` +
      'Files under a producer that did not run must be stamped before git is consulted.',
  );
}

/* ═══════════════════════════════ the join ═════════════════════════════ */

export function checkHonesty(input: HonestyInput): HonestyResult {
  const policy: SeverityPolicy = { ...DEFAULT_SEVERITY_POLICY, ...input.policy };
  const now = input.now ?? new Date();
  const unclaimedMode = input.unclaimedMode ?? 'count';
  const verifications = input.verifications ?? [];

  /* ── suppression first: attribution needs to know what is silenced ──── */
  const ignoreFile = input.ignore ?? EMPTY_IGNORE;
  const universe = suppressionUniverse(input, verifications);
  const ignore = evaluateIgnore(ignoreFile, now, universe);
  // A rule set that silences everything silences itself: it is reported, and
  // it is NOT allowed to suppress anything, or the check has an off switch.
  const neutralised = ignore.matchesAll.length > 0 || ignore.suppressesEverything;
  const active = neutralised ? [] : ignore.active;
  const suppressionFor = (p: RepoPath): SuppressionRef | null => {
    const rule = matchingRule([p], active);
    return rule === null
      ? null
      : { glob: rule.glob, reason: rule.reason, until: rule.until, source: rule.source, line: rule.line };
  };

  /* ── attribution and state ──────────────────────────────────────────── */
  const attribution = attribute({
    changed: input.changed,
    components: input.components,
    ...(input.renameIsCosmetic !== undefined ? { renameIsCosmetic: input.renameIsCosmetic } : {}),
    suppressionFor,
  });
  const tallies = input.components.map(componentTally);
  const talliesById = new Map(tallies.map((t) => [t.component, t]));
  const coverage = verificationCoverage(input.roster ?? [], input.components);
  const run = runCoverage(tallies, coverage);

  /* ── findings ───────────────────────────────────────────────────────── */
  const bag = new FindingBag();
  const sev = (code: FindingCode): Severity => severityOf(code, policy);

  emitAttribution(bag, sev, input, attribution, talliesById, unclaimedMode);
  emitReceipts(bag, sev, input, verifications, attribution);
  emitPolicy(bag, sev, input, coverage);
  emitIgnore(bag, sev, ignore, input.ignoreFileChanged === true, now);
  emitRunShape(bag, sev, input, coverage, tallies);

  const outcome = applySuppressions(bag.sorted(), active);
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of outcome.effective) counts[f.severity] += 1;

  return {
    attribution,
    tallies,
    coverage,
    runCoverage: run,
    ignore,
    findings: outcome.all,
    effective: outcome.effective,
    suppressed: outcome.suppressed,
    counts: { ...counts, suppressed: outcome.suppressed.length },
    fullyVerified: coverage.fullyVerified,
    exitCode: counts.error > 0 ? 1 : 0,
    invariantViolations: unrunSnapshotViolations(input.components),
    severityPolicy: policy,
    disclosure: ATTRIBUTION_DISCLOSURE,
  };
}

/**
 * Everything a `vibes.ignore` rule could plausibly be written against: the
 * changed source paths and the committed snapshot paths. A rule matching none
 * of it is silencing nothing, which is what `suppression-stale` exists to say.
 */
function suppressionUniverse(
  input: HonestyInput,
  verifications: readonly ReceiptVerification[],
): readonly RepoPath[] {
  const out = new Set<RepoPath>();
  for (const c of input.changed) {
    out.add(c.path);
    if (c.oldPath !== null) out.add(c.oldPath);
  }
  for (const v of verifications) {
    for (const f of v.files) out.add(f.repoPath);
    for (const d of v.deletions) out.add(d.repoPath);
  }
  return [...out].sort(cmp);
}

/* ───────────────────────────── attribution ───────────────────────────── */

function emitAttribution(
  bag: FindingBag,
  sev: (c: FindingCode) => Severity,
  input: HonestyInput,
  attribution: AttributionResult,
  tallies: ReadonlyMap<ComponentId, ComponentTally>,
  unclaimedMode: UnclaimedMode,
): void {
  for (const c of attribution.components) {
    const tally = tallies.get(c.component);
    const claimed = sortPaths(c.claimedPaths);
    if (claimed.length === 0) continue;

    if (c.verdict === 'not-run') {
      bag.add({
        code: 'not-run',
        severity: sev('not-run'),
        component: c.component,
        title: `${claimed.length === 1 ? '1 changed file claims' : `${String(claimed.length)} changed files claim`} \`${c.component}\`, which was not evaluated`,
        detail:
          `${describePaths(claimed)} ${claimed.length === 1 ? 'is' : 'are'} claimed by \`${c.component}\`, ` +
          `but ${c.coveringReason}. Nothing in this run can say whether their behaviour moved.`,
        paths: claimed,
        evidence: [
          c.coveringReason,
          `${String(c.ranProducers)} of ${String(c.totalProducers)} producers ran ok`,
        ],
      });
      continue;
    }

    // A bootstrapping component moves nothing PRE-EXISTING by definition —
    // there is no pre-existing corpus. Reporting that as `unexercised-change`
    // would put a wall of red on every first adoption, and the first person to
    // see it would delete the check rather than read it.
    if (c.verdict === 'unexercised' && tally?.state !== 'bootstrap') {
      bag.add({
        code: 'unexercised-change',
        severity: sev('unexercised-change'),
        component: c.component,
        title: `${claimed.length === 1 ? '1 changed file claims' : `${String(claimed.length)} changed files claim`} \`${c.component}\`, whose snapshots did not move`,
        detail:
          `Every producer in \`${c.component}\` ran ok and no PRE-EXISTING snapshot changed, ` +
          `while ${describePaths(claimed)} changed. That is either a genuine no-op refactor or a gap in what the ` +
          'snapshots cover — this run cannot tell which, and says so rather than guessing.',
        paths: claimed,
        evidence: [
          `${String(c.ranProducers)} of ${String(c.totalProducers)} producers ran ok`,
          'added snapshots are not counted as evidence: a new corpus entry proves the corpus grew, not that existing code ran',
        ],
      });
    }
  }

  /* structural claims about the witnesses themselves */
  for (const comp of input.components) {
    if (comp.status !== 'active' || comp.producers.length === 0) continue;
    const positives = comp.witnesses.filter((w) => !w.startsWith('!'));
    if (positives.length === 0) {
      bag.add({
        code: 'component-has-no-witnesses',
        severity: sev('component-has-no-witnesses'),
        component: comp.id,
        title: `\`${comp.id}\` has ${String(comp.producers.length)} producers and claims no source`,
        detail:
          `Snapshots that claim no source cannot support an "unchanged" verdict for anything. ` +
          `Declare \`witnesses\` in ${comp.root}/vibes/vibes.manifest.mjs.`,
        evidence: [`producers: ${comp.producers.map((p) => p.name).join(', ')}`],
      });
    }
  }

  const tracked = input.tracked ?? [];
  if (tracked.length > 0) {
    for (const b of witnessBreadth(input.components, tracked)) {
      if (b.fraction <= OVERBROAD_FRACTION) continue;
      bag.add({
        code: 'witness-overbroad',
        severity: sev('witness-overbroad'),
        component: b.component,
        title: `\`${b.component}\` claims ${pct(b.fraction)} of the tracked repo`,
        detail:
          `A component claiming most of the repo makes \`exercised\` mean almost nothing: any change anywhere ` +
          'lands under it. This is advisory and never gates — the threshold is borrowed, not measured, and gating ' +
          'on a borrowed constant teaches people to disable checks.',
        evidence: [
          `${String(b.matched)} of ${String(b.tracked)} tracked files match`,
          `advisory threshold ${pct(OVERBROAD_FRACTION)}`,
        ],
      });
    }
  }

  /* changed paths no component claims at all */
  if (unclaimedMode !== 'silent' && attribution.unclaimed.length > 0) {
    const paths = sortPaths(attribution.unclaimed);
    bag.add({
      code: 'unclaimed-change',
      // `warn` mode is the only one that raises the floor; the rest report at
      // the code's default so a repo full of docs changes stays readable.
      severity: unclaimedMode === 'warn' ? 'warn' : sev('unclaimed-change'),
      title: `${String(paths.length)} changed ${paths.length === 1 ? 'path is' : 'paths are'} claimed by no component`,
      detail:
        `${describePaths(paths, unclaimedMode === 'count' ? 3 : 10)} — no component's \`witnesses\` claim ` +
        `${paths.length === 1 ? 'it' : 'them'}, so no snapshot in this run says anything about ` +
        `${paths.length === 1 ? 'its' : 'their'} behaviour.`,
      paths,
      evidence: [`unclaimed mode: ${unclaimedMode}`],
    });
  }

  if (attribution.undeclaredGitlinks.length > 0) {
    const paths = sortPaths(attribution.undeclaredGitlinks);
    bag.add({
      code: 'submodule-bump-unclaimed',
      severity: sev('submodule-bump-unclaimed'),
      title: `${String(paths.length)} submodule pin${paths.length === 1 ? '' : 's'} moved and no component declares ${paths.length === 1 ? 'it' : 'them'}`,
      detail:
        `${describePaths(paths)} changed as a gitlink. ` +
        paths.map((p) => notMeasuredSentence(p)).join(' ') +
        ' Declare the path under `components[].submodules` so a pin bump forces the owning component to run.',
      paths,
      evidence: paths.map((p) => `gitlink ${p}`),
    });
  }
}

/* ────────────────────────────── receipts ─────────────────────────────── */

function emitReceipts(
  bag: FindingBag,
  sev: (c: FindingCode) => Severity,
  input: HonestyInput,
  verifications: readonly ReceiptVerification[],
  attribution: AttributionResult,
): void {
  const claimedByComponent = new Map<ComponentId, ComponentAttribution>(
    attribution.components.map((c) => [c.component, c]),
  );
  const ciVerified = new Map<string, boolean>();
  for (const c of input.components) {
    for (const p of c.producers) ciVerified.set(`${c.id}/${p.name}`, p.everCIVerified);
  }

  for (const v of verifications) {
    const where = { component: v.component, producer: v.producer };

    if (v.invalidReceipts.length > 0) {
      bag.add({
        ...where,
        code: 'receipt-invalid',
        severity: sev('receipt-invalid'),
        title: `an accept receipt in \`${v.outDir}\` does not parse`,
        detail:
          'A receipt that does not parse vouches for nothing, and "vouches for nothing" must not read like a ' +
          'clean run — otherwise the cheapest way to defeat the guardrail is a typo. Repair or regenerate it ' +
          'with `vibes accept`.',
        paths: sortPaths(v.invalidReceipts.map((r) => r.path)),
        evidence: v.invalidReceipts.map((r) => `${r.path}: ${r.message}`),
      });
    }

    if (v.unreceipted.length > 0) {
      const paths = sortPaths(v.unreceipted.map((f) => f.repoPath));
      bag.add({
        ...where,
        code: 'unreceipted-baseline',
        severity: sev('unreceipted-baseline'),
        title: `${String(v.unreceipted.length)} committed baseline file${v.unreceipted.length === 1 ? '' : 's'} in \`${v.outDir}\` ${v.unreceipted.length === 1 ? 'is' : 'are'} vouched for by nothing`,
        detail:
          `Their bytes differ from the baseline at \`${input.baseSha.slice(0, 8)}\` and no receipt in that ` +
          'directory names them. This is what `git add -A && git commit` looks like from here, and it is what ' +
          'hand-editing a snapshot looks like too. Re-run the producer and `vibes accept` the result, which ' +
          'writes a receipt recording who accepted what and why.',
        paths,
        evidence: v.unreceipted
          .slice(0, 20)
          .map(
            (f) =>
              `${f.file}: now ${f.sha256.slice(0, 12)}, at base ${f.baseSha256 === null ? '(absent)' : f.baseSha256.slice(0, 12)} — ${f.note}`,
          ),
      });
    }

    if (v.unreceiptedDeletions.length > 0) {
      const paths = sortPaths(v.unreceiptedDeletions.map((d) => d.repoPath));
      bag.add({
        ...where,
        code: 'corpus-shrank',
        severity: sev('corpus-shrank'),
        title: `${String(paths.length)} baseline file${paths.length === 1 ? '' : 's'} removed from \`${v.outDir}\` with no receipt`,
        detail:
          'A corpus that shrinks makes the diff it used to produce disappear, which is indistinguishable from ' +
          'fixing it. Deletions need a receipt: `vibes accept --accept-deletions=<n> --reason=<text>`, recorded ' +
          'verbatim. This is an error rather than a warning on purpose — a warning is precisely what an agent ' +
          'clears by accepting.',
        paths,
        evidence: v.unreceiptedDeletions
          .slice(0, 20)
          .map((d) => `${d.file}: present at base (${d.baseSha256.slice(0, 12)}), absent now`),
      });
    }

    if (v.orphanEntries.length > 0) {
      bag.add({
        ...where,
        code: 'orphan-snapshot',
        severity: sev('orphan-snapshot'),
        title: `${String(v.orphanEntries.length)} receipt entr${v.orphanEntries.length === 1 ? 'y names a file' : 'ies name files'} that no longer exist${v.orphanEntries.length === 1 ? 's' : ''}`,
        detail:
          `A receipt in \`${v.outDir}\` vouches for content that is not in the baseline any more. Usually the ` +
          'file was removed without accepting the removal; sometimes the receipt was hand-edited.',
        paths: sortPaths(v.orphanEntries.map((o) => o.repoPath)),
        evidence: v.orphanEntries.slice(0, 20).map((o) => `${o.receiptId} still names ${o.file}`),
      });
    }

    const added = v.files.filter((f) => f.baseSha256 === null).length;
    const receiptedDeletions = v.deletions.length - v.unreceiptedDeletions.length;
    if (!v.bootstrap && (added > 0 || receiptedDeletions > 0)) {
      bag.add({
        ...where,
        code: 'corpus-changed',
        severity: sev('corpus-changed'),
        title: `the corpus in \`${v.outDir}\` changed shape`,
        detail:
          `${String(added)} file${added === 1 ? '' : 's'} added, ${String(receiptedDeletions)} removed with a receipt. ` +
          'Corpus shape is reported separately from behaviour because a growing corpus is not evidence that ' +
          'existing behaviour was exercised.',
        evidence: [
          `${String(v.counts.total)} baseline files: ${String(v.counts.unchanged)} unchanged, ${String(v.counts.accepted)} accepted, ${String(v.counts.unreceipted)} unreceipted`,
        ],
      });
    }

    if (v.bootstrap) {
      bag.add({
        ...where,
        code: 'bootstrap',
        severity: sev('bootstrap'),
        title: `\`${v.outDir}\` has no committed baseline yet`,
        detail:
          'Nothing was committed under this out dir at base, so there is nothing to compare against and no ' +
          'regression is possible. The first accept records the baseline; until then this producer proves nothing.',
        evidence: [`${String(v.counts.total)} files present at HEAD, 0 at base`],
      });
    }

    /* ── the accept counter-signals ─────────────────────────────────── */
    const signals = acceptSignals(v);
    const claimed = claimedByComponent.get(v.component)?.claimedPaths ?? [];

    for (const s of signals.filter((x) => x.bulk)) {
      bag.add({
        ...where,
        code: 'bulk-accept',
        severity: sev('bulk-accept'),
        title: `${String(s.accepted)} snapshot${s.accepted === 1 ? ' was' : 's were'} accepted in bulk`,
        detail:
          `Receipt \`${s.receiptId}\` records mode \`${s.mode}\` by \`${s.acceptedBy}\`: ` +
          `"${s.reason}". A bulk accept is not prevented — it is made visible, attributable and expensive. ` +
          'This row is what "expensive" means.',
        evidence: [
          `accepted ${String(s.accepted)} of ${String(s.changed)} changed (ratio ${s.acceptRatio.toFixed(2)})`,
          `acceptedBy: ${s.acceptedBy}`,
          `reason: ${s.reason}`,
        ],
      });
    }

    for (const s of acceptWithoutSourceChange(signals, claimed.length)) {
      bag.add({
        ...where,
        code: 'accept-without-source-change',
        severity: sev('accept-without-source-change'),
        title: `${pct(s.acceptRatio)} of changed snapshots accepted while no claimed source changed`,
        detail:
          `Receipt \`${s.receiptId}\` accepted ${String(s.accepted)} of ${String(s.changed)} changed files, ` +
          `and nothing matched by \`${v.component}\`'s witnesses changed in this diff. That is the signature of ` +
          'regenerating until the report is green. If the behaviour genuinely changed, the source that changed it ' +
          'should be claimed by a witness; if it did not, the producer is nondeterministic and needs a scrubber.',
        evidence: [
          `acceptRatio ${s.acceptRatio.toFixed(2)} > ${String(ACCEPT_RATIO_THRESHOLD)}`,
          `changed source paths claimed by \`${v.component}\`: 0`,
          s.changedWitnessPathsAtAccept === null
            ? 'the receipt records no source context'
            : `the receipt recorded ${String(s.changedWitnessPathsAtAccept.length)} changed witness paths at accept time`,
        ],
      });
    }

    const everCI = ciVerified.get(`${v.component}/${v.producer}`) ?? true;
    const unverified = signals.filter((s) => s.unverifiedProducer);
    if (v.newReceipts.length > 0 && (!everCI || unverified.length > 0)) {
      bag.add({
        ...where,
        code: 'never-ci-verified',
        severity: sev('never-ci-verified'),
        title: `\`${v.component}/${v.producer}\` has never completed in CI`,
        detail:
          'Its snapshots are locally accepted and never CI-verified, so they record what one machine produced ' +
          'rather than what the pipeline reproduces. Until the producer completes in CI, a green comparison here ' +
          'is a statement about a laptop.',
        evidence: v.newReceipts.map((r) => `receipt ${r.id} (${r.mode}) by ${r.acceptedBy}`),
      });
    }
  }
}

/* ───────────────────────────── governance ───────────────────────────── */

function emitPolicy(
  bag: FindingBag,
  sev: (c: FindingCode) => Severity,
  input: HonestyInput,
  coverage: VerificationCoverage,
): void {
  const drift = input.drift ?? null;

  if (input.lockError != null && input.lockError !== '') {
    bag.add({
      code: 'policy-baseline-missing',
      severity: sev('policy-baseline-missing'),
      title: 'the committed policy lock does not parse',
      detail:
        'Without a readable `.vibes/policy.lock.json` at base, no weakening of the rules can be detected: a ' +
        'narrowed witness, a raised epsilon and a removed producer all become invisible. Regenerate and commit it.',
      paths: ['.vibes/policy.lock.json'],
      evidence: [input.lockError],
    });
  } else if ((drift !== null && drift.baseMissing) || coverage.rosterSource === 'none') {
    bag.add({
      code: 'policy-baseline-missing',
      severity: sev('policy-baseline-missing'),
      title: 'no committed policy lock at base',
      detail:
        'This is either first adoption — which happens once and is deliberate — or a deletion of the only file ' +
        'that can prove a manifest was narrowed. Until one is committed, the run cannot assert that every ' +
        'declared producer was evaluated, so nothing in this report may be called complete.',
      paths: ['.vibes/policy.lock.json'],
      evidence: [coverage.reason],
    });
  }

  if (drift !== null) {
    for (const d of drift.deltas) {
      const code: FindingCode = d.weakening ? 'policy-weakened' : 'policy-changed';
      const paths = d.lost.length > 0 ? sortPaths(d.lost) : undefined;
      bag.add({
        code,
        severity: sev(code),
        ...(d.component !== null ? { component: d.component } : {}),
        ...(d.producer !== null ? { producer: d.producer } : {}),
        title: d.weakening
          ? `the rules got weaker${d.component === null ? '' : ` for \`${d.component}\``}`
          : `the rules changed${d.component === null ? '' : ` for \`${d.component}\``}`,
        detail: d.weakening
          ? `${d.detail}. A weakened rule explains away everything below it, which is why this renders above the ` +
            'behaviour section. Silencing it takes one greppable, attributable line: a `Vibes-Weakening-Ack:` ' +
            'trailer on the PR body.'
          : `${d.detail}.`,
        ...(paths !== undefined ? { paths } : {}),
        evidence: [
          `${d.kind} at ${d.locator}`,
          `before: ${d.before ?? '(absent)'}`,
          `after: ${d.after ?? '(absent)'}`,
          ...(d.lost.length > 0
            ? [`no longer claimed: ${d.lost.slice(0, 10).join(', ')}${d.lost.length > 10 ? ` (+${String(d.lost.length - 10)} more)` : ''}`]
            : []),
        ],
      });
    }
  }

  const live = input.lockLive ?? null;
  if (live !== null) {
    if (live.missingComponents.length > 0 || live.missingProducers.length > 0) {
      const names = [
        ...live.missingComponents.map((c) => c),
        ...live.missingProducers.map((p) => `${p.component}/${p.producer}`),
      ].sort(cmp);
      bag.add({
        code: 'discovery-shrank',
        severity: sev('discovery-shrank'),
        title: `${String(names.length)} thing${names.length === 1 ? '' : 's'} in the committed policy lock no longer resolve${names.length === 1 ? 's' : ''}`,
        detail:
          'The committed lock enumerates producers this run cannot find. That is the cheapest total-silencing ' +
          'edit available, and the lock is the only thing that can see it — the live configuration by ' +
          'construction agrees with itself.',
        paths: ['.vibes/policy.lock.json'],
        evidence: names.map((n) => `${n} is in the lock and not in the resolved configuration`),
      });
    } else if (live.stale) {
      bag.add({
        code: 'policy-changed',
        severity: sev('policy-changed'),
        title: 'the committed policy lock does not match the resolved configuration',
        detail:
          'Regenerating the lock in the same commit is the intended flow — the diff is the signal. A stale lock ' +
          'means the governance comparison is being made against rules that are no longer in force.',
        paths: ['.vibes/policy.lock.json'],
        evidence:
          live.addedComponents.length > 0
            ? [`components resolved but absent from the lock: ${live.addedComponents.join(', ')}`]
            : ['the fingerprints differ'],
      });
    }
  }
}

/* ───────────────────────────── suppression ──────────────────────────── */

function emitIgnore(
  bag: FindingBag,
  sev: (c: FindingCode) => Severity,
  ignore: IgnoreEvaluation,
  fileChanged: boolean,
  now: Date,
): void {
  const source = ignore.file.source;

  if (ignore.file.errors.length > 0) {
    bag.add({
      code: 'ignore-parse-error',
      severity: sev('ignore-parse-error'),
      title: `${String(ignore.file.errors.length)} unusable line${ignore.file.errors.length === 1 ? '' : 's'} in \`${source}\``,
      detail:
        'A malformed suppression is dropped, and a silently dropped rule is the worst outcome available: the ' +
        'author believes something is suppressed and it is not, or believes nothing is and everything is. ' +
        'Every line reads `<glob> :: <reason> :: until=YYYY-MM-DD`.',
      paths: [source],
      evidence: ignore.file.errors.map((e) => `${source}:${String(e.line)}: ${e.message} — ${e.fix}`),
    });
  }

  if (ignore.matchesAll.length > 0 || ignore.suppressesEverything) {
    bag.add({
      code: 'ignore-matches-all',
      severity: sev('ignore-matches-all'),
      title: `\`${source}\` suppresses everything this run could report`,
      detail:
        'A suppression mechanism that can suppress everything is not a suppression mechanism, it is an off ' +
        'switch. No rule in this file is applied while that is true — the findings below are unsuppressed.',
      paths: [source],
      evidence:
        ignore.matchesAll.length > 0
          ? ignore.matchesAll.map((r) => `${source}:${String(r.line)}: \`${r.glob}\` matches every path`)
          : [
              `${String(ignore.active.length)} active rules between them cover all ${String(ignore.universeSize)} candidate paths`,
            ],
    });
  }

  if (ignore.expired.length > 0) {
    bag.add({
      code: 'suppression-expired',
      severity: sev('suppression-expired'),
      title: `${String(ignore.expired.length)} suppression${ignore.expired.length === 1 ? '' : 's'} in \`${source}\` expired`,
      detail:
        'Expiry is the whole mechanism: without it this file is an off switch with a comment on it. These rules ' +
        'no longer suppress anything, and the findings they used to cover are reported below.',
      paths: [source],
      evidence: ignore.expired.map(
        (r) =>
          `${source}:${String(r.line)}: \`${r.glob}\` expired ${String(daysExpired(r, now))} days ago (until ${r.until}) — "${r.reason}"`,
      ),
    });
  }

  if (ignore.stale.length > 0) {
    bag.add({
      code: 'suppression-stale',
      severity: sev('suppression-stale'),
      title: `${String(ignore.stale.length)} suppression${ignore.stale.length === 1 ? '' : 's'} in \`${source}\` matched nothing`,
      detail:
        'These rules silenced nothing this run and will keep silencing nothing until someone reads the file. ' +
        'That reading is what this row exists to cause.',
      paths: [source],
      evidence: ignore.stale.map((r) => `${source}:${String(r.line)}: \`${r.glob}\` — "${r.reason}"`),
    });
  }

  if (fileChanged) {
    bag.add({
      code: 'ignore-file-changed',
      severity: sev('ignore-file-changed'),
      title: `\`${source}\` changed in this diff`,
      detail:
        'The rules governing what this report is allowed to stay quiet about were edited in the same change the ' +
        'report is describing. Worth one look at the diff.',
      paths: [source],
      evidence: [
        `${String(ignore.active.length)} active, ${String(ignore.expired.length)} expired, ${String(ignore.file.errors.length)} unusable`,
      ],
    });
  }
}

/* ────────────────────────────── run shape ───────────────────────────── */

function emitRunShape(
  bag: FindingBag,
  sev: (c: FindingCode) => Severity,
  input: HonestyInput,
  coverage: VerificationCoverage,
  tallies: readonly ComponentTally[],
): void {
  if (input.baseSha === input.headSha) {
    bag.add({
      code: 'no-baseline-range',
      severity: sev('no-baseline-range'),
      title: 'base and HEAD are the same commit',
      detail:
        `\`${input.baseRef}\` resolved to the commit under test, so the diff is empty and every comparison in ` +
        'this report is a file against itself. The run is vacuously green and proves nothing. On a push to the ' +
        'default branch, pass an explicit `--base HEAD~1`.',
      evidence: [`${input.baseRef} → ${input.baseSha.slice(0, 12)} === HEAD`],
    });
  }

  if (input.baseConfidence === 'approximate') {
    bag.add({
      code: 'base-approximate',
      severity: sev('base-approximate'),
      title: 'the comparison base is approximate',
      detail:
        'The base could not be resolved exactly — usually a shallow clone whose graft boundary hides the real ' +
        'merge base. Findings below may be attributed to the wrong commits. Set `fetch-depth: 0`, or pass ' +
        '`VIBES_BASE_SHA`.',
      evidence: [`${input.baseRef} → ${input.baseSha.slice(0, 12)} (approximate)`],
    });
  }

  if (coverage.rosterSource === 'policy-lock' && !coverage.fullyVerified) {
    const rows = [...coverage.missing, ...coverage.notOk];
    bag.add({
      code: 'partial-run',
      severity: sev('partial-run'),
      title: `${String(coverage.evaluated)} of ${String(coverage.declared)} declared producers were evaluated`,
      detail:
        'Completeness is measured against the committed policy lock, not against what this invocation happened ' +
        'to discover — a component that vanished from discovery cannot make the run look complete. Nothing in ' +
        'this report may be described as unchanged while this row is present.',
      evidence: rows.map((r) => `${r.component}/${r.producer}: ${r.detail}`),
    });
  }

  if (input.emitProducerOutcomes === false) return;
  for (const t of tallies) {
    for (const p of t.producers) {
      if (p.state !== 'unknown') continue;
      const code: FindingCode = p.outcome === 'emptyOutput' ? 'producer-empty' : 'producer-failed';
      bag.add({
        code,
        severity: sev(code),
        component: p.component,
        producer: p.producer,
        title: `producer \`${p.component}/${p.producer}\` did not produce a usable result`,
        detail:
          `${p.reason}. Its out dir cannot be compared, so every snapshot under it is \`not-run\` — a failed ` +
          "producer's partial output is never treated as a baseline, and its committed baseline is never " +
          'compared against itself to make the row go quiet.',
        evidence: [`outcome: ${p.outcome}`, `reason: ${p.unknownReason ?? p.outcome}`],
      });
    }
  }
}

/* ───────────────────────────── projections ──────────────────────────── */

/** The findings the contract's `ComponentResult.findings` should carry. */
export function findingsForComponent(
  result: HonestyResult,
  component: ComponentId,
): readonly Finding[] {
  return result.findings.filter((f) => f.component === component).map(toContractFinding);
}

/** The findings the contract's `RunReport.findings` should carry: everything
 *  not already attached to a component, so the two lists do not double up. */
export function runFindings(result: HonestyResult): readonly Finding[] {
  return result.findings.filter((f) => f.component === undefined).map(toContractFinding);
}

/** `ComponentResult.exercisedWitnessPaths` / `.unclaimedPaths`, per component. */
export function witnessPathsFor(
  result: HonestyResult,
  component: ComponentId,
): { readonly exercisedWitnessPaths: readonly RepoPath[]; readonly unclaimedPaths: readonly RepoPath[] } {
  const c = result.attribution.components.find((x) => x.component === component);
  return {
    exercisedWitnessPaths: c === undefined ? [] : sortPaths(c.claimedPaths),
    unclaimedPaths: c === undefined ? [] : sortPaths(c.unclaimedPaths),
  };
}

/** True when `component` claims `path`. Exported because the accept flow needs
 *  the same answer the report gives, and two implementations would drift. */
export function componentClaims(component: AttributionComponent, path: RepoPath): boolean {
  return compileClaims(component)(path);
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function sortPaths(paths: readonly RepoPath[]): readonly RepoPath[] {
  return [...new Set(paths)].sort(cmp);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pct(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}
