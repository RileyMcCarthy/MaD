/**
 * The producer environment.
 *
 * Four ordered layers, then a non-overridable injection:
 *
 *   inherit → strip denylist → determinism floor → manifest env → producer env
 *   → VIBES_* (cannot be shadowed)
 *
 * WHY the injection is last and unconditional: `VIBES_OUT_DIR` is the entire
 * write contract. A producer that could point it at the committed baseline
 * would reintroduce in-place writes, which is the one decision the whole design
 * rests on.
 *
 * WHY `CI` is never touched: setting it flips vitest/insta/jest into
 * never-write-snapshots mode and changes what producers emit; unsetting it
 * changes what a project's own scripts do. Either way Vibes would be modifying
 * the behaviour it claims to be observing.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  ENV_DENY_EXACT,
  ENV_DENY_PREFIX,
  ENV_DETERMINISM,
  INJECTED_ENV_KEYS,
} from './constants.js';

export type EnvLayer = Readonly<Record<string, string | null>> | undefined;

export interface ProducerEnvContext {
  readonly repoRoot: string;
  /** Component root — `<root>/node_modules/.bin` is prepended to PATH from here. */
  readonly absRoot: string;
  /** `<root>/vibes` — the manifest's own directory. */
  readonly absVibesDir: string;
  readonly component: string;
  readonly producer: string;
  /** Absolute path to the GITIGNORED received dir. Becomes `$VIBES_OUT_DIR`. */
  readonly receivedDir: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly runId: string;
  readonly vibesVersion: string;
  /** Seconds. Callers should pass the HEAD commit time so a producer that
   *  stamps a date emits the same bytes on every re-run of the same commit. */
  readonly sourceDateEpoch: number;
}

function denied(key: string): boolean {
  if (ENV_DENY_EXACT.includes(key)) return true;
  return ENV_DENY_PREFIX.some((p) => key.startsWith(p));
}

/**
 * PATH gets EXACTLY TWO prepends, each only if it exists.
 *
 * No ancestor walk. npm's own rule climbs to `<repoRoot>/node_modules/.bin`,
 * then `$HOME/node_modules/.bin`, then `/node_modules/.bin` — outside the repo
 * entirely. A producer that resolves a binary from outside its own component
 * is not reproducible on a CI runner.
 */
export function producerPath(ctx: ProducerEnvContext, inherited: string | undefined): string {
  const prepends = [join(ctx.absRoot, 'node_modules', '.bin'), join(ctx.absVibesDir, 'node_modules', '.bin')].filter(
    (p) => existsSync(p),
  );
  const rest = inherited === undefined || inherited === '' ? [] : [inherited];
  return [...prepends, ...rest].join(delimiter);
}

export function injectedEnv(ctx: ProducerEnvContext): Readonly<Record<string, string>> {
  return {
    // Doubles as the recursion guard: preflight refuses to start when it is
    // already set, so a producer cannot invoke `vibes run` inside itself.
    VIBES: '1',
    VIBES_VERSION: ctx.vibesVersion,
    VIBES_RUN_ID: ctx.runId,
    VIBES_REPO_ROOT: ctx.repoRoot,
    VIBES_MANIFEST_DIR: ctx.absVibesDir,
    VIBES_COMPONENT: ctx.component,
    VIBES_PRODUCER: ctx.producer,
    VIBES_OUT_DIR: ctx.receivedDir,
    VIBES_BASE_SHA: ctx.baseSha,
    VIBES_HEAD_SHA: ctx.headSha,
    SOURCE_DATE_EPOCH: String(ctx.sourceDateEpoch),
  };
}

export interface BuildEnvResult {
  readonly env: Record<string, string>;
  /** Keys a layer tried to set that the injection overrode. Reported, not
   *  silently applied — an author who wrote `VIBES_OUT_DIR` deserves to know
   *  it was ignored rather than to debug why nothing landed. */
  readonly overridden: readonly string[];
  /** Keys removed by the denylist, for the run log. */
  readonly stripped: readonly string[];
}

export function buildProducerEnv(
  ctx: ProducerEnvContext,
  layers: readonly EnvLayer[],
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): BuildEnvResult {
  const env: Record<string, string> = {};
  const stripped: string[] = [];

  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (denied(k)) {
      stripped.push(k);
      continue;
    }
    env[k] = v;
  }

  for (const [k, v] of Object.entries(ENV_DETERMINISM)) env[k] = v;

  const overridden: string[] = [];
  for (const layer of layers) {
    if (layer === undefined) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (INJECTED_ENV_KEYS.includes(k)) {
        overridden.push(k);
        continue;
      }
      // `null` means UNSET in the child, not "empty string". An empty string is
      // a value most tools treat as configured-but-blank.
      if (v === null) delete env[k];
      else env[k] = v;
    }
  }

  const inheritedPath = env['PATH'] ?? env['Path'];
  env['PATH'] = producerPath(ctx, inheritedPath);
  // Windows resolves PATH case-insensitively but Node exposes both spellings;
  // leaving a stale `Path` behind would shadow the prepends we just computed.
  if ('Path' in env && env['Path'] !== env['PATH']) delete env['Path'];

  for (const [k, v] of Object.entries(injectedEnv(ctx))) env[k] = v;

  return { env, overridden: [...new Set(overridden)].sort(), stripped: stripped.sort() };
}

/**
 * Which variables Vibes itself set or changed, relative to `baseEnv`.
 *
 * Reported instead of the full environment: a producer's inherited env carries
 * tokens, and a report is an artifact that gets uploaded.
 */
export function envDiff(
  built: Readonly<Record<string, string>>,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const diff: Record<string, string> = {};
  for (const [k, v] of Object.entries(built)) {
    if (baseEnv[k] !== v) diff[k] = v;
  }
  return diff;
}
