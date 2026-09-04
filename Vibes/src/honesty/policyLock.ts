/**
 * `.vibes/policy.lock.json` — self-governance.
 *
 * The lock is a canonical, key-sorted fingerprint of every rule that decides
 * what gets measured: the registry (identity, existence, scope, suppression,
 * the dependency graph) and each manifest's mechanics (producers, out dirs,
 * compare modes and every epsilon, tier, ciJob, witnesses, ingest).
 *
 * WHY A COMMITTED LOCK AND NOT "just diff the manifests":
 * diffing manifests means EVALUATING a `.mjs` from the base commit — arbitrary
 * historical JS from a branch, in-process. Comparing lock-to-lock is comparing
 * DATA, so no historical code is ever run. That is the entire reason this file
 * exists, and it is not negotiable for a convenience.
 *
 * WHAT IS DELIBERATELY NOT FINGERPRINTED: producer `cmd` strings. They churn
 * benignly (a flag, a path, a renamed script) and every churn would render as
 * policy drift, which is how a governance section gets skimmed and then
 * ignored. The run log carries the resolved command.
 *
 * Regenerating the lock in the same commit is the INTENDED flow. The diff is
 * the signal: a weakened rule is one hunk in one file that a human can see, and
 * `Vibes-Weakening-Ack:` makes silencing it one greppable, attributable line.
 * That is the whole moat, and §8.3 is honest that it only works if someone reads.
 */

import type {
  ComponentId,
  CompareMode,
  CompareRule,
  CompareSpec,
  FailPolicy,
  Glob,
  IsoDate,
  ProducerName,
  RendererId,
  RepoPath,
  RunWhen,
  Sha,
} from '../types.js';
import type { GitRepo } from '../git/index.js';
import type { ComponentPlan, ResolvedConfig } from '../config/index.js';

import picomatch from 'picomatch';

export const POLICY_LOCK_PATH: RepoPath = '.vibes/policy.lock.json';
export const POLICY_LOCK_SCHEMA = 'vibes-policy/1';

/* ────────────────────────────── the lock ─────────────────────────────── */

export interface PolicyProducer {
  readonly name: ProducerName;
  readonly out: RepoPath;
  readonly tier: string;
  readonly ciJob: string | null;
  readonly runWhen: RunWhen;
  readonly minCases: number | null;
  readonly clean: boolean;
  readonly renderer: RendererId | null;
  readonly resources: readonly string[];
  readonly compare: readonly PolicyCompareRule[];
}

export interface PolicyCompareRule {
  readonly match: Glob;
  readonly kind: CompareMode['kind'];
  readonly abs: number | null;
  readonly rel: number | null;
  readonly columns: readonly string[] | null;
  readonly maxDiffRatio: number | null;
  readonly threshold: number | null;
}

export interface PolicyComponent {
  readonly id: ComponentId;
  readonly root: RepoPath;
  readonly enabled: boolean;
  readonly disabledUntil: IsoDate | null;
  readonly dependsOn: readonly ComponentId[];
  readonly generates: readonly Glob[];
  readonly submodules: readonly RepoPath[];
  /** Repo-anchored, so a lock row means the same thing after a root move. */
  readonly witnesses: readonly Glob[];
  readonly ingestRequired: boolean | null;
  readonly producers: readonly PolicyProducer[];
}

export interface PolicyLock {
  readonly schema: typeof POLICY_LOCK_SCHEMA;
  readonly version: 1;
  readonly baseRef: string;
  readonly failOn: Required<FailPolicy>;
  readonly components: readonly PolicyComponent[];
}

/* ───────────────────────────── fingerprint ───────────────────────────── */

export function fingerprintConfig(config: ResolvedConfig): PolicyLock {
  return {
    schema: POLICY_LOCK_SCHEMA,
    version: 1,
    baseRef: config.baseRef,
    failOn: config.failOn,
    components: [...config.components]
      .map(fingerprintComponent)
      .sort((a, b) => cmp(a.id, b.id)),
  };
}

export function fingerprintComponent(plan: ComponentPlan): PolicyComponent {
  const entry = plan.resolved.entry;
  return {
    id: plan.id,
    root: plan.rootRepo,
    enabled: entry.enabled !== false,
    disabledUntil: entry.disabledUntil ?? null,
    dependsOn: sorted(entry.dependsOn ?? []),
    generates: sorted(entry.generates ?? []),
    submodules: sorted(entry.submodules ?? []),
    // The repo-anchored form: an author-relative glob would compare equal
    // across a root move that actually changed what is claimed.
    witnesses: sorted(plan.witnessMatches.map((w) => w.repoGlob)),
    ingestRequired: plan.ingest === null ? null : plan.ingest.required,
    producers: [...plan.producers]
      .map((p) => ({
        name: p.resolved.name,
        out: p.outRepo,
        tier: p.resolved.tier ?? 'pr',
        ciJob: p.resolved.ciJob ?? null,
        runWhen: p.resolved.effectiveRunWhen,
        minCases: p.resolved.minCases ?? null,
        clean: p.resolved.effectiveClean,
        renderer: p.resolved.renderer ?? null,
        resources: sorted(p.resolved.resources ?? []),
        compare: normalizeCompare(p.resolved.compareSpec),
      }))
      .sort((a, b) => cmp(a.name, b.name)),
  };
}

/** A bare mode is a rule matching everything. One shape to diff, not two. */
export function normalizeCompare(spec: CompareSpec | undefined): readonly PolicyCompareRule[] {
  if (spec === undefined) return [ruleOf('**', { kind: 'exact' })];
  if (Array.isArray(spec)) {
    return (spec as readonly CompareRule[]).map((r) => ruleOf(r.match, r.use));
  }
  return [ruleOf('**', spec as CompareMode)];
}

function ruleOf(match: Glob, mode: CompareMode): PolicyCompareRule {
  return {
    match,
    kind: mode.kind,
    abs: mode.kind === 'tolerance' ? (mode.abs ?? null) : null,
    rel: mode.kind === 'tolerance' ? (mode.rel ?? null) : null,
    columns: mode.kind === 'tolerance' ? (mode.columns === undefined ? null : [...mode.columns]) : null,
    maxDiffRatio: mode.kind === 'pixel' ? (mode.maxDiffRatio ?? null) : null,
    threshold: mode.kind === 'pixel' ? (mode.threshold ?? null) : null,
  };
}

/* ───────────────────────── serialize / parse ─────────────────────────── */

/**
 * Canonical JSON, hand-rolled.
 *
 * The lock's byte form is a FILE FORMAT CONTRACT: if the ordering changes, every
 * repo using this tool gets a spurious one-line-per-key diff and a run of
 * `policy-changed` findings. That is too load-bearing to inherit from a helper
 * in another module that is free to be reformatted for its own reasons.
 */
export function canonicalJson(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function serializeLock(lock: PolicyLock): string {
  return `${canonicalJson(lock)}\n`;
}

export type LockParse =
  | { readonly lock: PolicyLock; readonly error: null }
  | { readonly lock: null; readonly error: string };

export function parseLock(text: string): LockParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { lock: null, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { lock: null, error: 'not a JSON object' };
  }
  const r = value as Record<string, unknown>;
  if (r['schema'] !== POLICY_LOCK_SCHEMA) {
    return { lock: null, error: `unexpected schema (want ${POLICY_LOCK_SCHEMA})` };
  }
  if (!Array.isArray(r['components'])) return { lock: null, error: 'missing `components`' };
  // The lock is written by this tool; a shape check beyond schema + components
  // would reject forward-compatible additions for no gain. Unknown fields are
  // simply not compared.
  return { lock: value as unknown as PolicyLock, error: null };
}

export interface LockLoad {
  readonly present: boolean;
  readonly lock: PolicyLock | null;
  readonly error: string | null;
}

export async function loadLockAt(repo: GitRepo, rev: Sha | string): Promise<LockLoad> {
  const buf = await repo.readBlob(rev, POLICY_LOCK_PATH);
  if (buf === null) return { present: false, lock: null, error: null };
  const parsed = parseLock(buf.toString('utf8'));
  return { present: true, lock: parsed.lock, error: parsed.error };
}

export function lockRoster(lock: PolicyLock): readonly { component: ComponentId; producer: ProducerName }[] {
  return lock.components.flatMap((c) => c.producers.map((p) => ({ component: c.id, producer: p.name })));
}

/* ─────────────────────────────── drift ───────────────────────────────── */

export type GovernanceKind =
  | 'component-added'
  | 'component-removed'
  | 'component-disabled'
  | 'component-enabled'
  | 'root-narrowed'
  | 'root-changed'
  | 'witness-added'
  | 'witness-removed'
  | 'witness-narrowed'
  | 'dependson-removed'
  | 'generates-removed'
  | 'submodule-removed'
  | 'ingest-required-relaxed'
  | 'producer-added'
  | 'producer-removed'
  | 'producer-out-changed'
  | 'compare-loosened'
  | 'compare-tightened'
  | 'tolerance-added'
  | 'tolerance-raised'
  | 'tolerance-lowered'
  | 'tolerance-columns-narrowed'
  | 'mincases-lowered'
  | 'mincases-raised'
  | 'runwhen-lowered'
  | 'runwhen-raised'
  | 'tier-demoted'
  | 'tier-promoted'
  | 'cijob-removed'
  | 'cijob-added'
  | 'clean-disabled'
  | 'renderer-changed'
  | 'failon-relaxed'
  | 'failon-tightened';

export interface PolicyDelta {
  readonly kind: GovernanceKind;
  /** True ⇒ the new rules can report LESS than the old ones could. */
  readonly weakening: boolean;
  readonly component: ComponentId | null;
  readonly producer: ProducerName | null;
  readonly locator: string;
  readonly before: string | null;
  readonly after: string | null;
  /** One sentence saying WHY it is weaker, for the governance section. */
  readonly detail: string;
  /** `witness-narrowed` only: tracked files the head rules no longer claim. */
  readonly lost: readonly RepoPath[];
}

export interface PolicyDrift {
  readonly deltas: readonly PolicyDelta[];
  readonly weakened: readonly PolicyDelta[];
  readonly baseMissing: boolean;
  readonly baseUnreadable: string | null;
}

export interface DiffPolicyOptions {
  /** Tracked paths at HEAD, for the set-theoretic witness-narrowed check. */
  readonly tracked?: readonly RepoPath[] | undefined;
}

export function diffPolicy(
  base: PolicyLock | null,
  head: PolicyLock,
  opts: DiffPolicyOptions = {},
): PolicyDrift {
  if (base === null) {
    return { deltas: [], weakened: [], baseMissing: true, baseUnreadable: null };
  }
  const deltas: PolicyDelta[] = [];
  const baseById = new Map(base.components.map((c) => [c.id, c]));
  const headById = new Map(head.components.map((c) => [c.id, c]));

  for (const [key, before] of Object.entries(base.failOn) as [keyof FailPolicy, boolean][]) {
    const after = head.failOn[key];
    if (before === after) continue;
    deltas.push({
      kind: before && !after ? 'failon-relaxed' : 'failon-tightened',
      weakening: before && !after,
      component: null,
      producer: null,
      locator: `failOn.${key}`,
      before: String(before),
      after: String(after),
      detail:
        before && !after
          ? `\`failOn.${key}\` no longer fails the run`
          : `\`failOn.${key}\` now fails the run`,
      lost: [],
    });
  }

  for (const id of unionIds(baseById, headById)) {
    const b = baseById.get(id);
    const h = headById.get(id);
    if (b !== undefined && h === undefined) {
      deltas.push(delta('component-removed', true, id, null, `components[${id}]`, b.root, null,
        `component \`${id}\` is gone; nothing claims the ${String(b.witnesses.length)} witness globs it declared`));
      continue;
    }
    if (b === undefined && h !== undefined) {
      deltas.push(delta('component-added', false, id, null, `components[${id}]`, null, h.root,
        `component \`${id}\` was added`));
      continue;
    }
    if (b === undefined || h === undefined) continue;
    deltas.push(...diffComponent(b, h, opts.tracked));
  }

  deltas.sort(
    (x, y) =>
      Number(y.weakening) - Number(x.weakening) ||
      cmp(x.component ?? '', y.component ?? '') ||
      cmp(x.locator, y.locator) ||
      cmp(x.kind, y.kind),
  );
  return {
    deltas,
    weakened: deltas.filter((d) => d.weakening),
    baseMissing: false,
    baseUnreadable: null,
  };
}

function diffComponent(
  b: PolicyComponent,
  h: PolicyComponent,
  tracked: readonly RepoPath[] | undefined,
): PolicyDelta[] {
  const out: PolicyDelta[] = [];
  const at = (field: string): string => `components[${b.id}].${field}`;

  if (b.enabled && !h.enabled) {
    out.push(delta('component-disabled', true, b.id, null, at('enabled'), 'true', 'false',
      `component \`${b.id}\` is disabled; its producers no longer run`));
  } else if (!b.enabled && h.enabled) {
    out.push(delta('component-enabled', false, b.id, null, at('enabled'), 'false', 'true',
      `component \`${b.id}\` is enabled again`));
  }

  if (b.root !== h.root) {
    // Narrowed = the new root sits inside the old one, so strictly less is in
    // scope. A lateral move is reported without a weakening flag: it may be a
    // legitimate reorganisation, and flagging it would train people to ack.
    const narrowed = h.root.startsWith(`${b.root.replace(/\/+$/, '')}/`);
    out.push(delta(narrowed ? 'root-narrowed' : 'root-changed', narrowed, b.id, null, at('root'), b.root, h.root,
      narrowed
        ? `root narrowed into \`${h.root}\`; everything else under \`${b.root}\` left this component's scope`
        : `root moved from \`${b.root}\` to \`${h.root}\``));
  }

  for (const w of b.witnesses.filter((x) => !h.witnesses.includes(x))) {
    out.push(delta('witness-removed', true, b.id, null, at('witnesses'), w, null,
      `witness \`${w}\` is no longer claimed by \`${b.id}\``));
  }
  for (const w of h.witnesses.filter((x) => !b.witnesses.includes(x))) {
    out.push(delta('witness-added', false, b.id, null, at('witnesses'), null, w,
      `witness \`${w}\` was added to \`${b.id}\``));
  }
  if (tracked !== undefined && tracked.length > 0) {
    const lost = lostPaths(b.witnesses, h.witnesses, tracked);
    if (lost.length > 0) {
      out.push({
        ...delta('witness-narrowed', true, b.id, null, at('witnesses'), null, null,
          `${String(lost.length)} tracked ${lost.length === 1 ? 'file is' : 'files are'} no longer claimed by \`${b.id}\``),
        lost,
      });
    }
  }

  out.push(...listRemovals('dependson-removed', b.id, at('dependsOn'), b.dependsOn, h.dependsOn,
    (v) => `dependency on \`${v}\` removed; changes there no longer force this component to run`));
  out.push(...listRemovals('generates-removed', b.id, at('generates'), b.generates, h.generates,
    (v) => `\`${v}\` is no longer declared as generated; its consumers stop being forced to run`));
  out.push(...listRemovals('submodule-removed', b.id, at('submodules'), b.submodules, h.submodules,
    (v) => `submodule \`${v}\` no longer declared; a pin bump stops forcing a run`));

  if (b.ingestRequired === true && h.ingestRequired === false) {
    out.push(delta('ingest-required-relaxed', true, b.id, null, at('ingest.required'), 'true', 'false',
      'missing test artifacts stopped being an error'));
  }

  const bp = new Map(b.producers.map((p) => [p.name, p]));
  const hp = new Map(h.producers.map((p) => [p.name, p]));
  for (const name of unionIds(bp, hp)) {
    const pb = bp.get(name);
    const ph = hp.get(name);
    const loc = `components[${b.id}].producers[${name}]`;
    if (pb !== undefined && ph === undefined) {
      out.push(delta('producer-removed', true, b.id, name, loc, pb.out, null,
        `producer \`${name}\` removed; the snapshots under \`${pb.out}\` stop being produced`));
      continue;
    }
    if (pb === undefined && ph !== undefined) {
      out.push(delta('producer-added', false, b.id, name, loc, null, ph.out,
        `producer \`${name}\` was added`));
      continue;
    }
    if (pb === undefined || ph === undefined) continue;
    out.push(...diffProducer(b.id, pb, ph, loc));
  }
  return out;
}

function diffProducer(
  component: ComponentId,
  b: PolicyProducer,
  h: PolicyProducer,
  loc: string,
): PolicyDelta[] {
  const out: PolicyDelta[] = [];
  const d = (
    kind: GovernanceKind,
    weakening: boolean,
    field: string,
    before: string | null,
    after: string | null,
    detail: string,
  ): void => {
    out.push(delta(kind, weakening, component, b.name, `${loc}.${field}`, before, after, detail));
  };

  if (b.out !== h.out) {
    d('producer-out-changed', true, 'out', b.out, h.out,
      `baseline moved from \`${b.out}\` to \`${h.out}\`; the old corpus is no longer compared`);
  }
  if (b.tier !== h.tier) {
    const demoted = b.tier === 'pr' && h.tier !== 'pr';
    d(demoted ? 'tier-demoted' : 'tier-promoted', demoted, 'tier', b.tier, h.tier,
      demoted ? `producer left the PR gate (\`${b.tier}\` → \`${h.tier}\`)` : `producer joined a stricter tier`);
  }
  if (b.ciJob !== null && h.ciJob === null) {
    d('cijob-removed', true, 'ciJob', b.ciJob, null,
      'producer no longer names a CI job, so its snapshots can only ever be locally accepted');
  } else if (b.ciJob === null && h.ciJob !== null) {
    d('cijob-added', false, 'ciJob', null, h.ciJob, 'producer now names a CI job');
  }
  if (b.runWhen === 'always' && h.runWhen === 'changed') {
    d('runwhen-lowered', true, 'runWhen', 'always', 'changed',
      'producer now runs only when Vibes believes the component changed');
  } else if (b.runWhen === 'changed' && h.runWhen === 'always') {
    d('runwhen-raised', false, 'runWhen', 'changed', 'always', 'producer now always runs');
  }
  if (b.minCases !== null && (h.minCases === null || h.minCases < b.minCases)) {
    d('mincases-lowered', true, 'minCases', String(b.minCases), h.minCases === null ? null : String(h.minCases),
      'the corpus floor was lowered, so a shrinking corpus stops failing');
  } else if (h.minCases !== null && (b.minCases === null || h.minCases > b.minCases)) {
    d('mincases-raised', false, 'minCases', b.minCases === null ? null : String(b.minCases), String(h.minCases),
      'the corpus floor was raised');
  }
  if (b.clean && !h.clean) {
    d('clean-disabled', true, 'clean', 'true', 'false',
      'the received dir is no longer wiped before each run, so a deleted corpus entry leaves stale output behind and is never noticed');
  }
  if (b.renderer !== h.renderer) {
    d('renderer-changed', false, 'renderer', b.renderer, h.renderer, 'renderer changed');
  }
  out.push(...diffCompare(component, b, h, loc));
  return out;
}

/**
 * Compare rules are keyed by their `match` glob. A rule present on one side
 * only is compared against the OTHER side's fallback (its bare mode, or `exact`
 * when it has none), because deleting a rule does not delete the file — it
 * moves it under whatever else applies.
 */
function diffCompare(
  component: ComponentId,
  b: PolicyProducer,
  h: PolicyProducer,
  loc: string,
): PolicyDelta[] {
  const out: PolicyDelta[] = [];
  const bm = new Map(b.compare.map((r) => [r.match, r]));
  const hm = new Map(h.compare.map((r) => [r.match, r]));
  const bFallback = b.compare.find((r) => r.match === '**') ?? EXACT_RULE;
  const hFallback = h.compare.find((r) => r.match === '**') ?? EXACT_RULE;

  for (const match of unionIds(bm, hm)) {
    const before = bm.get(match) ?? bFallback;
    const after = hm.get(match) ?? hFallback;
    const field = `compare[${match}]`;
    const push = (kind: GovernanceKind, weakening: boolean, detail: string): void => {
      out.push(
        delta(kind, weakening, component, b.name, `${loc}.${field}`, describeMode(before), describeMode(after), detail),
      );
    };

    if (before.kind === 'exact' && after.kind !== 'exact') {
      push(after.kind === 'tolerance' && !bm.has(match) ? 'tolerance-added' : 'compare-loosened', true,
        `\`${match}\` moved from exact to ${after.kind}; a tolerant comparison cannot report a change smaller than its bound`);
      continue;
    }
    if (before.kind !== 'exact' && after.kind === 'exact') {
      push('compare-tightened', false, `\`${match}\` moved from ${before.kind} to exact`);
      continue;
    }
    if (before.kind === 'tolerance' && after.kind === 'tolerance') {
      const raised = raisedBound(before.abs, after.abs) || raisedBound(before.rel, after.rel);
      const lowered = raisedBound(after.abs, before.abs) || raisedBound(after.rel, before.rel);
      if (raised) {
        push('tolerance-raised', true,
          `epsilon widened for \`${match}\`; differences inside the new band stop being reported`);
      } else if (lowered) {
        push('tolerance-lowered', false, `epsilon narrowed for \`${match}\``);
      }
      // Columns: absent means "every column". Naming a subset stops comparing
      // the rest, which is a narrower predicate however the numbers look.
      const narrowed =
        (before.columns === null && after.columns !== null) ||
        (before.columns !== null &&
          after.columns !== null &&
          before.columns.some((c) => !after.columns?.includes(c)));
      if (narrowed) {
        push('tolerance-columns-narrowed', true,
          `fewer columns are compared for \`${match}\`; the omitted ones can change without being reported`);
      }
    }
  }
  return out;
}

const EXACT_RULE: PolicyCompareRule = {
  match: '**',
  kind: 'exact',
  abs: null,
  rel: null,
  columns: null,
  maxDiffRatio: null,
  threshold: null,
};

function raisedBound(before: number | null, after: number | null): boolean {
  if (after === null) return false;
  return before === null ? after > 0 : after > before;
}

function describeMode(r: PolicyCompareRule): string {
  if (r.kind !== 'tolerance') return r.kind;
  const bits = [`abs=${r.abs === null ? '-' : String(r.abs)}`, `rel=${r.rel === null ? '-' : String(r.rel)}`];
  if (r.columns !== null) bits.push(`columns=[${r.columns.join(',')}]`);
  return `tolerance(${bits.join(', ')})`;
}

/* ─────────────────── the lock vs what is actually resolved ───────────── */

export interface LockLiveComparison {
  /** The committed lock does not match the live config: it was not regenerated. */
  readonly stale: boolean;
  /** In the committed lock, absent from the live resolution. §4.4's cheapest
   *  total-silencing edit, and the lock is the only thing that can see it. */
  readonly missingComponents: readonly ComponentId[];
  readonly missingProducers: readonly { component: ComponentId; producer: ProducerName }[];
  readonly addedComponents: readonly ComponentId[];
}

export function compareLockToLive(committed: PolicyLock, live: PolicyLock): LockLiveComparison {
  const liveIds = new Set(live.components.map((c) => c.id));
  const liveProducers = new Set(
    live.components.flatMap((c) => c.producers.map((p) => `${c.id}/${p.name}`)),
  );
  const missingComponents = committed.components
    .map((c) => c.id)
    .filter((id) => !liveIds.has(id));
  const missingProducers = committed.components.flatMap((c) =>
    c.producers
      .filter((p) => liveIds.has(c.id) && !liveProducers.has(`${c.id}/${p.name}`))
      .map((p) => ({ component: c.id, producer: p.name })),
  );
  return {
    stale: serializeLock(committed) !== serializeLock(live),
    missingComponents,
    missingProducers,
    addedComponents: live.components.map((c) => c.id).filter((id) => !committed.components.some((c) => c.id === id)),
  };
}

/* ───────────────────────── the ack trailer ───────────────────────────── */

export const WEAKENING_ACK_TRAILER = 'Vibes-Weakening-Ack';

/**
 * One greppable, attributable line. That is the entire moat, and §8.3 says
 * plainly that it only works if a human reads it — so the parser is strict
 * about the shape (trailer at line start, non-empty reason) and nothing else.
 */
export function parseWeakeningAck(prBody: string | null | undefined): string | null {
  if (prBody === null || prBody === undefined) return null;
  const re = new RegExp(`^\\s*${WEAKENING_ACK_TRAILER}\\s*:\\s*(.+?)\\s*$`, 'im');
  const m = re.exec(prBody);
  const reason = m?.[1]?.trim() ?? '';
  return reason === '' ? null : reason;
}

/* ────────────────────────────── helpers ──────────────────────────────── */

function delta(
  kind: GovernanceKind,
  weakening: boolean,
  component: ComponentId | null,
  producer: ProducerName | null,
  locator: string,
  before: string | null,
  after: string | null,
  detail: string,
): PolicyDelta {
  return { kind, weakening, component, producer, locator, before, after, detail, lost: [] };
}

function listRemovals(
  kind: GovernanceKind,
  component: ComponentId,
  locator: string,
  before: readonly string[],
  after: readonly string[],
  detail: (v: string) => string,
): PolicyDelta[] {
  return before
    .filter((v) => !after.includes(v))
    .map((v) => delta(kind, true, component, null, locator, v, null, detail(v)));
}

export function lostPaths(
  baseGlobs: readonly Glob[],
  headGlobs: readonly Glob[],
  tracked: readonly RepoPath[],
): readonly RepoPath[] {
  const claimed = (globs: readonly Glob[]): ((p: string) => boolean) => {
    const pos = globs.filter((g) => !g.startsWith('!'));
    const neg = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
    if (pos.length === 0) return () => false;
    const yes = picomatch(pos as string[], { dot: false, nobrace: true });
    const no = neg.length === 0 ? () => false : picomatch(neg as string[], { dot: false, nobrace: true });
    return (p) => yes(p) && !no(p);
  };
  const wasClaimed = claimed(baseGlobs);
  const isClaimed = claimed(headGlobs);
  return tracked.filter((p) => wasClaimed(p) && !isClaimed(p));
}

function unionIds<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort(cmp);
}

function sorted(xs: readonly string[]): readonly string[] {
  return [...xs].sort(cmp);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
