/**
 * The precedence chain, and the ONE key that merges instead of replacing.
 *
 *   BUILTIN_DEFAULTS → root.defaults → manifest.defaults → the producer field
 *
 * `env` merges key-by-key at every step (a `null` value means "unset this
 * variable in the child", and it survives merging so the runner can act on it).
 * `compare`, `renderer`, `timeoutMs`, `runWhen` and `clean` REPLACE wholesale:
 * a half-merged CompareSpec — a root rule array with one manifest rule spliced
 * into it — is unreadable, and a reviewer could not predict which rule wins.
 *
 * SharedDefaults is the only key set legal at both levels. Anything else in
 * root.defaults or manifest.defaults is an unknown-key error, because a
 * `root`/`enabled`/`witnesses` field that inherited downward would be a scope
 * change nobody reviewed.
 */

import type { Producer, RunWhen, SharedDefaults } from '../types.js';
import type { EffectiveDefaults } from './constants.js';
import { BUILTIN_DEFAULTS } from './constants.js';

export type EnvMap = Readonly<Record<string, string | null>>;

/** Later keys win; `null` is a value (unset), not an absence. */
export function mergeEnv(...layers: readonly (EnvMap | undefined)[]): EnvMap {
  const out: Record<string, string | null> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of Object.keys(layer)) {
      const v = layer[key];
      if (v === undefined) continue;
      out[key] = v;
    }
  }
  return out;
}

/**
 * Fold any number of SharedDefaults layers onto a base. Order is
 * least-specific first. `undefined` layers are skipped, so a manifest with no
 * `defaults` block cannot accidentally reset the root's.
 */
export function mergeDefaults(
  layers: readonly (SharedDefaults | undefined)[],
  base: EffectiveDefaults = BUILTIN_DEFAULTS,
): EffectiveDefaults {
  let compare = base.compare;
  let renderer = base.renderer;
  let timeoutMs = base.timeoutMs;
  let runWhen = base.runWhen;
  let clean = base.clean;
  let env = base.env;

  for (const layer of layers) {
    if (!layer) continue;
    if (layer.compare !== undefined) compare = layer.compare;
    if (layer.renderer !== undefined) renderer = layer.renderer;
    if (layer.timeoutMs !== undefined) timeoutMs = layer.timeoutMs;
    if (layer.runWhen !== undefined) runWhen = layer.runWhen;
    if (layer.clean !== undefined) clean = layer.clean;
    if (layer.env !== undefined) env = mergeEnv(env, layer.env);
  }

  return { compare, renderer, timeoutMs, env, runWhen, clean };
}

/**
 * Apply a producer's own fields as the most specific layer. A Producer is a
 * superset of SharedDefaults for these six keys, so it folds through the same
 * path — which is what guarantees the producer really does win every time.
 */
export function applyProducer(defaults: EffectiveDefaults, p: Producer): EffectiveDefaults {
  const layer: SharedDefaults = {
    ...(p.compare !== undefined ? { compare: p.compare } : {}),
    ...(p.renderer !== undefined ? { renderer: p.renderer } : {}),
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
    ...(p.env !== undefined ? { env: p.env } : {}),
    ...(p.runWhen !== undefined ? { runWhen: p.runWhen } : {}),
    ...(p.clean !== undefined ? { clean: p.clean } : {}),
  };
  return mergeDefaults([layer], defaults);
}

/**
 * Vibes may FORCE `runWhen: 'always'` (a component consuming another's
 * generated artifacts, or a submodule pin bump). An author may raise their own
 * value to 'always' but may never lower it below what Vibes computed — the
 * whole point of forcing is that the author cannot see the hidden input.
 */
export function raiseRunWhen(authored: RunWhen, forced: boolean): RunWhen {
  return forced ? 'always' : authored;
}
