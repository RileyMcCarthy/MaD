/**
 * `src/honesty/` — the join, and the vocabulary of what a report may CLAIM.
 *
 * Every other module answers "what happened". This one answers "what are we
 * allowed to say about it", which is a different and strictly smaller set.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE CEILING, STATED ONCE, HERE, SO NO CALLER CAN CLAIM IT WAS HIDDEN:
 * attribution is COMPONENT-GRANULAR. Change ten files under one producer, move
 * one snapshot, and all ten read `exercised`. That is not a bug to be fixed
 * later by tightening a threshold — it is what the measurement can support.
 * Per-file attribution needs either coverage instrumentation (absent here) or
 * a producer-declared file→snapshot map (more config than anyone maintains).
 * The verdict is therefore named `exercised`, never `witnessed`, `tested` or
 * `covered`, and `ATTRIBUTION_DISCLOSURE` renders verbatim, uncollapsed.
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { ComponentId, Finding, ProducerName, RepoPath, Severity } from '../types.js';
// One definition of a sentence the spec requires VERBATIM. Importing it from
// the emitter is acyclic (emit never imports honesty) and is the only way the
// two copies cannot drift; a drifted disclosure is worse than an ugly import.
import { DISCLOSURE_SENTENCE } from '../emit/index.js';

export const ATTRIBUTION_DISCLOSURE = DISCLOSURE_SENTENCE;

/* ───────────────────────────── attribution ───────────────────────────── */

/**
 * NOT called "witnessed". The tool measures whether a producer's output moved;
 * it does not establish that a specific file was executed.
 *
 * `governance` is an addition to the spec's closed set, and it earns its place:
 * a manifest / registry / lock / receipt edit is neither source behaviour nor
 * an orphan. Folding it into `unclaimed` would fire "no component claims this
 * file" on every legitimate manifest edit — which is how a check gets disabled
 * — and folding it into `exercised` would be a plain lie.
 */
export type Attribution =
  /** A claiming producer ran ok AND a PRE-EXISTING snapshot of its moved. */
  | 'exercised'
  /** A claiming producer ran ok AND nothing pre-existing moved. */
  | 'unexercised'
  /** Claimed only by producers that did not run ok. Never "unchanged". */
  | 'not-run'
  /** Changed, and no component's witnesses claim it. */
  | 'unclaimed'
  /** Every changed line matched a declared cosmetic pattern, or a 100% rename. */
  | 'cosmetic'
  /** Generated output, attributed to the generator rather than to a human edit. */
  | 'derived'
  /** The rules themselves changed: manifest, registry, lock, receipt, ignore. */
  | 'governance'
  /** A `vibes.ignore` rule suppressed the finding this path would have raised. */
  | 'suppressed';

/* ─────────────────────── partial-run vocabulary ──────────────────────── */

/**
 * THE CORE RULE OF PARTIAL RUNS: `unchanged` is a claim about a PRODUCER'S
 * EXECUTION, never about a path. Only that producer's own successful run, this
 * run, can license it.
 *
 * Four states, never three. `not-run` and `unknown` are both non-green and they
 * are still distinct: `not-run` never executed (so its snapshots were never
 * looked at), `unknown` executed and failed (so its out dir may hold garbage).
 * Collapsing them loses the difference between "we did not ask" and "we asked
 * and got a broken answer", and only the second is a bug in the repo.
 *
 * `unknown` is not in `ComponentState`, and that is deliberate: the contract's
 * `SnapState` covers files, `ComponentState` covers rollups, and this covers a
 * producer — the level at which execution is actually decided.
 */
export type ProducerState = 'verified-unchanged' | 'changed' | 'not-run' | 'unknown';

/**
 * V3: `not-run` ALWAYS carries a reason, rendered inline, and may never share a
 * visual treatment with `verified-unchanged`.
 *
 * V10: these do not collapse. Only `skipped-unchanged` is even conditionally
 * honest-by-construction (V6 — and never when input-closure forcing applies);
 * `component-disabled`, `skipped-cli` and `component-unusable` are NOT, so
 * changed files under those components must still surface as unwitnessed.
 * Collapsing them into one "skipped" is the single most damaging simplification
 * available here, and it is forbidden.
 */
export type NotRunReason =
  /** `runWhen: 'changed'` and Vibes computed no change in this component. */
  | 'skipped-unchanged'
  /** Registry `enabled: false`. Carries `disabledReason`/`disabledUntil`. */
  | 'component-disabled'
  /** `--only` / `--skip` excluded it. */
  | 'skipped-cli'
  /** Config resolved but unusable — missing root, invalid manifest. */
  | 'component-unusable'
  /** Manifest present, component dir absent (uninitialised submodule). */
  | 'not-discovered'
  /** Producer tier is outside this invocation's tier. */
  | 'tier-excluded'
  /** A resource lease was held; it never started. */
  | 'blocked'
  /** The runner knows it did not run but has not said why. Narrow it. */
  | 'not-selected';

/** Why an executed producer cannot be trusted. Every one of these is loud. */
export type UnknownReason =
  | 'failed'
  | 'timedOut'
  | 'spawnError'
  | 'emptyOutput'
  | 'cancelled'
  | 'output-ignored'
  | 'output-escaped'
  | 'corpus-floor'
  | 'stale-baseline';

/* ────────────────────────────── findings ─────────────────────────────── */

/**
 * The spec's list, plus three additions marked below. One vocabulary, not two:
 * a code that is declared but never emitted here is emitted by the runner.
 */
export type FindingCode =
  /* attribution */
  | 'unexercised-change'
  | 'not-run'
  | 'unclaimed-change'
  | 'submodule-bump-unclaimed'
  | 'witness-overbroad'
  | 'component-has-no-witnesses'
  /* producer outcomes (emitted by the runner; declared here for one vocabulary) */
  | 'producer-failed'
  | 'producer-empty'
  | 'producer-outdir-gitignored'
  | 'producer-escaped-outdir'
  | 'renderer-error'
  | 'report-truncated'
  /* receipts — the guardrail */
  | 'unreceipted-baseline'
  | 'orphan-snapshot'
  | 'corpus-shrank'
  | 'corpus-changed'
  | 'bulk-accept'
  | 'accept-without-source-change'
  | 'never-ci-verified'
  /** ADDED: a receipt file exists but does not parse as a receipt. Without this
   *  code an unreadable receipt would silently vouch for nothing, which reads
   *  in the report exactly like a clean run. */
  | 'receipt-invalid'
  /* governance */
  | 'policy-weakened'
  | 'policy-changed'
  | 'policy-baseline-missing'
  | 'discovery-shrank'
  /* suppression */
  | 'ignore-file-changed'
  | 'ignore-matches-all'
  | 'suppression-expired'
  | 'suppression-stale'
  /** ADDED: a `vibes.ignore` line is malformed. A silently dropped rule is the
   *  worst outcome — the author believes something is suppressed and it is not,
   *  or believes nothing is and everything is. */
  | 'ignore-parse-error'
  /* run shape */
  | 'partial-run'
  | 'bootstrap'
  | 'no-baseline-range'
  | 'base-approximate';

/**
 * Severity defaults, and the reasoning for the non-obvious ones.
 *
 * `unexercised-change` is a WARNING, deliberately. It is the tool's headline
 * capability ("you changed gcode.ts and no G-code snapshot moved") and it is
 * still not an error, because a pure refactor legitimately moves nothing. An
 * error there would fire on rename-a-variable PRs, and a check that fires on
 * correct work gets disabled — at which point the headline capability is gone
 * for good. Warn, loud, above the fold, uncollapsed.
 *
 * `unreceipted-baseline` and `corpus-shrank` are ERRORS with no strict/lax
 * distinction: they are the two moves that make a snapshot tool lie, and a
 * warning is precisely what an agent clears by accepting.
 */
export const DEFAULT_SEVERITY: Readonly<Record<FindingCode, Severity>> = {
  'unexercised-change': 'warn',
  'not-run': 'warn',
  'unclaimed-change': 'info',
  'submodule-bump-unclaimed': 'warn',
  'witness-overbroad': 'warn',
  'component-has-no-witnesses': 'warn',
  'producer-failed': 'error',
  'producer-empty': 'error',
  'producer-outdir-gitignored': 'error',
  'producer-escaped-outdir': 'error',
  'renderer-error': 'warn',
  'report-truncated': 'info',
  'unreceipted-baseline': 'error',
  'orphan-snapshot': 'warn',
  'corpus-shrank': 'error',
  'corpus-changed': 'info',
  'bulk-accept': 'warn',
  'accept-without-source-change': 'warn',
  'never-ci-verified': 'warn',
  'receipt-invalid': 'error',
  'policy-weakened': 'error',
  'policy-changed': 'warn',
  'policy-baseline-missing': 'info',
  'discovery-shrank': 'error',
  'ignore-file-changed': 'info',
  'ignore-matches-all': 'error',
  'suppression-expired': 'warn',
  'suppression-stale': 'info',
  'ignore-parse-error': 'error',
  'partial-run': 'warn',
  bootstrap: 'info',
  'no-baseline-range': 'error',
  'base-approximate': 'warn',
};

/**
 * Escalations that apply only under `strict` (= CI).
 *
 * `accept-without-source-change` escalates because §5.7 says so: locally it is
 * a mid-work state ("I regenerated, I have not written the code yet"); landing
 * it is the thing being defended against.
 *
 * `policy-baseline-missing` escalates because in CI it is either first adoption
 * (once, deliberate) or a deletion of the only file that can prove a manifest
 * was narrowed (always worth a human).
 */
export const STRICT_ESCALATION: Readonly<Partial<Record<FindingCode, Severity>>> = {
  'accept-without-source-change': 'error',
  'policy-baseline-missing': 'error',
};

/**
 * Codes a `vibes.ignore` rule may never silence.
 *
 * A suppression mechanism that can suppress the guardrail is not a suppression
 * mechanism, it is an off switch — and every one of these codes describes an
 * edit an author made on purpose, so "I did not mean to" is not available.
 */
export const NON_SUPPRESSIBLE: ReadonlySet<FindingCode> = new Set<FindingCode>([
  'unreceipted-baseline',
  'corpus-shrank',
  'receipt-invalid',
  'accept-without-source-change',
  'policy-weakened',
  'discovery-shrank',
  'ignore-matches-all',
  'suppression-expired',
  'ignore-parse-error',
  'no-baseline-range',
]);

/**
 * Codes whose findings must never render inside a collapsed section.
 * Mapped onto `Finding.alwaysExpanded`, which the emitter honours.
 */
export const ALWAYS_EXPANDED: ReadonlySet<FindingCode> = new Set<FindingCode>([
  'unreceipted-baseline',
  'corpus-shrank',
  'bulk-accept',
  'accept-without-source-change',
  'policy-weakened',
  'discovery-shrank',
  'ignore-matches-all',
  'no-baseline-range',
  'unexercised-change',
]);

export interface SeverityPolicy {
  /** CI. Turns the strict-only escalations on. */
  readonly strict: boolean;
  /** `failOn.governanceWeakened`. False demotes `policy-weakened` to a warning. */
  readonly failOnGovernanceWeakened: boolean;
  /** `failOn.honestyViolation`. False demotes every attribution finding to info. */
  readonly failOnHonestyViolation: boolean;
  /** A `Vibes-Weakening-Ack:` trailer on the PR body. Demotes `policy-weakened`
   *  to a warning — the point of the trailer is to make silencing one greppable,
   *  attributable line, not to make it impossible. */
  readonly weakeningAck: string | null;
  readonly overrides?: Readonly<Partial<Record<FindingCode, Severity>>> | undefined;
}

export const DEFAULT_SEVERITY_POLICY: SeverityPolicy = {
  strict: false,
  failOnGovernanceWeakened: true,
  failOnHonestyViolation: true,
  weakeningAck: null,
};

export function severityOf(code: FindingCode, policy: SeverityPolicy): Severity {
  const override = policy.overrides?.[code];
  if (override !== undefined) return override;

  let severity = DEFAULT_SEVERITY[code];
  if (policy.strict) severity = STRICT_ESCALATION[code] ?? severity;

  if (code === 'policy-weakened') {
    if (!policy.failOnGovernanceWeakened) return 'warn';
    if (policy.weakeningAck !== null && policy.weakeningAck.trim() !== '') return 'warn';
  }
  // `failOn.honestyViolation: false` is an explicit, committed decision to stop
  // gating on attribution. It demotes; it never hides — the findings still render.
  if (!policy.failOnHonestyViolation && ATTRIBUTION_CODES.has(code)) return 'info';
  return severity;
}

const ATTRIBUTION_CODES: ReadonlySet<FindingCode> = new Set<FindingCode>([
  'unexercised-change',
  'not-run',
  'unclaimed-change',
  'submodule-bump-unclaimed',
  'witness-overbroad',
  'component-has-no-witnesses',
  'partial-run',
]);

/* ───────────────────────────── the finding ───────────────────────────── */

/**
 * `Finding` (types.ts) plus the fields the honesty layer needs and the shared
 * contract does not carry: the machine code, the producer, the evidence, and
 * the rule that suppressed it.
 *
 * `id` is `<code>` or `<code>:<component>[/<producer>]`. It is PREFIXED BY THE
 * CODE on purpose: the emitters route governance findings above behaviour with
 * `/^(governance|policy|weaken|corpus-shr|unreceipted)/` over `Finding.id`, so
 * `policy-weakened:control` and `unreceipted-baseline:control/domain` land in
 * the Policy section without the emitter needing a field it does not have.
 */
export interface HonestyFinding extends Finding {
  readonly code: FindingCode;
  readonly producer?: ProducerName;
  /** Computed facts only — counts, shas, verbatim tool output. */
  readonly evidence: readonly string[];
  /** Set when a `vibes.ignore` rule silenced this finding. Suppressed findings
   *  are excluded from the failure counts and STILL LISTED, with the rule that
   *  governs them. Silencing is never invisible. */
  readonly suppressedBy: SuppressionRef | null;
}

export interface SuppressionRef {
  readonly glob: string;
  readonly reason: string;
  readonly until: string;
  readonly source: RepoPath;
  readonly line: number;
}

export interface FindingInit {
  readonly code: FindingCode;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly component?: ComponentId | undefined;
  readonly producer?: ProducerName | undefined;
  readonly paths?: readonly RepoPath[] | undefined;
  readonly evidence?: readonly string[] | undefined;
}

export function findingId(
  code: FindingCode,
  component?: ComponentId | undefined,
  producer?: ProducerName | undefined,
): string {
  if (component === undefined) return code;
  return producer === undefined ? `${code}:${component}` : `${code}:${component}/${producer}`;
}

export function makeFinding(init: FindingInit): HonestyFinding {
  return {
    id: findingId(init.code, init.component, init.producer),
    code: init.code,
    severity: init.severity,
    title: init.title,
    detail: init.detail,
    evidence: init.evidence ?? [],
    suppressedBy: null,
    ...(init.component !== undefined ? { component: init.component } : {}),
    ...(init.producer !== undefined ? { producer: init.producer } : {}),
    ...(init.paths !== undefined && init.paths.length > 0 ? { paths: init.paths } : {}),
    ...(ALWAYS_EXPANDED.has(init.code) ? { alwaysExpanded: true } : {}),
  };
}
