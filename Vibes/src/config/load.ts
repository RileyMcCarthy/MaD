/**
 * Loading the two config files.
 *
 * `.mjs` IS MANDATORY, and the error message must explain why or nobody will
 * believe it: this repo has no package.json at the root, in `Firmware/`, in
 * `Protocol/`, in `Hardware/` or in `SIL/` — only `Software/Control/` sets
 * `"type": "module"`. So a `.js` config in four of those five places is loaded
 * as CommonJS and `export default` is a SyntaxError. It is not a style
 * preference; it is the difference between a config that loads and one that
 * throws on the CI runner while the author's laptop stays quiet.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  ComponentEntry,
  ComponentId,
  ManifestContext,
  Producer,
  Sha,
  VibesManifest,
  VibesRootConfig,
} from '../types.js';
import {
  MANIFEST_BASENAME,
  REJECTED_CONFIG_EXTENSIONS,
  ROOT_CONFIG_PATH,
  VIBES_DIRNAME,
} from './constants.js';
import type { Diagnostic, DiagnosticCode, DiagnosticSpan } from './diagnostics.js';
import { DiagnosticBag } from './diagnostics.js';
import { repoRelative, toPosix } from './paths.js';
import { validateManifest, validateRootConfig } from './validate.js';

/** The one sentence every `.mjs` diagnostic carries. */
export const MJS_REASON =
  'the repo root has no package.json, so a .js config loads as CommonJS and `export default` is a SyntaxError';

/* ────────────────────────── module loading ───────────────────────────── */

export interface LoadedModule {
  /** `mod.default`, un-called. `null` when the module could not be loaded. */
  readonly value: unknown;
  readonly loaded: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

interface ImportOptions {
  readonly absPath: string;
  readonly file: string;
  readonly component?: string | undefined;
  readonly missingCode: DiagnosticCode;
  readonly wrongExtCode: DiagnosticCode;
  readonly required: boolean;
}

async function importDefault(opts: ImportOptions): Promise<LoadedModule> {
  const bag = new DiagnosticBag();
  const { absPath, file } = opts;

  if (!existsSync(absPath)) {
    const sibling = findRejectedSibling(absPath);
    if (sibling !== null) {
      bag.add({
        code: opts.wrongExtCode,
        severity: 'error',
        // Report against the file that EXISTS, keeping it repo-relative: the
        // author is looking at `vibes.config.js`, not at the .mjs they never wrote.
        file: file.replace(/\.mjs$/, extensionOf(sibling.abs)),
        message: `config must be ${basenameOf(absPath)}, not ${basenameOf(sibling.abs)}`,
        fix: `rename ${basenameOf(sibling.abs)} to ${basenameOf(absPath)}`,
        evidence: [MJS_REASON, describeNearestPackageJson(dirname(absPath))],
        ...(opts.component !== undefined ? { component: opts.component } : {}),
      });
      return { value: null, loaded: false, diagnostics: bag.items };
    }
    if (opts.required) {
      bag.add({
        code: opts.missingCode,
        severity: 'error',
        file,
        message: `no ${basenameOf(absPath)} at this path`,
        fix: `create ${file}`,
        evidence: [`the path is derived from the registry and is never searched for`],
        ...(opts.component !== undefined ? { component: opts.component } : {}),
      });
    }
    return { value: null, loaded: false, diagnostics: bag.items };
  }

  let mod: Record<string, unknown>;
  try {
    // The mtime query busts the ESM module cache. Without it, watch mode and
    // any process that loads two revisions of a manifest (governance diffing
    // against a checkout) silently gets the first one back.
    const href = `${pathToFileURL(absPath).href}?v=${String(statSync(absPath).mtimeMs)}`;
    mod = (await import(href)) as Record<string, unknown>;
  } catch (err) {
    bag.addAll(classifyImportError(err, opts));
    return { value: null, loaded: false, diagnostics: bag.items };
  }

  if (!('default' in mod)) {
    bag.add({
      code: 'V033_NO_DEFAULT_EXPORT',
      severity: 'error',
      file,
      message: `no default export`,
      fix: `add \`export default { … }\``,
      evidence: [`named exports found: ${Object.keys(mod).filter((k) => k !== 'default').join(', ') || 'none'}`],
      ...(opts.component !== undefined ? { component: opts.component } : {}),
    });
    return { value: null, loaded: false, diagnostics: bag.items };
  }

  return { value: mod['default'], loaded: true, diagnostics: bag.items };
}

/**
 * A raw `SyntaxError: Unexpected token 'export'` never surfaces on its own —
 * it is the single most misread error in this space. Name the file, the format
 * Node resolved it as, and the package.json that decided it.
 *
 * NOTE: V034's name says MANIFEST because that is the common case; it also
 * covers the root config throwing at import time.
 */
function classifyImportError(err: unknown, opts: ImportOptions): readonly Diagnostic[] {
  const bag = new DiagnosticBag();
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  // Two distinct shapes of the same mistake:
  //   ESM syntax in a file Node loaded as CJS  → SyntaxError "Unexpected token 'export'"
  //   CJS syntax in a file Node loaded as ESM  → ReferenceError "module is not defined"
  // Neither may surface raw; both are answered by naming the format Node chose
  // and the package.json that chose it.
  const esmInCjs =
    err instanceof SyntaxError && /\b(export|import|module\.exports|require)\b/.test(message);
  const cjsInEsm =
    err instanceof ReferenceError && /\b(module|exports|require|__dirname|__filename)\b/.test(message);

  if (esmInCjs || cjsInEsm) {
    bag.add({
      code: 'V032_MODULE_FORMAT',
      severity: 'error',
      file: opts.file,
      message: esmInCjs ? `node parsed this file as CommonJS` : `this file uses CommonJS syntax in an ES module`,
      fix: esmInCjs
        ? `use the .mjs extension — ${MJS_REASON}`
        : `use \`export default { … }\` — .mjs is always an ES module`,
      evidence: [message, describeNearestPackageJson(dirname(opts.absPath))],
      ...(opts.component !== undefined ? { component: opts.component } : {}),
    });
    return bag.items;
  }

  const span = spanFromStack(stack, opts.absPath);
  bag.add({
    code: 'V034_MANIFEST_THREW',
    severity: 'error',
    file: opts.file,
    message: `threw while loading`,
    fix: `make the config data-only — it is evaluated before anything runs`,
    evidence: [message, ...firstFrames(stack, 3)],
    ...(span !== null ? { span } : {}),
    ...(opts.component !== undefined ? { component: opts.component } : {}),
  });
  return bag.items;
}

function basenameOf(p: string): string {
  return toPosix(p).split('/').pop() ?? p;
}

function findRejectedSibling(absPath: string): { abs: string } | null {
  const base = absPath.replace(/\.mjs$/, '');
  for (const ext of REJECTED_CONFIG_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return { abs: candidate };
  }
  return null;
}

function extensionOf(p: string): string {
  const base = basenameOf(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

/** Walk up from `dir` naming the package.json that decides this file's format. */
export function describeNearestPackageJson(dir: string): string {
  let cur = dir;
  for (;;) {
    const p = join(cur, 'package.json');
    if (existsSync(p)) {
      let type = 'commonjs (no "type" field)';
      try {
        const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null) {
          const t = (parsed as Record<string, unknown>)['type'];
          if (typeof t === 'string') type = t;
        }
      } catch {
        type = 'unparseable';
      }
      return `nearest package.json: ${toPosix(p)} ("type": ${type})`;
    }
    const parent = dirname(cur);
    if (parent === cur) return `no package.json between ${toPosix(dir)} and the filesystem root`;
    cur = parent;
  }
}

function spanFromStack(stack: string, absPath: string): DiagnosticSpan | null {
  const href = pathToFileURL(absPath).href;
  for (const line of stack.split('\n')) {
    if (!line.includes(href) && !line.includes(absPath)) continue;
    const m = /:(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const l = Number(m[1]);
    const c = Number(m[2]);
    if (Number.isFinite(l) && Number.isFinite(c)) return { line: l, column: c };
  }
  return null;
}

function firstFrames(stack: string, n: number): readonly string[] {
  return stack
    .split('\n')
    .filter((l) => l.trim().startsWith('at '))
    .slice(0, n)
    .map((l) => l.trim());
}

/* ─────────────────────────── root config ─────────────────────────────── */

export interface RootLoad {
  readonly file: string;
  readonly absPath: string;
  readonly config: VibesRootConfig | null;
  readonly entries: readonly ComponentEntry[];
  /** id → index in the AUTHORED components array, for accurate locators. */
  readonly indexById: ReadonlyMap<ComponentId, number>;
  readonly diagnostics: readonly Diagnostic[];
}

export async function loadRootConfig(repoRoot: string): Promise<RootLoad> {
  const absPath = resolve(repoRoot, ROOT_CONFIG_PATH);
  const file = ROOT_CONFIG_PATH;
  const loaded = await importDefault({
    absPath,
    file,
    missingCode: 'V010_ROOT_MISSING',
    wrongExtCode: 'V011_ROOT_NOT_MJS',
    required: true,
    component: undefined,
  });
  if (!loaded.loaded) {
    return { file, absPath, config: null, entries: [], indexById: new Map(), diagnostics: loaded.diagnostics };
  }
  const validated = validateRootConfig(loaded.value, file);
  return {
    file,
    absPath,
    config: validated.config,
    entries: validated.entries,
    indexById: validated.indexById,
    diagnostics: [...loaded.diagnostics, ...validated.diagnostics],
  };
}

/* ──────────────────────────── manifest ───────────────────────────────── */

export interface ManifestLoadRequest {
  readonly repoRoot: string;
  readonly entry: ComponentEntry;
  readonly absRoot: string;
  readonly baseRef: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
  /** False for a disabled component: a suppressed component may have no
   *  manifest at all, and demanding one would force authors to write a stub
   *  just to keep the registry honest. */
  readonly required: boolean;
}

export interface ManifestLoad {
  readonly file: string;
  readonly absPath: string;
  readonly absVibesDir: string;
  readonly manifest: VibesManifest | null;
  readonly producers: readonly Producer[];
  readonly exists: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export async function loadManifest(req: ManifestLoadRequest): Promise<ManifestLoad> {
  const absVibesDir = join(req.absRoot, VIBES_DIRNAME);
  const absPath = join(absVibesDir, MANIFEST_BASENAME);
  const file = repoRelative(req.repoRoot, absPath);
  const exists = existsSync(absPath);

  const loaded = await importDefault({
    absPath,
    file,
    component: req.entry.id,
    missingCode: 'V030_MANIFEST_MISSING',
    wrongExtCode: 'V031_MANIFEST_NOT_MJS',
    required: req.required,
  });

  if (!loaded.loaded) {
    return {
      file,
      absPath,
      absVibesDir,
      manifest: null,
      producers: [],
      exists,
      diagnostics: loaded.diagnostics,
    };
  }

  const bag = new DiagnosticBag();
  bag.addAll(loaded.diagnostics);

  let value = loaded.value;
  if (typeof value === 'function') {
    const ctx: ManifestContext = {
      repoRoot: req.repoRoot,
      root: req.absRoot,
      vibesDir: absVibesDir,
      component: req.entry.id,
      baseRef: req.baseRef,
      baseSha: req.baseSha,
      headSha: req.headSha,
    };
    try {
      value = await (value as (c: ManifestContext) => unknown)(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? (err.stack ?? '') : '';
      const span = spanFromStack(stack, absPath);
      bag.add({
        code: 'V034_MANIFEST_THREW',
        severity: 'error',
        file,
        component: req.entry.id,
        message: `the manifest factory threw`,
        fix: `make the factory data-only — it runs before any producer`,
        evidence: [message, ...firstFrames(stack, 3)],
        ...(span !== null ? { span } : {}),
      });
      return { file, absPath, absVibesDir, manifest: null, producers: [], exists, diagnostics: bag.items };
    }
  }

  const validated = validateManifest(value, file, req.entry);
  bag.addAll(validated.diagnostics);
  return {
    file,
    absPath,
    absVibesDir,
    manifest: validated.manifest,
    producers: validated.producers,
    exists,
    diagnostics: bag.items,
  };
}
