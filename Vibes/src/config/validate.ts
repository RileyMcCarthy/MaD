/**
 * Pure shape validation. No filesystem, no git, no spawning — everything here
 * runs on an already-loaded plain object, which is what makes `vibes doctor`
 * safe to run on any PR and inside a pre-commit hook.
 *
 * Two rules drive every decision in this file:
 *
 *  1. UNKNOWN KEYS ARE ERRORS, at both levels. A tool whose product is a
 *     trustworthy claim cannot silently ignore its own configuration — a
 *     typo'd `witneses:` that validated clean would report a component as
 *     claiming nothing while looking configured.
 *
 *  2. Every diagnostic names the file, the field (`locator`) and the fix.
 */

import type {
  ComponentEntry,
  ComponentId,
  CompareMode,
  CompareRule,
  CompareSpec,
  IngestSpec,
  Producer,
  RepoPath,
  SharedDefaults,
  VibesManifest,
  VibesRootConfig,
} from '../types.js';
import { COMPONENT_ID_RE, PRODUCER_NAME_RE } from '../types.js';
import {
  COMPONENT_KEYS,
  FAIL_ON_KEYS,
  INGEST_KEYS,
  MANIFEST_KEYS,
  MAX_CONCURRENCY,
  PIXEL_MAX_DIFF_RATIO_MAX,
  PRODUCER_KEYS,
  REGISTRY_ONLY_KEYS,
  REPORT_FORMATS,
  REPORT_KEYS,
  ROOT_KEYS,
  RUN_WHEN_VALUES,
  SHARED_DEFAULT_KEYS,
  TIER_VALUES,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  TOLERANCE_ABS_MAX,
  TOLERANCE_REL_MAX,
  VIBES_DIRNAME,
} from './constants.js';
import type { Diagnostic, DiagnosticCode } from './diagnostics.js';
import { DiagnosticBag } from './diagnostics.js';
import { checkGlob, checkRelPath, normalizeRel } from './paths.js';

/* ───────────────────────────── helpers ───────────────────────────────── */

interface Ctx {
  readonly bag: DiagnosticBag;
  readonly file: RepoPath;
  readonly component?: ComponentId | undefined;
  /** Which unknown-key code this level uses: V012 (root) or V036 (manifest). */
  readonly unknownKeyCode: DiagnosticCode;
}

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** `components[2]` + `root` → `components[2].root`; `''` + `baseRef` → `baseRef`. */
function at(locator: string, key: string): string {
  return locator === '' ? key : `${locator}.${key}`;
}

function bad(
  ctx: Ctx,
  code: DiagnosticCode,
  locator: string,
  message: string,
  fix: string,
  evidence: readonly string[] = [],
): void {
  ctx.bag.add({
    code,
    severity: 'error',
    file: ctx.file,
    locator,
    message,
    fix,
    evidence,
    component: ctx.component,
  });
}

function warn(
  ctx: Ctx,
  code: DiagnosticCode,
  locator: string,
  message: string,
  fix: string,
  evidence: readonly string[] = [],
): void {
  ctx.bag.add({
    code,
    severity: 'warn',
    file: ctx.file,
    locator,
    message,
    fix,
    evidence,
    component: ctx.component,
  });
}

function unknownKeys(ctx: Ctx, obj: Obj, allowed: readonly string[], locator: string): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    const registryOnly = (REGISTRY_ONLY_KEYS as readonly string[]).includes(key);
    if (registryOnly && ctx.unknownKeyCode === 'V036_MANIFEST_UNKNOWN_KEY') {
      // R-L7: this is the enforcement of the split, and it deserves its own
      // code — `root:` in a manifest is not a typo, it is a scope narrowing.
      bad(
        ctx,
        'V037_REGISTRY_KEY_IN_MANIFEST',
        at(locator, key),
        `'${key}' belongs in the root registry, not in a manifest`,
        `move '${key}' to the matching entry in vibes.config.mjs`,
        [`identity, existence, scope and suppression live in one reviewed file`],
      );
      continue;
    }
    bad(
      ctx,
      ctx.unknownKeyCode,
      at(locator, key),
      `unknown key '${key}'`,
      `remove '${key}', or fix the spelling`,
      [`allowed here: ${allowed.join(', ')}`],
    );
  }
}

function reqString(ctx: Ctx, obj: Obj, key: string, locator: string, fix: string): string | null {
  const v = obj[key];
  if (typeof v === 'string' && v.length > 0) return v;
  bad(
    ctx,
    'V0A3_FIELD_TYPE',
    at(locator, key),
    v === undefined ? `'${key}' is required` : `'${key}' must be a non-empty string`,
    fix,
    [`got ${typeName(v)}`],
  );
  return null;
}

function optString(ctx: Ctx, obj: Obj, key: string, locator: string): string | null {
  const v = obj[key];
  if (v === undefined) return null;
  if (typeof v === 'string' && v.length > 0) return v;
  bad(
    ctx,
    'V0A3_FIELD_TYPE',
    at(locator, key),
    `'${key}' must be a non-empty string`,
    `remove '${key}' or give it a string value`,
    [`got ${typeName(v)}`],
  );
  return null;
}

function optBoolean(ctx: Ctx, obj: Obj, key: string, locator: string): boolean | null {
  const v = obj[key];
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v;
  bad(
    ctx,
    'V0A3_FIELD_TYPE',
    at(locator, key),
    `'${key}' must be true or false`,
    `set '${key}' to a boolean`,
    [`got ${typeName(v)}`],
  );
  return null;
}

function optInt(
  ctx: Ctx,
  obj: Obj,
  key: string,
  locator: string,
  min: number,
  max: number,
  code: DiagnosticCode = 'V0A3_FIELD_TYPE',
): number | null {
  const v = obj[key];
  if (v === undefined) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) return v;
  bad(
    ctx,
    code,
    at(locator, key),
    `'${key}' must be an integer in [${min}, ${max}]`,
    `set '${key}' within [${min}, ${max}]`,
    [`got ${typeName(v)}${typeof v === 'number' ? ` (${v})` : ''}`],
  );
  return null;
}

function optStringArray(ctx: Ctx, obj: Obj, key: string, locator: string): readonly string[] {
  const v = obj[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    bad(
      ctx,
      'V0A3_FIELD_TYPE',
      at(locator, key),
      `'${key}' must be an array of strings`,
      `wrap the value in an array`,
      [`got ${typeName(v)}`],
    );
    return [];
  }
  const out: string[] = [];
  for (const [i, item] of v.entries()) {
    if (typeof item === 'string' && item.length > 0) {
      out.push(item);
    } else {
      bad(
        ctx,
        'V0A3_FIELD_TYPE',
        `${at(locator, key)}[${i}]`,
        `entry must be a non-empty string`,
        `remove the entry or replace it with a string`,
        [`got ${typeName(item)}`],
      );
    }
  }
  return out;
}

function checkEnv(ctx: Ctx, obj: Obj, locator: string): void {
  const v = obj['env'];
  if (v === undefined) return;
  if (!isPlainObject(v)) {
    bad(ctx, 'V0A3_FIELD_TYPE', at(locator, 'env'), `'env' must be an object`, `use { KEY: 'value' }`, [
      `got ${typeName(v)}`,
    ]);
    return;
  }
  for (const key of Object.keys(v)) {
    const val = v[key];
    if (typeof val === 'string' || val === null) continue;
    bad(
      ctx,
      'V0A3_FIELD_TYPE',
      `${at(locator, 'env')}.${key}`,
      `env values must be a string or null`,
      `use a string, or null to unset the variable in the child`,
      [`got ${typeName(val)}`],
    );
  }
}

/** Root-relative or repo-relative glob list, brace-rejected. */
function checkGlobList(
  ctx: Ctx,
  values: readonly string[],
  locator: string,
  braceCodeFix: string,
): void {
  for (const [i, g] of values.entries()) {
    const problem = checkGlob(g);
    if (!problem) continue;
    const code: DiagnosticCode = problem.reason.includes('brace')
      ? 'V0A0_GLOB_BRACES'
      : problem.reason.includes('".."') || problem.reason.includes('relative')
        ? 'V0A1_PATH_NOT_POSIX'
        : 'V0A1_PATH_NOT_POSIX';
    bad(ctx, code, `${locator}[${i}]`, `glob ${problem.reason}`, braceCodeFix, [problem.evidence]);
  }
}

/* ──────────────────────────── compare spec ───────────────────────────── */

const COMPARE_MODE_KEYS: Readonly<Record<string, readonly string[]>> = {
  exact: ['kind'],
  tolerance: ['kind', 'abs', 'rel', 'columns', 'reason'],
  pixel: ['kind', 'maxDiffRatio', 'threshold', 'reason'],
};

function validateCompareMode(ctx: Ctx, v: unknown, locator: string): CompareMode | null {
  if (!isPlainObject(v)) {
    bad(ctx, 'V0A3_FIELD_TYPE', locator, `compare mode must be an object`, `use { kind: 'exact' }`, [
      `got ${typeName(v)}`,
    ]);
    return null;
  }
  const kind = v['kind'];
  if (kind !== 'exact' && kind !== 'tolerance' && kind !== 'pixel') {
    bad(
      ctx,
      'V0A3_FIELD_TYPE',
      `${locator}.kind`,
      `compare kind must be 'exact', 'tolerance' or 'pixel'`,
      `set kind to one of exact | tolerance | pixel`,
      [`got ${JSON.stringify(kind)}`],
    );
    return null;
  }
  unknownKeys(ctx, v, COMPARE_MODE_KEYS[kind] ?? ['kind'], locator);

  if (kind === 'exact') return { kind: 'exact' };

  // The reason is MANDATORY for every loosened comparison, and it is rendered
  // next to the verdict: the epsilon is a number the same agent wrote in the
  // same PR, so the justification is the only thing a reviewer can weigh.
  const reason = reqString(ctx, v, 'reason', locator, 'state why this file cannot be compared exactly');
  if (reason === null) {
    ctx.bag.add({
      code: 'V04C_TOLERANCE_NO_REASON',
      severity: 'error',
      file: ctx.file,
      locator: `${locator}.reason`,
      message: `a loosened comparison needs a stated reason`,
      fix: `add reason: '<why exact comparison is impossible here>'`,
      evidence: [`kind: ${kind}`],
      ...(ctx.component !== undefined ? { component: ctx.component } : {}),
    });
  }

  if (kind === 'tolerance') {
    const abs = numberInRange(ctx, v, 'abs', locator, 0, TOLERANCE_ABS_MAX);
    const rel = numberInRange(ctx, v, 'rel', locator, 0, TOLERANCE_REL_MAX);
    if (abs === null && rel === null) {
      bad(
        ctx,
        'V04B_TOLERANCE_UNBOUNDED',
        locator,
        `tolerance needs at least one of 'abs' or 'rel'`,
        `add abs or rel — an unbounded tolerance compares nothing`,
        [`abs max ${TOLERANCE_ABS_MAX}, rel max ${TOLERANCE_REL_MAX}`],
      );
    }
    const columns = optStringArray(ctx, v, 'columns', locator);
    if (reason === null) return null;
    return {
      kind: 'tolerance',
      reason,
      ...(abs !== null ? { abs } : {}),
      ...(rel !== null ? { rel } : {}),
      ...(columns.length > 0 ? { columns } : {}),
    };
  }

  const maxDiffRatio = numberInRange(ctx, v, 'maxDiffRatio', locator, 0, PIXEL_MAX_DIFF_RATIO_MAX);
  const threshold = numberInRange(ctx, v, 'threshold', locator, 0, 1);
  if (reason === null) return null;
  return {
    kind: 'pixel',
    reason,
    ...(maxDiffRatio !== null ? { maxDiffRatio } : {}),
    ...(threshold !== null ? { threshold } : {}),
  };
}

function numberInRange(
  ctx: Ctx,
  obj: Obj,
  key: string,
  locator: string,
  exclusiveMin: number,
  max: number,
): number | null {
  const v = obj[key];
  if (v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v) && v > exclusiveMin && v <= max) return v;
  bad(
    ctx,
    'V04B_TOLERANCE_UNBOUNDED',
    at(locator, key),
    `'${key}' must be a number in (${exclusiveMin}, ${max}]`,
    `lower '${key}' to at most ${max}`,
    [`got ${typeName(v)}${typeof v === 'number' ? ` (${v})` : ''}`],
  );
  return null;
}

export function validateCompareSpec(ctx: Ctx, v: unknown, locator: string): CompareSpec | null {
  if (Array.isArray(v)) {
    const rules: CompareRule[] = [];
    for (const [i, raw] of v.entries()) {
      const rl = `${locator}[${i}]`;
      if (!isPlainObject(raw)) {
        bad(ctx, 'V0A3_FIELD_TYPE', rl, `compare rule must be an object`, `use { match, use }`, [
          `got ${typeName(raw)}`,
        ]);
        continue;
      }
      unknownKeys(ctx, raw, ['match', 'use'], rl);
      const match = reqString(ctx, raw, 'match', rl, `add match: '**/*.csv'`);
      if (match !== null) checkGlobList(ctx, [match], `${rl}.match`, 'write the pattern without braces');
      const use = validateCompareMode(ctx, raw['use'], `${rl}.use`);
      if (match !== null && use !== null) rules.push({ match, use });
    }
    return rules;
  }
  return validateCompareMode(ctx, v, locator);
}

/* ───────────────────────── shared defaults ───────────────────────────── */

function validateSharedDefaults(ctx: Ctx, v: unknown, locator: string): SharedDefaults | null {
  if (v === undefined) return null;
  if (!isPlainObject(v)) {
    bad(ctx, 'V0A3_FIELD_TYPE', locator, `'defaults' must be an object`, `use an object or remove it`, [
      `got ${typeName(v)}`,
    ]);
    return null;
  }
  unknownKeys(ctx, v, SHARED_DEFAULT_KEYS, locator);

  const compare = v['compare'] === undefined ? null : validateCompareSpec(ctx, v['compare'], `${locator}.compare`);
  const renderer = optString(ctx, v, 'renderer', locator);
  const timeoutMs = optInt(ctx, v, 'timeoutMs', locator, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, 'V049_TIMEOUT_RANGE');
  checkEnv(ctx, v, locator);
  const runWhen = validateRunWhen(ctx, v['runWhen'], `${locator}.runWhen`);
  const clean = optBoolean(ctx, v, 'clean', locator);

  return {
    ...(compare !== null ? { compare } : {}),
    ...(renderer !== null ? { renderer } : {}),
    ...(timeoutMs !== null ? { timeoutMs } : {}),
    ...(v['env'] !== undefined && isPlainObject(v['env'])
      ? { env: v['env'] as Readonly<Record<string, string | null>> }
      : {}),
    ...(runWhen !== null ? { runWhen } : {}),
    ...(clean !== null ? { clean } : {}),
  };
}

function validateRunWhen(ctx: Ctx, v: unknown, locator: string): 'always' | 'changed' | null {
  if (v === undefined) return null;
  if (v === 'always' || v === 'changed') return v;
  bad(
    ctx,
    'V0A3_FIELD_TYPE',
    locator,
    `'runWhen' must be 'always' or 'changed'`,
    `set runWhen to always or changed`,
    [`got ${JSON.stringify(v)}`, `allowed: ${RUN_WHEN_VALUES.join(' | ')}`],
  );
  return null;
}

/* ═══════════════════════════ ROOT REGISTRY ════════════════════════════ */

export interface RootValidation {
  readonly config: VibesRootConfig | null;
  /** Entries structurally sound enough to resolve (valid id and root string). */
  readonly entries: readonly ComponentEntry[];
  /**
   * id → index in the AUTHORED `components` array. Resolution sorts entries by
   * id for determinism, so without this every downstream `components[i]`
   * locator would point a reader at the wrong entry in their own file.
   */
  readonly indexById: ReadonlyMap<ComponentId, number>;
  readonly diagnostics: readonly Diagnostic[];
}

export function validateRootConfig(value: unknown, file: RepoPath): RootValidation {
  const bag = new DiagnosticBag();
  const ctx: Ctx = { bag, file, unknownKeyCode: 'V012_ROOT_UNKNOWN_KEY', component: undefined };

  if (typeof value === 'function') {
    bad(
      ctx,
      'V017_ROOT_NOT_OBJECT',
      'default',
      `the root config must be an object, not a factory`,
      `export default { version: 1, ... }`,
      [
        `a factory would need baseSha, which is resolved FROM this file's baseRef`,
        `manifests may be factories; the registry may not`,
      ],
    );
    return { config: null, entries: [], indexById: new Map(), diagnostics: bag.items };
  }
  if (!isPlainObject(value)) {
    bad(ctx, 'V017_ROOT_NOT_OBJECT', 'default', `the root config must be an object`, `export default { version: 1, ... }`, [
      `got ${typeName(value)}`,
    ]);
    return { config: null, entries: [], indexById: new Map(), diagnostics: bag.items };
  }

  unknownKeys(ctx, value, ROOT_KEYS, '');

  if (value['version'] !== 1) {
    bad(ctx, 'V013_ROOT_VERSION', 'version', `version must be 1`, `set version: 1`, [
      `got ${JSON.stringify(value['version'])}`,
    ]);
  }

  reqString(ctx, value, 'baseRef', '', `set baseRef: 'origin/main'`);

  validateReport(ctx, value['report']);
  validateFailOn(ctx, value['failOn']);
  validateSharedDefaults(ctx, value['defaults'], 'defaults');
  optInt(ctx, value, 'concurrency', '', 1, MAX_CONCURRENCY, 'V018_CONCURRENCY_RANGE');

  const { entries, indexById } = validateComponents(ctx, value['components']);

  return {
    config: Array.isArray(value['components']) ? (value as unknown as VibesRootConfig) : null,
    entries,
    indexById,
    diagnostics: bag.items,
  };
}

function validateReport(ctx: Ctx, v: unknown): void {
  if (!isPlainObject(v)) {
    bad(ctx, 'V0A3_FIELD_TYPE', 'report', `'report' is required and must be an object`, `add report: { out: '.vibes/report', formats: ['md'] }`, [
      `got ${typeName(v)}`,
    ]);
    return;
  }
  unknownKeys(ctx, v, REPORT_KEYS, 'report');
  const out = reqString(ctx, v, 'out', 'report', `set report.out to a repo-relative directory`);
  if (out !== null) {
    const problem = checkRelPath(out);
    if (problem) {
      bad(ctx, 'V015_REPORT_OUT_ESCAPES', 'report.out', `report.out ${problem.reason}`, `use a repo-relative path such as '.vibes/report'`, [
        problem.evidence,
      ]);
    }
  }
  const formats = v['formats'];
  if (!Array.isArray(formats) || formats.length === 0) {
    bad(ctx, 'V0A3_FIELD_TYPE', 'report.formats', `'formats' must be a non-empty array`, `set formats: ['md', 'html', 'json']`, [
      `got ${typeName(formats)}`,
    ]);
  } else {
    for (const [i, f] of formats.entries()) {
      if (!(REPORT_FORMATS as readonly unknown[]).includes(f)) {
        bad(ctx, 'V0A3_FIELD_TYPE', `report.formats[${i}]`, `unknown report format`, `use one of ${REPORT_FORMATS.join(', ')}`, [
          `got ${JSON.stringify(f)}`,
        ]);
      }
    }
  }
  optString(ctx, v, 'title', 'report');
  optInt(ctx, v, 'maxInlineDiffLines', 'report', 1, 100_000);
}

function validateFailOn(ctx: Ctx, v: unknown): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) {
    bad(ctx, 'V0A3_FIELD_TYPE', 'failOn', `'failOn' must be an object`, `use an object or remove it`, [`got ${typeName(v)}`]);
    return;
  }
  unknownKeys(ctx, v, FAIL_ON_KEYS, 'failOn');
  for (const key of FAIL_ON_KEYS) optBoolean(ctx, v, key, 'failOn');
}

interface ComponentsValidation {
  readonly entries: readonly ComponentEntry[];
  readonly indexById: ReadonlyMap<ComponentId, number>;
}

function validateComponents(ctx: Ctx, v: unknown): ComponentsValidation {
  if (!Array.isArray(v)) {
    bad(
      ctx,
      'V0A3_FIELD_TYPE',
      'components',
      `'components' is required and must be an array`,
      `list every component explicitly — there is no filesystem discovery`,
      [`got ${typeName(v)}`],
    );
    return { entries: [], indexById: new Map() };
  }
  if (v.length === 0) {
    bad(ctx, 'V0A3_FIELD_TYPE', 'components', `the registry is empty`, `add at least one component entry`, [
      `an empty registry measures nothing and reports clean`,
    ]);
    return { entries: [], indexById: new Map() };
  }

  const entries: ComponentEntry[] = [];
  const indexById = new Map<ComponentId, number>();
  const seen = new Map<ComponentId, number>();

  for (const [i, raw] of v.entries()) {
    const locator = `components[${i}]`;
    if (!isPlainObject(raw)) {
      bad(ctx, 'V0A3_FIELD_TYPE', locator, `component entry must be an object`, `use { id, root }`, [
        `got ${typeName(raw)}`,
      ]);
      continue;
    }
    unknownKeys(ctx, raw, COMPONENT_KEYS, locator);

    const id = raw['id'];
    let validId: ComponentId | null = null;
    if (typeof id !== 'string' || !COMPONENT_ID_RE.test(id)) {
      bad(
        ctx,
        'V020_ID_INVALID',
        `${locator}.id`,
        `id must match ${COMPONENT_ID_RE.source}`,
        `use a short lowercase id — it becomes a directory name and an HTML anchor`,
        [`got ${JSON.stringify(id)}`],
      );
    } else if (seen.has(id)) {
      bad(ctx, 'V021_ID_DUPLICATE', `${locator}.id`, `duplicate component id '${id}'`, `rename one of the two entries`, [
        `first declared at components[${String(seen.get(id))}]`,
      ]);
    } else {
      seen.set(id, i);
      validId = id;
    }

    const entryCtx: Ctx = { ...ctx, component: validId ?? undefined };

    const root = raw['root'];
    let validRoot: RepoPath | null = null;
    if (typeof root !== 'string') {
      bad(
        entryCtx,
        'V0A3_FIELD_TYPE',
        `${locator}.root`,
        `'root' is required`,
        `set root to a repo-relative directory, e.g. 'Software/Control'`,
        [`got ${typeName(root)}`],
      );
    } else if (normalizeRel(root) === '') {
      // Checked BEFORE the generic path check so `root: '.'` gets the specific
      // diagnostic: a component rooted at the repo root claims every file in
      // the repo, which makes every other component's claim meaningless.
      bad(
        entryCtx,
        'V025_ROOT_IS_REPO_ROOT',
        `${locator}.root`,
        `root may not be the repo root`,
        `point root at the component directory`,
        [`a component rooted at the repo root claims every file in it`],
      );
    } else {
      const problem = checkRelPath(root);
      if (problem) {
        bad(entryCtx, 'V0A1_PATH_NOT_POSIX', `${locator}.root`, `root ${problem.reason}`, `use a repo-relative POSIX path`, [
          problem.evidence,
        ]);
      } else {
        validRoot = normalizeRel(root);
      }
    }

    optString(entryCtx, raw, 'title', locator);

    const enabled = optBoolean(entryCtx, raw, 'enabled', locator);
    if (enabled === false) {
      // Suppression must decay. Both fields are required so a disabled
      // component always carries a reason a reader can weigh and a date after
      // which the suppression itself becomes the finding.
      const reason = raw['disabledReason'];
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        bad(
          entryCtx,
          'V026_DISABLED_REASON_REQUIRED',
          `${locator}.disabledReason`,
          `a disabled component needs a disabledReason`,
          `add disabledReason: '<why this component is not measured>'`,
          [`the reason is rendered verbatim in every report`],
        );
      }
      const until = raw['disabledUntil'];
      if (typeof until !== 'string' || !isIsoDate(until)) {
        bad(
          entryCtx,
          'V026_DISABLED_REASON_REQUIRED',
          `${locator}.disabledUntil`,
          `a disabled component needs a disabledUntil date`,
          `add disabledUntil: 'YYYY-MM-DD' — suppression expires, it does not accumulate`,
          [`got ${JSON.stringify(until)}`],
        );
      }
    } else {
      for (const key of ['disabledReason', 'disabledUntil'] as const) {
        if (raw[key] !== undefined) {
          warn(
            entryCtx,
            'V0A3_FIELD_TYPE',
            at(locator, key),
            `'${key}' has no effect while the component is enabled`,
            `remove '${key}', or set enabled: false`,
          );
        }
      }
    }

    const dependsOn = optStringArray(entryCtx, raw, 'dependsOn', locator);
    for (const [j, dep] of dependsOn.entries()) {
      if (!COMPONENT_ID_RE.test(dep)) {
        bad(
          entryCtx,
          'V028_DEPENDSON_UNKNOWN',
          `${locator}.dependsOn[${j}]`,
          `'${dep}' is not a valid component id`,
          `name a component id declared in this registry`,
          [`ids match ${COMPONENT_ID_RE.source}`],
        );
      }
    }

    const generates = optStringArray(entryCtx, raw, 'generates', locator);
    checkGlobList(entryCtx, generates, `${locator}.generates`, 'write one glob per output tree, without braces');

    const submodules = optStringArray(entryCtx, raw, 'submodules', locator);
    for (const [j, s] of submodules.entries()) {
      const problem = checkRelPath(s);
      if (problem) {
        bad(entryCtx, 'V0A1_PATH_NOT_POSIX', `${locator}.submodules[${j}]`, `submodule path ${problem.reason}`, `use the repo-relative gitlink path, e.g. 'SIL/embsim'`, [
          problem.evidence,
        ]);
      }
    }

    if (validId !== null && validRoot !== null) {
      entries.push(raw as unknown as ComponentEntry);
      indexById.set(validId, i);
    }
  }

  return { entries, indexById };
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
}

/* ═══════════════════════════ MANIFEST ═════════════════════════════════ */

export interface ManifestValidation {
  readonly manifest: VibesManifest | null;
  readonly producers: readonly Producer[];
  readonly diagnostics: readonly Diagnostic[];
}

export function validateManifest(value: unknown, file: RepoPath, entry: ComponentEntry): ManifestValidation {
  const bag = new DiagnosticBag();
  const ctx: Ctx = { bag, file, component: entry.id, unknownKeyCode: 'V036_MANIFEST_UNKNOWN_KEY' };

  if (!isPlainObject(value)) {
    bad(
      ctx,
      'V039_MANIFEST_NOT_OBJECT',
      'default',
      `the manifest must export an object or a factory returning one`,
      `export default { component: '${entry.id}', producers: [] }`,
      [`got ${typeName(value)}`],
    );
    return { manifest: null, producers: [], diagnostics: bag.items };
  }

  unknownKeys(ctx, value, MANIFEST_KEYS, '');

  const component = value['component'];
  if (typeof component !== 'string') {
    bad(
      ctx,
      'V0A3_FIELD_TYPE',
      'component',
      `'component' is required`,
      `set component: '${entry.id}' to cross-check against the registry`,
      [`got ${typeName(component)}`],
    );
  } else if (component !== entry.id) {
    // Not an independent declaration of identity — a cross-check that this
    // manifest was not copy-pasted from a sibling component.
    bad(
      ctx,
      'V038_COMPONENT_MISMATCH',
      'component',
      `manifest says '${component}' but the registry says '${entry.id}'`,
      `set component: '${entry.id}'`,
      [`registry root: ${entry.root}`, `manifest file: ${file}`],
    );
  }

  const producers = validateProducers(ctx, value['producers']);
  const witnesses = optStringArray(ctx, value, 'witnesses', '');
  checkGlobList(ctx, witnesses, 'witnesses', 'write the glob relative to the component root, without braces');

  for (const [i, w] of witnesses.entries()) {
    const body = w.startsWith('!') ? w.slice(1) : w;
    const first = normalizeRel(body).split('/')[0];
    if (first === VIBES_DIRNAME) {
      // Inverted rule: <root>/vibes/** is an IMPLICIT, non-removable witness of
      // its own component. Declaring it is redundant, and opting out of it is
      // impossible — which is what stops a manifest from being the one file
      // that governs coverage while being structurally unwitnessable.
      bad(
        ctx,
        'V052_WITNESS_IN_VIBES_DIR',
        `witnesses[${i}]`,
        `'${VIBES_DIRNAME}/' is already an implicit witness`,
        `remove this witness — changes under ${VIBES_DIRNAME}/ always force this component to run`,
        [`declaring it would also let a snapshot witness itself`],
      );
    }
  }

  if (producers.length > 0 && witnesses.length === 0) {
    bad(
      ctx,
      'V050_WITNESSES_REQUIRED',
      'witnesses',
      `producers without witnesses cannot support an 'unchanged' verdict`,
      `add witnesses: ['src/**'] naming the source these snapshots claim to cover`,
      [`${producers.length} producer(s) declared`],
    );
  }

  validateIngest(ctx, value['ingest']);
  validateSharedDefaults(ctx, value['defaults'], 'defaults');

  return { manifest: value as unknown as VibesManifest, producers, diagnostics: bag.items };
}

function validateProducers(ctx: Ctx, v: unknown): readonly Producer[] {
  if (v === undefined || !Array.isArray(v)) {
    bad(
      ctx,
      'V0A3_FIELD_TYPE',
      'producers',
      `'producers' is required and must be an array`,
      `use producers: [] for an ingest-only component`,
      [`got ${typeName(v)}`],
    );
    return [];
  }

  const out: Producer[] = [];
  const seen = new Map<string, number>();

  for (const [i, raw] of v.entries()) {
    const locator = `producers[${i}]`;
    if (!isPlainObject(raw)) {
      bad(ctx, 'V0A3_FIELD_TYPE', locator, `producer must be an object`, `use { name, cmd, out }`, [
        `got ${typeName(raw)}`,
      ]);
      continue;
    }
    unknownKeys(ctx, raw, PRODUCER_KEYS, locator);

    const name = raw['name'];
    let validName: string | null = null;
    if (typeof name !== 'string' || !PRODUCER_NAME_RE.test(name)) {
      bad(
        ctx,
        'V040_NAME_INVALID',
        `${locator}.name`,
        `name must match ${PRODUCER_NAME_RE.source}`,
        `use a short lowercase name — it becomes a directory name`,
        [`got ${JSON.stringify(name)}`],
      );
    } else if (seen.has(name)) {
      bad(ctx, 'V041_NAME_DUPLICATE', `${locator}.name`, `duplicate producer name '${name}'`, `rename one of the two producers`, [
        `first declared at producers[${String(seen.get(name))}]`,
      ]);
    } else {
      seen.set(name, i);
      validName = name;
    }

    const cmd = reqString(ctx, raw, 'cmd', locator, `set cmd to the shell command that writes into $VIBES_OUT`);
    if (cmd !== null && /(^|&&|;|\|)\s*cd\s/.test(cmd)) {
      // A `cd` invalidates every path resolved above it: `out`, `cwd` and the
      // escape scan are all computed against the declared cwd.
      bad(ctx, 'V042_CMD_HAS_CD', `${locator}.cmd`, `cmd must not change directory`, `use cwd instead of cd`, [
        `cmd: ${cmd}`,
      ]);
    }

    const outPath = reqString(ctx, raw, 'out', locator, `set out: 'snapshots/<name>' (relative to <root>/vibes/)`);
    if (outPath !== null) {
      const problem = checkRelPath(outPath);
      if (problem) {
        bad(ctx, 'V043_OUT_ESCAPES', `${locator}.out`, `out ${problem.reason}`, `use a path inside <root>/vibes/`, [
          problem.evidence,
        ]);
      }
    }

    const cwd = optString(ctx, raw, 'cwd', locator);
    if (cwd !== null && cwd !== '.') {
      const problem = checkRelPath(cwd, { allowDot: true });
      if (problem) {
        bad(ctx, 'V04F_CWD_ESCAPES_ROOT', `${locator}.cwd`, `cwd ${problem.reason}`, `use a path inside the component root`, [
          problem.evidence,
        ]);
      }
    }

    optString(ctx, raw, 'description', locator);
    checkEnv(ctx, raw, locator);
    optInt(ctx, raw, 'timeoutMs', locator, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, 'V049_TIMEOUT_RANGE');
    if (raw['compare'] !== undefined) validateCompareSpec(ctx, raw['compare'], `${locator}.compare`);
    optString(ctx, raw, 'renderer', locator);
    optStringArray(ctx, raw, 'resources', locator);
    optInt(ctx, raw, 'minCases', locator, 0, 1_000_000);
    validateRunWhen(ctx, raw['runWhen'], `${locator}.runWhen`);
    optBoolean(ctx, raw, 'clean', locator);

    const tier = raw['tier'];
    if (tier !== undefined && !(TIER_VALUES as readonly unknown[]).includes(tier)) {
      bad(ctx, 'V0A3_FIELD_TYPE', `${locator}.tier`, `tier must be one of ${TIER_VALUES.join(' | ')}`, `set tier to pr, nightly or manual`, [
        `got ${JSON.stringify(tier)}`,
      ]);
    }

    const ciJob = optString(ctx, raw, 'ciJob', locator);
    if (ciJob === null && raw['ciJob'] === undefined) {
      // Warn, not error: a producer with no CI home still produces a report.
      // But its snapshots can only ever render `locally-accepted, never
      // CI-verified`, and that must be a stated fact rather than a silence.
      warn(
        ctx,
        'V04G_CIJOB_MISSING',
        `${locator}.ciJob`,
        `no ciJob — snapshots will render 'never CI-verified'`,
        `add ciJob: '<workflow job name>' once this producer runs in CI`,
        [`trust is derived from execution, and nothing here has executed in CI`],
      );
    }

    if (validName !== null && cmd !== null && outPath !== null) {
      out.push(raw as unknown as Producer);
    }
  }

  return out;
}

function validateIngest(ctx: Ctx, v: unknown): IngestSpec | null {
  if (v === undefined) return null;
  if (!isPlainObject(v)) {
    bad(ctx, 'V0A3_FIELD_TYPE', 'ingest', `'ingest' must be an object`, `use an object or remove it`, [
      `got ${typeName(v)}`,
    ]);
    return null;
  }
  unknownKeys(ctx, v, INGEST_KEYS, 'ingest');
  optString(ctx, v, 'cmd', 'ingest');
  const cwd = optString(ctx, v, 'cwd', 'ingest');
  if (cwd !== null && cwd !== '.') {
    const problem = checkRelPath(cwd, { allowDot: true });
    if (problem) {
      bad(ctx, 'V060_INGEST_ESCAPES_ROOT', 'ingest.cwd', `cwd ${problem.reason}`, `use a path inside the component root`, [
        problem.evidence,
      ]);
    }
  }
  optInt(ctx, v, 'timeoutMs', 'ingest', TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, 'V049_TIMEOUT_RANGE');
  checkEnv(ctx, v, 'ingest');
  optBoolean(ctx, v, 'required', 'ingest');

  for (const key of ['junit', 'vitestJson', 'pioJson'] as const) {
    const globs = coerceGlobList(ctx, v[key], `ingest.${key}`);
    checkGlobList(ctx, globs, `ingest.${key}`, 'write the artifact path relative to the component root');
  }

  const lcov = v['lcov'];
  if (lcov !== undefined) {
    if (Array.isArray(lcov) && lcov.every((x) => isPlainObject(x))) {
      for (const [i, item] of lcov.entries()) {
        const l = `ingest.lcov[${i}]`;
        const o = item as Obj;
        unknownKeys(ctx, o, ['path', 'sourceRoot'], l);
        const p = reqString(ctx, o, 'path', l, `set path to the lcov file, relative to the component root`);
        if (p !== null) checkGlobList(ctx, [p], `${l}.path`, 'write the lcov path without braces');
        const sr = optString(ctx, o, 'sourceRoot', l);
        if (sr !== null && sr !== '.') {
          const problem = checkRelPath(sr, { allowDot: true });
          if (problem) {
            bad(ctx, 'V060_INGEST_ESCAPES_ROOT', `${l}.sourceRoot`, `sourceRoot ${problem.reason}`, `anchor SF: records inside the component root`, [
              problem.evidence,
            ]);
          }
        }
      }
    } else {
      const globs = coerceGlobList(ctx, lcov, 'ingest.lcov');
      checkGlobList(ctx, globs, 'ingest.lcov', 'write the lcov path relative to the component root');
    }
  }

  return v as unknown as IngestSpec;
}

/** `junit: 'a.xml'` and `junit: ['a.xml','b.xml']` are both legal. */
export function coerceGlobList(ctx: Ctx, v: unknown, locator: string): readonly string[] {
  if (v === undefined) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const [i, item] of v.entries()) {
      if (typeof item === 'string') out.push(item);
      else {
        bad(ctx, 'V0A3_FIELD_TYPE', `${locator}[${i}]`, `entry must be a string glob`, `remove the entry or replace it with a string`, [
          `got ${typeName(item)}`,
        ]);
      }
    }
    return out;
  }
  bad(ctx, 'V0A3_FIELD_TYPE', locator, `must be a glob string or an array of them`, `use a string or an array of strings`, [
    `got ${typeName(v)}`,
  ]);
  return [];
}

/** Exposed so resolve.ts can reuse the same context shape. */
export type ValidationCtx = Ctx;
export { isPlainObject };
