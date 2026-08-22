/**
 * Resolution: registry + manifests → the shape the pipeline consumes.
 *
 * VALIDATION IS TOTAL AND SPAWNS NOTHING. Every path is resolved, every
 * containment guard runs, the dependency closure is built and every witness is
 * expanded BEFORE any producer could run. `vibes doctor` is exactly this
 * function plus a printer, which is why it is safe in a pre-commit hook and on
 * every PR: the only child process it can cause is git, through the injected
 * GitPort.
 *
 * Nothing here is optional-if-convenient. A registry `root` that does not exist
 * is a HARD ERROR rather than a skip, and that single decision is what makes
 * `git rm -r` unable to delete a component's coverage claim quietly: the claim
 * is a registry line, and the line now points at nothing.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import picomatch from 'picomatch';

import type {
  ComponentEntry,
  ComponentId,
  FailPolicy,
  GitPort,
  Glob,
  IngestSpec,
  Producer,
  RendererId,
  RepoPath,
  ReportFormat,
  ResolvedComponent,
  ResolvedProducer,
  RunWhen,
  Sha,
  VibesManifest,
  VibesRootConfig,
} from '../types.js';
import type { EffectiveDefaults } from './constants.js';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_FAIL_ON,
  DEFAULT_MAX_INLINE_DIFF_LINES,
  IGNORE_PROBE_NAMES,
  MANIFEST_BASENAME,
  RECEIVED_DIRNAME,
  ROOT_CONFIG_PATH,
  STATE_DIRNAME,
  VIBES_DIRNAME,
} from './constants.js';
import type { Diagnostic } from './diagnostics.js';
import { DiagnosticBag, sortDiagnostics } from './diagnostics.js';
import { loadManifest, loadRootConfig } from './load.js';
import {
  actualCaseMismatch,
  anchorGlob,
  globIntersectsDir,
  isStrictDescendant,
  isSymlink,
  normalizeRel,
  realpathDeepest,
  repoRelative,
} from './paths.js';
import { applyProducer, mergeDefaults, raiseRunWhen } from './precedence.js';
import { isIsoDate } from './validate.js';

/* ───────────────────────────── inputs ────────────────────────────────── */

export interface ResolveOptions {
  readonly repoRoot: string;
  /** Already resolved through CLI `--base` / `VIBES_BASE_SHA` / config. */
  readonly baseRef: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
  /** Omit for a pure shape check; supply it for witness expansion and the
   *  ignore probes, which are the checks that catch real-world breakage. */
  readonly git?: GitPort | undefined;
  readonly only?: readonly ComponentId[] | undefined;
  readonly skip?: readonly ComponentId[] | undefined;
  /** `--all`: force `runWhen: 'always'` everywhere. How a baseline is first
   *  recorded, and how the nightly falsifier runs. */
  readonly all?: boolean | undefined;
  /** Keys of the renderer registry. Omit to skip the unknown-renderer check. */
  readonly knownRenderers?: readonly RendererId[] | undefined;
  /** Injectable so `disabledUntil` expiry is testable without a clock hack. */
  readonly now?: Date | undefined;
}

/* ───────────────────────────── outputs ───────────────────────────────── */

export type ComponentStatus =
  | 'active'
  /** Registry `enabled: false`. Rendered in the headline, never hidden. */
  | 'disabled'
  /** `--only` / `--skip`. NOT honest-by-construction: changed files under a
   *  cli-skipped component still surface as unwitnessed. */
  | 'skipped-cli'
  /** Manifest missing, unloadable, or invalid. */
  | 'unusable';

export interface ProducerPlan {
  readonly resolved: ResolvedProducer;
  /** Committed baseline dir, repo-relative POSIX. */
  readonly outRepo: RepoPath;
  /** Gitignored received dir, repo-relative POSIX. */
  readonly receivedRepo: RepoPath;
  /** True when git tracks ≥1 file under `outRepo` at HEAD. False means the
   *  next run is a bootstrap, not a comparison. */
  readonly hasBaseline: boolean;
  readonly forcedAlways: boolean;
}

export interface WitnessMatch {
  /** As authored, root-relative. */
  readonly glob: Glob;
  /** Re-anchored to the repo root — what the honesty join actually uses. */
  readonly repoGlob: Glob;
  readonly matched: readonly RepoPath[];
  readonly matchedAtBase: readonly RepoPath[];
  /** A leading `!` glob filters the positives; it claims nothing itself. */
  readonly negated: boolean;
}

export interface ResolvedIngest {
  readonly cmd: string | null;
  readonly absCwd: string;
  readonly env: Readonly<Record<string, string | null>>;
  readonly timeoutMs: number;
  /** Root-relative, matched against the FILESYSTEM (these artifacts are
   *  generated and usually gitignored — witnesses match git, ingest does not). */
  readonly junit: readonly Glob[];
  readonly vitestJson: readonly Glob[];
  readonly pioJson: readonly Glob[];
  readonly lcov: readonly { readonly glob: Glob; readonly absSourceRoot: string }[];
  readonly required: boolean;
}

export interface ComponentPlan {
  /** The contract shape from ../types.ts. */
  readonly resolved: ResolvedComponent;
  readonly id: ComponentId;
  readonly title: string;
  readonly rootRepo: RepoPath;
  readonly manifestRepo: RepoPath;
  readonly status: ComponentStatus;
  readonly statusReason: string | null;
  readonly producers: readonly ProducerPlan[];
  /** Transitive dependsOn, sorted, excluding self. */
  readonly closure: readonly ComponentId[];
  readonly forcedAlways: boolean;
  readonly forcedAlwaysReason: string | null;
  /** `<root>/vibes/**`, repo-anchored. Implicit, non-removable, and NOT part of
   *  `witnesses`: it exists so a change to the file that defines coverage forces
   *  the component to run, not so snapshots can witness themselves. */
  readonly implicitWitness: Glob;
  readonly witnessesAuthored: readonly Glob[];
  readonly witnessMatches: readonly WitnessMatch[];
  readonly ingest: ResolvedIngest | null;
  /** Fully merged manifest, for the report's "Effective manifest" block.
   *  Merging may not hide behaviour. */
  readonly effective: VibesManifest | null;
}

export interface ResolvedReport {
  readonly out: RepoPath;
  readonly absOut: string;
  readonly formats: readonly ReportFormat[];
  readonly title: string;
  readonly maxInlineDiffLines: number;
}

export interface ResolvedConfig {
  readonly repoRoot: string;
  readonly baseRef: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
  readonly raw: VibesRootConfig | null;
  readonly report: ResolvedReport;
  readonly failOn: Required<FailPolicy>;
  readonly concurrency: number;
  /** Sorted by id, bytewise. Two runs on the same tree resolve identically. */
  readonly components: readonly ComponentPlan[];
  readonly diagnostics: readonly Diagnostic[];
  /** False when any diagnostic is error-severity. No producer may run. */
  readonly ok: boolean;
}

/* ═══════════════════════════ the resolver ═════════════════════════════ */

export async function resolveConfig(opts: ResolveOptions): Promise<ResolvedConfig> {
  const bag = new DiagnosticBag();
  const repoRoot = resolvePath(opts.repoRoot);
  const now = opts.now ?? new Date();

  const rootLoad = await loadRootConfig(repoRoot);
  bag.addAll(rootLoad.diagnostics);

  const report = resolveReport(repoRoot, rootLoad.config);
  const failOn: Required<FailPolicy> = { ...DEFAULT_FAIL_ON, ...(rootLoad.config?.failOn ?? {}) };
  const concurrency = rootLoad.config?.concurrency ?? DEFAULT_CONCURRENCY;

  if (rootLoad.config === null) {
    return {
      repoRoot,
      baseRef: opts.baseRef,
      baseSha: opts.baseSha,
      headSha: opts.headSha,
      raw: null,
      report,
      failOn,
      concurrency,
      components: [],
      diagnostics: sortDiagnostics(bag.items),
      ok: false,
    };
  }

  // Sorted for determinism (two runs on the same tree resolve identically);
  // `authoredIndex` keeps every `components[i]` locator pointing at the entry
  // the author actually wrote.
  const entries = [...rootLoad.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map<ComponentId, ComponentEntry>(entries.map((e) => [e.id, e]));
  const authoredIndex = (id: ComponentId): number => rootLoad.indexById.get(id) ?? 0;

  checkSelection(bag, opts, byId);
  const submodulePaths = readSubmodulePaths(repoRoot);
  const git = opts.git;

  // One git call each, reused by every check below. A failure here degrades to
  // "cannot verify" rather than crashing: a shallow clone with an unreachable
  // baseSha must still produce a report saying so.
  const trackedHead = await safeLsTree(bag, git, opts.headSha, 'HEAD');
  const trackedBase =
    opts.baseSha === opts.headSha ? trackedHead : await safeLsTree(bag, git, opts.baseSha, 'base');
  const visible = await safeListFiles(bag, git);

  checkRootPathsPairwise(bag, repoRoot, entries, authoredIndex);
  const closures = resolveDependsOn(bag, entries, byId, authoredIndex);
  const forced = computeForcedAlways(entries, opts.all === true);

  await checkReportIgnored(bag, git, report, submodulePaths);

  const plans: ComponentPlan[] = [];
  const outDirs: { producer: string; outAbs: string; outRepo: RepoPath }[] = [];

  for (const entry of entries) {
    const locator = `components[${String(authoredIndex(entry.id))}]`;
    const absRoot = resolvePath(repoRoot, entry.root);
    const rootRepo = normalizeRel(entry.root);
    const absVibesDir = join(absRoot, VIBES_DIRNAME);
    const manifestRepo = `${rootRepo}/${VIBES_DIRNAME}/${MANIFEST_BASENAME}`;

    let status: ComponentStatus = 'active';
    let statusReason: string | null = null;

    /* ── existence: the hard error the whole registry design exists for ── */
    const rootExists = existsSync(absRoot) && statSync(absRoot).isDirectory();
    if (!rootExists) {
      bag.add({
        code: 'V022_ROOT_MISSING_DIR',
        severity: 'error',
        file: ROOT_CONFIG_PATH,
        locator: `${locator}.root`,
        component: entry.id,
        message: `root '${entry.root}' does not exist`,
        fix: `restore the directory, or delete this registry entry in the same commit`,
        evidence: [
          `resolved: ${absRoot}`,
          `a registry entry pointing at nothing is an error, never a skip — otherwise deleting a component deletes its coverage claim silently`,
        ],
      });
      status = 'unusable';
      statusReason = `root '${entry.root}' does not exist`;
    } else if (!isStrictDescendant(repoRoot, absRoot)) {
      bag.add({
        code: 'V025_ROOT_IS_REPO_ROOT',
        severity: 'error',
        file: ROOT_CONFIG_PATH,
        locator: `${locator}.root`,
        component: entry.id,
        message: `root must be strictly inside the repo`,
        fix: `point root at a subdirectory of the repo`,
        evidence: [`repoRoot: ${repoRoot}`, `resolved: ${absRoot}`],
      });
      status = 'unusable';
      statusReason = 'root is not inside the repo';
    }

    const rootInSub = insideSubmodule(rootRepo, submodulePaths);
    if (rootInSub !== null) {
      bag.add({
        code: 'V024_ROOT_IN_SUBMODULE',
        severity: 'error',
        file: ROOT_CONFIG_PATH,
        locator: `${locator}.root`,
        component: entry.id,
        message: `root is inside the submodule '${rootInSub}'`,
        fix: `remove this entry and declare submodules: ['${rootInSub}'] on the component that links it`,
        evidence: [
          `snapshots inside a submodule are invisible to the superproject diff`,
          `git check-ignore fatals inside a submodule (exit 128)`,
        ],
      });
      status = 'unusable';
      statusReason = `root is inside submodule '${rootInSub}'`;
    }

    /* ── suppression ─────────────────────────────────────────────────── */
    if (entry.enabled === false) {
      if (status !== 'unusable') status = 'disabled';
      statusReason = entry.disabledReason ?? 'disabled';
      const until = entry.disabledUntil;
      if (typeof until === 'string' && isIsoDate(until)) {
        const expiry = Date.parse(`${until}T23:59:59.999Z`);
        if (now.getTime() > expiry) {
          bag.add({
            code: 'V027_DISABLED_EXPIRED',
            severity: 'error',
            file: ROOT_CONFIG_PATH,
            locator: `${locator}.disabledUntil`,
            component: entry.id,
            message: `suppression expired on ${until}`,
            fix: `re-enable the component, or renew disabledUntil with a fresh reason`,
            evidence: [`reason on record: ${entry.disabledReason ?? '(none)'}`],
          });
        }
      }
    } else if (isSkippedByCli(entry.id, opts)) {
      status = 'skipped-cli';
      statusReason = opts.only ? `not in --only` : `named in --skip`;
    }

    /* ── submodule declarations ──────────────────────────────────────── */
    for (const [j, s] of (entry.submodules ?? []).entries()) {
      if (!submodulePaths.includes(normalizeRel(s))) {
        bag.add({
          code: 'V02A_SUBMODULE_UNKNOWN',
          severity: 'error',
          file: ROOT_CONFIG_PATH,
          locator: `${locator}.submodules[${j}]`,
          component: entry.id,
          message: `'${s}' is not a submodule of this repo`,
          fix: `use a path from .gitmodules`,
          evidence: [`known submodules: ${submodulePaths.join(', ') || 'none'}`],
        });
      }
    }

    /* ── generates globs must land inside the repo ───────────────────── */
    for (const [j, g] of (entry.generates ?? []).entries()) {
      const body = g.startsWith('!') ? g.slice(1) : g;
      if (normalizeRel(body) === '') {
        bag.add({
          code: 'V02B_GENERATES_ESCAPES',
          severity: 'error',
          file: ROOT_CONFIG_PATH,
          locator: `${locator}.generates[${j}]`,
          component: entry.id,
          message: `generates glob must name a path inside the repo`,
          fix: `write a repo-relative glob, e.g. 'Software/Control/src/generated/**'`,
          evidence: [`got ${JSON.stringify(g)}`],
        });
      }
    }

    /* ── manifest ────────────────────────────────────────────────────── */
    const wantManifest = status !== 'unusable' && entry.enabled !== false;
    const manifestLoad = rootExists
      ? await loadManifest({
          repoRoot,
          entry,
          absRoot,
          baseRef: opts.baseRef,
          baseSha: opts.baseSha,
          headSha: opts.headSha,
          required: wantManifest,
        })
      : null;
    if (manifestLoad) bag.addAll(manifestLoad.diagnostics);

    const manifest = manifestLoad?.manifest ?? null;
    if (wantManifest && manifest === null) {
      status = 'unusable';
      statusReason = 'manifest missing or invalid';
    }

    // A manifest an agent just wrote but never staged still gets a report —
    // silence would be worse — but the report says it is untracked, because an
    // untracked manifest is invisible at baseSha and to the governance diff.
    if (manifestLoad?.exists === true && visible !== null && trackedHead !== null) {
      const isVisible = visible.includes(manifestRepo);
      const isTracked = trackedHead.includes(manifestRepo);
      if (isVisible && !isTracked) {
        bag.add({
          code: 'V035_MANIFEST_UNTRACKED',
          severity: 'warn',
          file: manifestRepo,
          component: entry.id,
          message: `manifest is not tracked by git`,
          fix: `git add ${manifestRepo}`,
          evidence: [`an untracked manifest cannot be diffed against ${opts.baseSha.slice(0, 8)}`],
        });
      }
    }

    /* ── producers ───────────────────────────────────────────────────── */
    const rootDefaults = rootLoad.config.defaults;
    const manifestDefaults = manifest?.defaults;
    const baseDefaults = mergeDefaults([rootDefaults, manifestDefaults]);
    const componentForced = forced.has(entry.id);

    const producerPlans: ProducerPlan[] = [];
    const mergedProducers: Producer[] = [];

    for (const [pi, p] of (manifest?.producers ?? []).entries()) {
      const plocator = `producers[${pi}]`;
      const eff = applyProducer(baseDefaults, p);
      const effectiveRunWhen: RunWhen = raiseRunWhen(eff.runWhen, componentForced);

      const baselineDir = resolvePath(absVibesDir, p.out);
      const outRepo = repoRelative(repoRoot, baselineDir);
      const absCwd = resolvePath(absRoot, p.cwd ?? '.');
      const receivedDir = join(repoRoot, STATE_DIRNAME, RECEIVED_DIRNAME, entry.id, p.name);
      const receivedRepo = `${STATE_DIRNAME}/${RECEIVED_DIRNAME}/${entry.id}/${p.name}`;

      checkOut(bag, {
        file: manifestRepo,
        component: entry.id,
        locator: `${plocator}.out`,
        absVibesDir,
        baselineDir,
        outRepo,
        manifestAbs: manifestLoad?.absPath ?? '',
        submodulePaths,
      });
      checkCwd(bag, {
        file: manifestRepo,
        component: entry.id,
        locator: `${plocator}.cwd`,
        absRoot,
        absCwd,
        declared: p.cwd ?? '.',
      });
      if (opts.knownRenderers && eff.renderer !== null && !opts.knownRenderers.includes(eff.renderer)) {
        bag.add({
          code: 'V04A_RENDERER_UNKNOWN',
          severity: 'error',
          file: manifestRepo,
          component: entry.id,
          locator: `${plocator}.renderer`,
          message: `unknown renderer '${eff.renderer}'`,
          fix: `use one of: ${opts.knownRenderers.join(', ')}`,
          evidence: [`renderers are resolved from a fixed registry, not by file extension`],
        });
      }

      await probeIgnoredOut(bag, git, {
        file: manifestRepo,
        component: entry.id,
        locator: `${plocator}.out`,
        outRepo,
        submodulePaths,
      });

      const hasBaseline = trackedHead !== null && trackedHead.some((f) => f.startsWith(`${outRepo}/`));
      if (trackedHead !== null && !hasBaseline) {
        bag.add({
          code: 'V04D_NO_BASELINE',
          severity: 'info',
          file: manifestRepo,
          component: entry.id,
          locator: `${plocator}.out`,
          message: `no committed baseline yet`,
          fix: `run the producer and accept the result with --bootstrap`,
          evidence: [`nothing is tracked under ${outRepo}/ at HEAD`],
        });
      }

      const mergedProducer: Producer = {
        ...p,
        compare: eff.compare,
        timeoutMs: eff.timeoutMs,
        env: eff.env,
        runWhen: effectiveRunWhen,
        clean: eff.clean,
        ...(eff.renderer !== null ? { renderer: eff.renderer } : {}),
      };
      const resolvedProducer: ResolvedProducer = {
        ...mergedProducer,
        component: entry.id,
        baselineDir,
        receivedDir,
        absCwd,
        compareSpec: eff.compare,
        effectiveTimeoutMs: eff.timeoutMs,
        effectiveClean: eff.clean,
        effectiveRunWhen,
      };

      mergedProducers.push(mergedProducer);
      producerPlans.push({
        resolved: resolvedProducer,
        outRepo,
        receivedRepo,
        hasBaseline,
        forcedAlways: componentForced,
      });
      outDirs.push({ producer: `${entry.id}/${p.name}`, outAbs: realpathDeepest(baselineDir), outRepo });
    }

    /* ── witnesses ───────────────────────────────────────────────────── */
    const witnessesAuthored = manifest?.witnesses ?? [];
    const witnessMatches = expandWitnesses({
      bag,
      file: manifestRepo,
      component: entry.id,
      rootRepo,
      witnesses: witnessesAuthored,
      trackedHead,
      trackedBase,
      submodulePaths,
      outRepos: producerPlans.map((x) => x.outRepo),
    });

    const ingest = resolveIngest(manifest?.ingest, absRoot, baseDefaults);

    const resolved: ResolvedComponent = {
      entry,
      manifest,
      producers: producerPlans.map((x) => x.resolved),
      absRoot,
      absVibesDir,
      witnesses: witnessMatches.filter((w) => !w.negated).map((w) => w.repoGlob),
    };

    const effective: VibesManifest | null =
      manifest === null
        ? null
        : {
            component: entry.id,
            producers: mergedProducers,
            ...(witnessesAuthored.length > 0 ? { witnesses: witnessesAuthored } : {}),
            ...(manifest.ingest !== undefined ? { ingest: manifest.ingest } : {}),
            // `defaults` is deliberately dropped: every value is already folded
            // into the producers above, and leaving it would invite a reader to
            // apply it a second time.
          };

    plans.push({
      resolved,
      id: entry.id,
      title: entry.title ?? entry.id,
      rootRepo,
      manifestRepo,
      status,
      statusReason,
      producers: producerPlans,
      closure: closures.get(entry.id) ?? [],
      forcedAlways: componentForced,
      forcedAlwaysReason: componentForced ? describeForcing(entry, entries, opts.all === true) : null,
      implicitWitness: `${rootRepo}/${VIBES_DIRNAME}/**`,
      witnessesAuthored,
      witnessMatches,
      ingest,
      effective,
    });
  }

  checkOutCollisions(bag, outDirs);
  checkWitnessMulticlaim(bag, plans);

  return {
    repoRoot,
    baseRef: opts.baseRef,
    baseSha: opts.baseSha,
    headSha: opts.headSha,
    raw: rootLoad.config,
    report,
    failOn,
    concurrency,
    components: plans,
    diagnostics: sortDiagnostics(bag.items),
    ok: bag.ok,
  };
}

/* ─────────────────────── convenience accessors ───────────────────────── */

/** Every producer in the run, in component order. */
export function allProducers(config: ResolvedConfig): readonly ResolvedProducer[] {
  return config.components.flatMap((c) => c.producers.map((p) => p.resolved));
}

/** Only the producers whose component is actually going to run. Callers that
 *  reach for `allProducers` when they mean this one are the reason `not-run`
 *  and `verified-unchanged` get confused downstream. */
export function selectableProducers(config: ResolvedConfig): readonly ProducerPlan[] {
  return config.components.filter((c) => c.status === 'active').flatMap((c) => c.producers);
}

export function componentById(config: ResolvedConfig, id: ComponentId): ComponentPlan | null {
  return config.components.find((c) => c.id === id) ?? null;
}

/* ────────────────────────────── doctor ───────────────────────────────── */

export interface ValidationSummary {
  readonly ok: boolean;
  readonly config: ResolvedConfig;
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
  readonly infos: readonly Diagnostic[];
}

/**
 * The `vibes doctor` / `vibes check` entry point: full validation, zero
 * producers. Everything it can report, it reports in one pass — a validator
 * that stops at the first error trains authors to fix configs one round-trip
 * at a time.
 */
export async function validateAll(opts: ResolveOptions): Promise<ValidationSummary> {
  const config = await resolveConfig(opts);
  return {
    ok: config.ok,
    config,
    errors: config.diagnostics.filter((d) => d.severity === 'error'),
    warnings: config.diagnostics.filter((d) => d.severity === 'warn'),
    infos: config.diagnostics.filter((d) => d.severity === 'info'),
  };
}

/* ═════════════════════════════ helpers ════════════════════════════════ */

function resolveReport(repoRoot: string, config: VibesRootConfig | null): ResolvedReport {
  const out = normalizeRel(config?.report?.out ?? `${STATE_DIRNAME}/report`);
  return {
    out,
    absOut: resolvePath(repoRoot, out),
    formats: config?.report?.formats ?? ['md', 'json'],
    title: config?.report?.title ?? 'Vibes report',
    maxInlineDiffLines: config?.report?.maxInlineDiffLines ?? DEFAULT_MAX_INLINE_DIFF_LINES,
  };
}

/** Submodule roots come from `.gitmodules`, never from a hardcoded list. */
export function readSubmodulePaths(repoRoot: string): readonly RepoPath[] {
  const f = join(repoRoot, '.gitmodules');
  if (!existsSync(f)) return [];
  const out: string[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    const p = m?.[1];
    if (p !== undefined && p !== '') out.push(normalizeRel(p));
  }
  return out;
}

/** The submodule containing `p`, or null. Every git check-ignore call must be
 *  guarded by this: inside a submodule, check-ignore exits 128. */
export function insideSubmodule(p: RepoPath, submodules: readonly RepoPath[]): RepoPath | null {
  const n = normalizeRel(p);
  for (const s of submodules) {
    if (n === s || n.startsWith(`${s}/`)) return s;
  }
  return null;
}

function isSkippedByCli(id: ComponentId, opts: ResolveOptions): boolean {
  if (opts.only && opts.only.length > 0) return !opts.only.includes(id);
  if (opts.skip && opts.skip.length > 0) return opts.skip.includes(id);
  return false;
}

function checkSelection(
  bag: DiagnosticBag,
  opts: ResolveOptions,
  byId: ReadonlyMap<ComponentId, ComponentEntry>,
): void {
  const only = opts.only ?? [];
  const skip = opts.skip ?? [];
  if (only.length > 0 && skip.length > 0) {
    bag.add({
      code: 'V0A4_SELECTION_UNKNOWN',
      severity: 'error',
      file: ROOT_CONFIG_PATH,
      message: `--only and --skip are mutually exclusive`,
      fix: `pass one or the other`,
      evidence: [`--only ${only.join(',')}`, `--skip ${skip.join(',')}`],
    });
  }
  for (const [flag, ids] of [
    ['--only', only],
    ['--skip', skip],
  ] as const) {
    for (const id of ids) {
      if (byId.has(id)) continue;
      // Never a silent no-op: a typo'd --only would run nothing and the report
      // would look clean.
      bag.add({
        code: 'V0A4_SELECTION_UNKNOWN',
        severity: 'error',
        file: ROOT_CONFIG_PATH,
        message: `${flag} names unknown component '${id}'`,
        fix: `use one of: ${[...byId.keys()].join(', ')}`,
        evidence: [`the registry is the only source of component identity`],
      });
    }
  }
}

function checkRootPathsPairwise(
  bag: DiagnosticBag,
  repoRoot: string,
  entries: readonly ComponentEntry[],
  authoredIndex: (id: ComponentId) => number,
): void {
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (!a || !b) continue;
      const ra = realpathDeepest(resolvePath(repoRoot, a.root));
      const rb = realpathDeepest(resolvePath(repoRoot, b.root));
      if (ra !== rb && !isStrictDescendant(ra, rb) && !isStrictDescendant(rb, ra)) continue;
      // Nesting would let one component witness another's sources and would
      // make "changed under root" ambiguous. Checked across the explicit list —
      // trivial with five entries, impossible with glob discovery.
      bag.add({
        code: 'V023_ROOT_NESTED',
        severity: 'error',
        file: ROOT_CONFIG_PATH,
        locator: `components[${String(authoredIndex(b.id))}].root`,
        component: b.id,
        message: `root overlaps component '${a.id}'`,
        fix: `give each component a disjoint root, and express the relationship with dependsOn`,
        evidence: [`${a.id}: ${ra}`, `${b.id}: ${rb}`],
      });
    }
  }
}

function resolveDependsOn(
  bag: DiagnosticBag,
  entries: readonly ComponentEntry[],
  byId: ReadonlyMap<ComponentId, ComponentEntry>,
  authoredIndex: (id: ComponentId) => number,
): ReadonlyMap<ComponentId, readonly ComponentId[]> {
  for (const e of entries) {
    const i = authoredIndex(e.id);
    for (const [j, dep] of (e.dependsOn ?? []).entries()) {
      if (dep === e.id) {
        bag.add({
          code: 'V029_DEPENDSON_CYCLE',
          severity: 'error',
          file: ROOT_CONFIG_PATH,
          locator: `components[${i}].dependsOn[${j}]`,
          component: e.id,
          message: `component depends on itself`,
          fix: `remove '${dep}' from dependsOn`,
          evidence: [],
        });
      } else if (!byId.has(dep)) {
        bag.add({
          code: 'V028_DEPENDSON_UNKNOWN',
          severity: 'error',
          file: ROOT_CONFIG_PATH,
          locator: `components[${i}].dependsOn[${j}]`,
          component: e.id,
          message: `unknown component '${dep}'`,
          fix: `name a registered component id, or add '${dep}' to the registry`,
          evidence: [`registered: ${[...byId.keys()].join(', ')}`],
        });
      }
    }
  }

  const closures = new Map<ComponentId, readonly ComponentId[]>();
  const state = new Map<ComponentId, 'visiting' | 'done'>();
  const reported = new Set<string>();

  const visit = (id: ComponentId, path: readonly ComponentId[]): readonly ComponentId[] => {
    const cached = closures.get(id);
    if (state.get(id) === 'done' && cached) return cached;
    if (state.get(id) === 'visiting') {
      const cycle = [...path.slice(path.indexOf(id)), id].join(' → ');
      if (!reported.has(cycle)) {
        reported.add(cycle);
        bag.add({
          code: 'V029_DEPENDSON_CYCLE',
          severity: 'error',
          file: ROOT_CONFIG_PATH,
          component: id,
          message: `dependsOn cycle`,
          fix: `break the cycle — a component must run after everything it depends on`,
          evidence: [cycle],
        });
      }
      return [];
    }
    state.set(id, 'visiting');
    const acc = new Set<ComponentId>();
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id || !byId.has(dep)) continue;
      acc.add(dep);
      for (const t of visit(dep, [...path, id])) acc.add(t);
    }
    const result = [...acc].sort();
    state.set(id, 'done');
    closures.set(id, result);
    return result;
  };

  for (const e of entries) visit(e.id, []);
  return closures;
}

/**
 * INPUT-CLOSURE FORCING. A component whose root intersects ANOTHER component's
 * `generates` glob can never be honestly reported as `skipped-unchanged`: its
 * real input is a generated artifact that is usually gitignored and therefore
 * invisible to every witness. The producer of the artifact declares its
 * consumers' paths; the consumer never has to know.
 */
function computeForcedAlways(entries: readonly ComponentEntry[], all: boolean): ReadonlySet<ComponentId> {
  const forced = new Set<ComponentId>();
  if (all) {
    for (const e of entries) forced.add(e.id);
    return forced;
  }
  for (const consumer of entries) {
    for (const producer of entries) {
      if (producer.id === consumer.id) continue;
      for (const g of producer.generates ?? []) {
        if (globIntersectsDir(g, normalizeRel(consumer.root))) {
          forced.add(consumer.id);
        }
      }
    }
  }
  return forced;
}

function describeForcing(entry: ComponentEntry, entries: readonly ComponentEntry[], all: boolean): string {
  if (all) return '--all';
  const sources: string[] = [];
  for (const producer of entries) {
    if (producer.id === entry.id) continue;
    for (const g of producer.generates ?? []) {
      if (globIntersectsDir(g, normalizeRel(entry.root))) sources.push(`${producer.id}:${g}`);
    }
  }
  return `consumes generated paths (${sources.join(', ')})`;
}

interface OutCheck {
  readonly file: RepoPath;
  readonly component: ComponentId;
  readonly locator: string;
  readonly absVibesDir: string;
  readonly baselineDir: string;
  readonly outRepo: RepoPath;
  readonly manifestAbs: string;
  readonly submodulePaths: readonly RepoPath[];
}

function checkOut(bag: DiagnosticBag, c: OutCheck): void {
  const realVibes = realpathDeepest(c.absVibesDir);
  const realOut = realpathDeepest(c.baselineDir);
  if (!isStrictDescendant(realVibes, realOut)) {
    bag.add({
      code: 'V043_OUT_ESCAPES',
      severity: 'error',
      file: c.file,
      component: c.component,
      locator: c.locator,
      message: `out must resolve strictly inside <root>/${VIBES_DIRNAME}/`,
      fix: `use out: 'snapshots/<name>'`,
      evidence: [`vibes dir: ${realVibes}`, `resolved out: ${realOut}`],
    });
    return;
  }
  if (realOut === realpathDeepest(c.manifestAbs)) {
    bag.add({
      code: 'V043_OUT_ESCAPES',
      severity: 'error',
      file: c.file,
      component: c.component,
      locator: c.locator,
      message: `out must not be the manifest itself`,
      fix: `use a subdirectory such as 'snapshots/<name>'`,
      evidence: [`resolved out: ${realOut}`],
    });
  }
  const sub = insideSubmodule(c.outRepo, c.submodulePaths);
  if (sub !== null) {
    bag.add({
      code: 'V047_OUT_IN_SUBMODULE',
      severity: 'error',
      file: c.file,
      component: c.component,
      locator: c.locator,
      message: `out is inside the submodule '${sub}'`,
      fix: `move the snapshots into the superproject`,
      evidence: [`superproject git is silently empty inside a submodule`],
    });
  }
  if (isSymlink(c.baselineDir)) {
    bag.add({
      code: 'V04I_OUT_IS_SYMLINK',
      severity: 'error',
      file: c.file,
      component: c.component,
      locator: c.locator,
      message: `out is a symlink`,
      fix: `make out a real directory — containment cannot be trusted through a link`,
      evidence: [`path: ${c.baselineDir}`],
    });
  }
  const onDisk = actualCaseMismatch(c.baselineDir);
  if (onDisk !== null) {
    // Works on APFS (core.ignorecase=true), breaks on the ubuntu runner.
    bag.add({
      code: 'V04H_OUT_CASE_MISMATCH',
      severity: 'error',
      file: c.file,
      component: c.component,
      locator: c.locator,
      message: `out differs in case from the directory on disk`,
      fix: `match the on-disk spelling exactly: '${onDisk}'`,
      evidence: [`declared: ${c.outRepo}`, `on disk: ${onDisk}`],
    });
  }
}

interface CwdCheck {
  readonly file: RepoPath;
  readonly component: ComponentId;
  readonly locator: string;
  readonly absRoot: string;
  readonly absCwd: string;
  readonly declared: string;
}

function checkCwd(bag: DiagnosticBag, c: CwdCheck): void {
  const realRoot = realpathDeepest(c.absRoot);
  const realCwd = realpathDeepest(c.absCwd);
  if (realCwd !== realRoot && !isStrictDescendant(realRoot, realCwd)) {
    bag.add({
      code: 'V04F_CWD_ESCAPES_ROOT',
      severity: 'error',
      file: c.file,
      component: c.component,
      locator: c.locator,
      message: `cwd resolves outside the component root`,
      fix: `use a path inside the root, or move the work into the component that owns it`,
      evidence: [`root: ${realRoot}`, `resolved cwd: ${realCwd}`],
    });
    return;
  }
  if (!existsSync(c.absCwd)) {
    bag.add({
      code: 'V048_CWD_MISSING',
      severity: 'error',
      file: c.file,
      component: c.component,
      locator: c.locator,
      message: `cwd '${c.declared}' does not exist`,
      fix: `create the directory or fix the path — cwd anchors at the component root`,
      evidence: [`resolved: ${c.absCwd}`],
    });
  }
}

interface ProbeCheck {
  readonly file: RepoPath;
  readonly component: ComponentId;
  readonly locator: string;
  readonly outRepo: RepoPath;
  readonly submodulePaths: readonly RepoPath[];
}

/**
 * A DIRECTORY-LEVEL ignore probe is not enough and this is the check that
 * proves it: `snapshots/` is not ignored anywhere in this repo, but
 * `snapshots/run.log`, `snapshots/parse.bin`, `snapshots/x.tmp` and
 * `snapshots/x.bak` all are, through bare extension patterns in the root
 * `.gitignore`. A snapshot that git hides is a snapshot that compares equal to
 * nothing, forever, silently.
 *
 * DELIBERATE SEVERITY SPLIT (a refinement of the spec's "any hit is an error"):
 *   - the EXTENSIONLESS probe being ignored means the whole out dir is hidden →
 *     error, nothing written here can ever be a baseline.
 *   - only extension probes being ignored means SOME filenames are unsafe →
 *     warn, naming which. Erroring here would block every component in a repo
 *     that ignores `*.log` repo-wide (this one does) even when no producer
 *     emits such a file, and the per-file post-run check is the one that must
 *     hard-fail anyway — it sees the real filenames instead of guessing.
 */
async function probeIgnoredOut(
  bag: DiagnosticBag,
  git: GitPort | undefined,
  c: ProbeCheck,
): Promise<void> {
  if (!git) return;
  if (insideSubmodule(c.outRepo, c.submodulePaths) !== null) return;
  const hits: string[] = [];
  let dirHidden = false;
  for (const name of IGNORE_PROBE_NAMES) {
    const p = `${c.outRepo}/${name}`;
    try {
      if (await git.isIgnored(p)) {
        hits.push(p);
        if (!name.includes('.', 1)) dirHidden = true;
      }
    } catch {
      return; // a git failure is reported once, by the caller of lsTree
    }
  }
  if (hits.length === 0) return;
  bag.add({
    code: 'V045_OUT_IGNORED_DIR',
    severity: dirHidden ? 'error' : 'warn',
    file: c.file,
    component: c.component,
    locator: c.locator,
    message: dirHidden ? `everything written here is gitignored` : `some filenames here would be gitignored`,
    fix: dirHidden
      ? `rename the directory — a nested '!' cannot re-include a file under an excluded directory`
      : `add negations to <root>/${VIBES_DIRNAME}/.gitignore, or avoid those extensions`,
    evidence: [
      ...hits.map((h) => `ignored: ${h}`),
      `the mandatory post-run per-file check hard-fails on any file that is actually ignored`,
    ],
  });
}

async function checkReportIgnored(
  bag: DiagnosticBag,
  git: GitPort | undefined,
  report: ResolvedReport,
  submodulePaths: readonly RepoPath[],
): Promise<void> {
  if (!git) return;
  if (insideSubmodule(report.out, submodulePaths) !== null) return;
  try {
    if (await git.isIgnored(`${report.out}/report.json`)) return;
  } catch {
    return;
  }
  bag.add({
    code: 'V016_REPORT_OUT_UNIGNORED',
    severity: 'warn',
    file: '.gitignore',
    locator: 'report.out',
    message: `report output is not gitignored`,
    fix: `add '${report.out}/' to .gitignore`,
    evidence: [
      `an unignored report becomes an input to its own next run`,
      `checked: ${report.out}/report.json`,
    ],
  });
}

function checkOutCollisions(
  bag: DiagnosticBag,
  outs: readonly { producer: string; outAbs: string; outRepo: RepoPath }[],
): void {
  for (let i = 0; i < outs.length; i += 1) {
    for (let j = i + 1; j < outs.length; j += 1) {
      const a = outs[i];
      const b = outs[j];
      if (!a || !b) continue;
      const same = a.outAbs === b.outAbs;
      const nested = isStrictDescendant(a.outAbs, b.outAbs) || isStrictDescendant(b.outAbs, a.outAbs);
      if (!same && !nested) continue;
      // Nesting is fatal, not cosmetic: pre-cleaning the outer dir wipes the
      // inner one, and the inner producer then reports its whole corpus deleted.
      bag.add({
        code: 'V044_OUT_COLLISION',
        severity: 'error',
        file: ROOT_CONFIG_PATH,
        message: same ? `two producers share an out dir` : `producer out dirs are nested`,
        fix: `give every producer a disjoint out directory`,
        evidence: [`${a.producer}: ${a.outRepo}`, `${b.producer}: ${b.outRepo}`],
      });
    }
  }
}

interface WitnessArgs {
  readonly bag: DiagnosticBag;
  readonly file: RepoPath;
  readonly component: ComponentId;
  readonly rootRepo: RepoPath;
  readonly witnesses: readonly Glob[];
  readonly trackedHead: readonly RepoPath[] | null;
  readonly trackedBase: readonly RepoPath[] | null;
  readonly submodulePaths: readonly RepoPath[];
  readonly outRepos: readonly RepoPath[];
}

/**
 * Witnesses are matched against the git-TRACKED set, never the filesystem.
 * Consequence, and it is intended: a gitignored generated directory can never
 * be witnessed. That gap is closed by `generates` in the registry, not by
 * quietly letting a witness claim an invisible file.
 */
function expandWitnesses(a: WitnessArgs): readonly WitnessMatch[] {
  const out: WitnessMatch[] = [];
  const negatives = a.witnesses.filter((w) => w.startsWith('!')).map((w) => anchorGlob(a.rootRepo, w).slice(1));
  const isExcluded = negatives.length === 0
    ? () => false
    : picomatch(negatives as string[], { dot: false, nobrace: true });

  for (const [i, w] of a.witnesses.entries()) {
    const locator = `witnesses[${i}]`;
    const negated = w.startsWith('!');
    const repoGlob = anchorGlob(a.rootRepo, w);
    const body = negated ? repoGlob.slice(1) : repoGlob;

    // Defence in depth. Unreachable while shape validation rejects `..`
    // segments, because anchorGlob() prefixes every witness with its own root —
    // but the day someone relaxes that, this is the check that keeps one
    // component from claiming another's sources.
    if (!globIntersectsDir(body, a.rootRepo)) {
      a.bag.add({
        code: 'V051_WITNESS_ESCAPES_ROOT',
        severity: 'error',
        file: a.file,
        component: a.component,
        locator,
        message: `witness cannot reach outside the component root`,
        fix: `a source outside '${a.rootRepo}' belongs to another component — add it to the registry and use dependsOn`,
        evidence: [`resolved: ${body}`],
      });
      continue;
    }

    const sub = insideSubmodule(globPrefixOf(body), a.submodulePaths);
    if (sub !== null) {
      a.bag.add({
        code: 'V056_WITNESS_IN_SUBMODULE',
        severity: 'error',
        file: a.file,
        component: a.component,
        locator,
        message: `witness points inside the submodule '${sub}'`,
        fix: `declare submodules: ['${sub}'] in the registry instead`,
        evidence: [`git ls-files returns only the gitlink for a submodule path`],
      });
      continue;
    }

    for (const outRepo of a.outRepos) {
      if (!globIntersectsDir(body, outRepo)) continue;
      a.bag.add({
        code: 'V055_WITNESS_IN_OUT',
        severity: 'error',
        file: a.file,
        component: a.component,
        locator,
        message: `witness matches files inside a producer out dir`,
        fix: `narrow the witness — snapshots cannot witness themselves`,
        evidence: [`out dir: ${outRepo}`, `witness: ${body}`],
      });
      break;
    }

    const match = picomatch(body, { dot: false, nobrace: true });
    const matched =
      a.trackedHead === null || negated
        ? []
        : a.trackedHead.filter((p) => match(p) && !isExcluded(p));
    const matchedAtBase =
      a.trackedBase === null || negated
        ? []
        : a.trackedBase.filter((p) => match(p) && !isExcluded(p));

    if (!negated && a.trackedHead !== null && matched.length === 0) {
      if (matchedAtBase.length > 0) {
        // The source legitimately went away. A warning names the retirement;
        // an error here would punish a deletion PR for being a deletion.
        a.bag.add({
          code: 'V054_WITNESS_RETIRED',
          severity: 'warn',
          file: a.file,
          component: a.component,
          locator,
          message: `witness matched ${String(matchedAtBase.length)} file(s) at base, none now`,
          fix: `remove the witness if the source is gone for good`,
          evidence: [`example at base: ${matchedAtBase[0] ?? ''}`],
        });
      } else {
        // Matched nothing at base either: the claim never meant anything. This
        // is what catches a component rename that left the witness behind.
        a.bag.add({
          code: 'V053_WITNESS_ZERO_ALWAYS',
          severity: 'error',
          file: a.file,
          component: a.component,
          locator,
          message: `witness matches no tracked file, and never did`,
          fix: `fix the pattern, or delete it — a claim that matches nothing supports no verdict`,
          evidence: [`resolved: ${body}`, `matched at base and at HEAD: 0`],
        });
      }
    }

    out.push({ glob: w, repoGlob, matched, matchedAtBase, negated });
  }
  return out;
}

function globPrefixOf(g: Glob): RepoPath {
  const parts = g.split('/');
  const literal: string[] = [];
  for (const seg of parts) {
    if (seg === '**' || /[*?[\]()!+@]/.test(seg)) break;
    literal.push(seg);
  }
  return literal.join('/');
}

/**
 * Cross-root multi-claim.
 *
 * This is currently UNREACHABLE by construction — roots may not nest (V023) and
 * a witness may not escape its root (V051), so a tracked file lies under
 * exactly one component. The check stays because it costs one map and it is the
 * thing that fails loudly if either of those two guards is ever relaxed:
 * coverage is NOT a set union, and a healthy component absorbing a failed
 * sibling's changed files is the laundering path this design exists to close.
 */
function checkWitnessMulticlaim(bag: DiagnosticBag, plans: readonly ComponentPlan[]): void {
  const claims = new Map<RepoPath, ComponentId[]>();
  for (const plan of plans) {
    for (const w of plan.witnessMatches) {
      for (const p of w.matched) {
        const list = claims.get(p) ?? [];
        if (!list.includes(plan.id)) list.push(plan.id);
        claims.set(p, list);
      }
    }
  }
  for (const [path, ids] of claims) {
    if (ids.length < 2) continue;
    bag.add({
      code: 'V057_WITNESS_MULTICLAIM',
      severity: 'error',
      file: ROOT_CONFIG_PATH,
      message: `'${path}' is claimed by ${String(ids.length)} components`,
      fix: `give the file one owner and express the relationship with dependsOn`,
      evidence: [`claimants: ${ids.join(', ')}`, `coverage is not a set union`],
    });
  }
}

function resolveIngest(
  spec: IngestSpec | undefined,
  absRoot: string,
  defaults: EffectiveDefaults,
): ResolvedIngest | null {
  if (!spec) return null;
  const asList = (v: Glob | readonly Glob[] | undefined): readonly Glob[] =>
    v === undefined ? [] : typeof v === 'string' ? [v] : [...v];

  const lcov: { glob: Glob; absSourceRoot: string }[] = [];
  const rawLcov = spec.lcov;
  if (Array.isArray(rawLcov) && rawLcov.every((x) => typeof x === 'object' && x !== null)) {
    for (const item of rawLcov as readonly { path: Glob; sourceRoot?: string }[]) {
      lcov.push({ glob: item.path, absSourceRoot: resolvePath(absRoot, item.sourceRoot ?? '.') });
    }
  } else {
    for (const g of asList(rawLcov as Glob | readonly Glob[] | undefined)) {
      lcov.push({ glob: g, absSourceRoot: absRoot });
    }
  }

  return {
    cmd: spec.cmd ?? null,
    absCwd: resolvePath(absRoot, spec.cwd ?? '.'),
    env: { ...defaults.env, ...(spec.env ?? {}) },
    timeoutMs: spec.timeoutMs ?? defaults.timeoutMs,
    junit: asList(spec.junit),
    vitestJson: asList(spec.vitestJson),
    pioJson: asList(spec.pioJson),
    lcov,
    // Zero matches is an error by default: an ingest that silently matched
    // nothing renders as "no test evidence" and looks like a configuration
    // choice rather than a broken path.
    required: spec.required ?? true,
  };
}

async function safeLsTree(
  bag: DiagnosticBag,
  git: GitPort | undefined,
  sha: Sha,
  label: string,
): Promise<readonly RepoPath[] | null> {
  if (!git) return null;
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    bag.add({
      code: 'V014_BASEREF_UNRESOLVED',
      severity: 'error',
      file: ROOT_CONFIG_PATH,
      locator: 'baseRef',
      message: `${label} sha is not a 40-char object id`,
      fix: `no MaD workflow sets fetch-depth, so actions/checkout clones at depth 1 and origin/main does not exist on the runner — set fetch-depth: 0 or pass VIBES_BASE_SHA`,
      evidence: [`got ${JSON.stringify(sha)}`],
    });
    return null;
  }
  try {
    return await git.lsTree(sha);
  } catch (err) {
    bag.add({
      code: 'V014_BASEREF_UNRESOLVED',
      severity: 'error',
      file: ROOT_CONFIG_PATH,
      locator: 'baseRef',
      message: `cannot read the ${label} tree`,
      fix: `set fetch-depth: 0 in the workflow, or pass VIBES_BASE_SHA explicitly`,
      evidence: [sha, err instanceof Error ? err.message : String(err)],
    });
    return null;
  }
}

async function safeListFiles(
  bag: DiagnosticBag,
  git: GitPort | undefined,
): Promise<readonly RepoPath[] | null> {
  if (!git) return null;
  try {
    return await git.listFiles();
  } catch (err) {
    bag.add({
      code: 'V001_GIT_UNAVAILABLE',
      severity: 'error',
      file: ROOT_CONFIG_PATH,
      message: `git could not list the working tree`,
      fix: `run vibes from inside a git repository`,
      evidence: [err instanceof Error ? err.message : String(err)],
    });
    return null;
  }
}
