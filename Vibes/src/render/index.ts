/**
 * render/ — public surface.
 *
 * `renderSnapshot` is the only entry point the emitters use. It owns every
 * guard, so a project-authored renderer cannot take the run down with it: one
 * bad renderer degrades to a `renderer-error` note plus the default text diff,
 * and the report still ships.
 */

import type { RendererId } from '../types.js';
import type { RenderBlock } from './blocks.js';
import { capBlocks, estimateBytes, validateBlocks } from './blocks.js';
import { BUILTIN_RENDERERS, sniffRenderer } from './builtins/index.js';
import { renderTextDiff } from './builtins/text.js';
import type {
  RenderContext,
  RenderInput,
  RenderLimits,
  RendererModule,
  ResolvedRenderer,
  SnapshotFileRef,
} from './registry.js';
import { RendererRegistry } from './registry.js';

export * from './blocks.js';
export * from './registry.js';
export * from './textDiff.js';
export {
  BUILTIN_RENDERERS,
  sniffRenderer,
  canonicalJson,
  parseDelimited,
  columnStat,
  hexDump,
  firstDifferingOffset,
  sha256,
  textRenderer,
  jsonRenderer,
  seriesRenderer,
  binaryRenderer,
  renderTextDiff,
} from './builtins/index.js';

/**
 * The ONE definition of every render-side ceiling.
 *
 * §4.13: a single budget object is constructed once and threaded through. No
 * other module may declare its own default for these — conflicting constants in
 * four modules is how a "400 line cap" becomes 400 in one place and 4000 in the
 * one that actually runs.
 */
export const DEFAULT_RENDER_LIMITS: RenderLimits = Object.freeze({
  maxPatchLines: 400,
  maxBlocksPerFile: 200,
  maxBytesPerFile: 512_000,
  rendererTimeoutMs: 5_000,
  seriesBuckets: 120,
  editLengthCeiling: 50_000,
  diffContext: 3,
});

export interface RenderedSnapshot {
  readonly ref: SnapshotFileRef;
  readonly rendererId: RendererId;
  readonly via: ResolvedRenderer['via'];
  readonly blocks: readonly RenderBlock[];
  /** Everything the renderer or the guards chose not to show. */
  readonly notes: readonly string[];
  readonly errored: boolean;
}

export interface RenderSnapshotOptions {
  readonly registry?: RendererRegistry;
  readonly limits?: RenderLimits;
}

/** A registry with the builtins wired and the format sniffer attached. */
export function defaultRegistry(
  extra: Readonly<Record<RendererId, RendererModule>> = {},
): RendererRegistry {
  return new RendererRegistry({ ...BUILTIN_RENDERERS, ...extra }, { sniff: sniffRenderer });
}

export async function renderSnapshot(
  input: RenderInput,
  options: RenderSnapshotOptions = {},
): Promise<RenderedSnapshot> {
  const limits = options.limits ?? DEFAULT_RENDER_LIMITS;
  const registry = options.registry ?? defaultRegistry();
  const notes: string[] = [];
  const ctx: RenderContext = { limits, log: (n) => notes.push(n) };

  const resolved = registry.resolve(input);
  for (const s of resolved.shadowed) {
    notes.push(
      `renderer binding "${s.pattern}" → ${s.renderer} was shadowed by a more specific binding`,
    );
  }

  let raw: unknown;
  let errored = false;
  try {
    raw = await withTimeout(
      Promise.resolve(resolved.module.render(input, ctx)),
      limits.rendererTimeoutMs,
      `renderer "${resolved.id}"`,
    );
  } catch (err) {
    errored = true;
    notes.push(`renderer "${resolved.id}" failed: ${errorText(err)}`);
    raw = null;
  }

  const validated = validateBlocks(raw);
  for (const e of validated.errors) {
    notes.push(`renderer "${resolved.id}" emitted an invalid block: ${e}`);
  }

  // Fall back to the default renderer rather than emitting an empty section.
  // An empty section is indistinguishable from "nothing changed", which is the
  // one thing this tool must never accidentally say.
  const needsFallback = (errored || validated.blocks.length === 0) && resolved.id !== 'text';
  if (needsFallback) {
    const head: RenderBlock[] = errored
      ? [
          {
            kind: 'note',
            level: 'error',
            text: `The "${resolved.id}" renderer failed for this file; showing the default text diff instead.`,
          },
        ]
      : [];
    const fallback = validateBlocks(safeRender(() => renderTextDiff(input, ctx)));
    return finish(input, resolved, [...head, ...fallback.blocks], notes, limits, errored, 'fallback');
  }

  return finish(input, resolved, validated.blocks, notes, limits, errored, resolved.via);
}

function finish(
  input: RenderInput,
  resolved: ResolvedRenderer,
  blocks: readonly RenderBlock[],
  notes: string[],
  limits: RenderLimits,
  errored: boolean,
  via: ResolvedRenderer['via'],
): RenderedSnapshot {
  const capped = capBlocks(blocks, limits.maxBlocksPerFile);
  if (capped.dropped > 0) {
    notes.push(
      `${input.ref.file}: ${capped.dropped} blocks dropped (cap ${limits.maxBlocksPerFile})`,
    );
  }
  let final = capped.blocks;
  let bytes = estimateBytes(final);
  if (bytes > limits.maxBytesPerFile) {
    const trimmed: RenderBlock[] = [];
    let used = 0;
    for (const b of final) {
      const cost = estimateBytes([b]);
      if (used + cost > limits.maxBytesPerFile) break;
      trimmed.push(b);
      used += cost;
    }
    notes.push(
      `${input.ref.file}: rendering exceeded ${limits.maxBytesPerFile} bytes and was trimmed to ${trimmed.length} of ${final.length} blocks`,
    );
    trimmed.push({
      kind: 'note',
      level: 'warn',
      text: 'This file’s rendering hit the per-file byte budget and was cut short.',
    });
    final = trimmed;
    bytes = used;
  }
  return {
    ref: input.ref,
    rendererId: resolved.id,
    via,
    blocks: final,
    notes,
    errored,
  };
}

function safeRender(fn: () => RenderBlock[]): RenderBlock[] {
  try {
    return fn();
  } catch {
    return [
      {
        kind: 'note',
        level: 'error',
        text: 'The default renderer also failed for this file. Nothing could be rendered.',
      },
    ];
  }
}

/**
 * Wall-clock guard.
 *
 * HONEST LIMITATION, stated where someone will read it: this cannot interrupt a
 * synchronous infinite loop in a renderer — nothing in-process can. It bounds
 * the async case and turns a slow renderer into a note. A hostile renderer is
 * out of scope by design: renderers carry the same trust as a producer `cmd`.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
