/**
 * The renderer registry: path glob → renderer module.
 *
 * Two rules, and both of them exist because the obvious implementation is
 * wrong:
 *
 * 1. NEGATION IS RESOLVED HERE, NOT BY PICOMATCH. `picomatch('!**\/gen/**')`
 *    returns a matcher that is TRUE for every path the pattern does NOT match —
 *    so handing a list containing a negation straight to picomatch silently
 *    inverts the answer for every unrelated file. Vibes strips the `!` itself,
 *    compiles the positive body, and treats a match as a NEGATIVE VOTE.
 *
 * 2. MOST-SPECIFIC WINS, DECLARATION ORDER ONLY BREAKS TIES. Specificity is the
 *    count of literal (glob-free) segments from `picomatch.scan(..., {parts})`.
 *    Pure last-match-wins would mean a broad `**\/*` written at the bottom of a
 *    manifest quietly captures every file — the failure mode is invisible
 *    because the report still renders, just uselessly.
 *
 * A negative binding participates in exactly the same ordering. If the winning
 * vote is negative, the path has no bound renderer and resolution falls through
 * to the next stage. That single rule explains both "exclude a subtree" and
 * "re-include a file inside it" without a second mechanism.
 */

import picomatch from 'picomatch';
import type {
  ComponentId,
  Glob,
  ProducerName,
  RendererId,
  RepoPath,
  SnapState,
  Verdict,
} from '../types.js';
import type { RenderBlock } from './blocks.js';

/* ─────────────────────────── renderer contract ───────────────────────── */

export interface SnapshotFileRef {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  /** Path relative to the producer's out dir, POSIX separators. */
  readonly file: string;
  /**
   * Repo-relative path of the COMMITTED baseline file. This is the path glob
   * bindings match against — one path universe, so a manifest author can read a
   * binding and a report row and see the same string.
   */
  readonly repoPath: RepoPath;
  readonly state: SnapState;
  readonly verdict: Verdict;
  readonly bytes: number;
}

export interface RenderInput {
  readonly ref: SnapshotFileRef;
  /** Bytes at the base commit. Null for an added file. */
  readonly baseline: Buffer | null;
  /** Bytes the producer just wrote. Null for a deleted file. */
  readonly received: Buffer | null;
}

export interface RenderContext {
  /** Every byte/line/block ceiling. No renderer may invent its own. */
  readonly limits: RenderLimits;
  /** Anything a renderer chose not to show. Surfaces in the report, not stderr. */
  readonly log: (note: string) => void;
}

export interface RenderLimits {
  readonly maxPatchLines: number;
  readonly maxBlocksPerFile: number;
  readonly maxBytesPerFile: number;
  readonly rendererTimeoutMs: number;
  readonly seriesBuckets: number;
  readonly editLengthCeiling: number;
  readonly diffContext: number;
}

export interface RendererModule {
  readonly name?: string;
  /** Veto. Returning false falls through to the next candidate, ending at text. */
  canRender?(input: RenderInput): boolean;
  render(input: RenderInput, ctx: RenderContext): RenderBlock[] | Promise<RenderBlock[]>;
}

/* ───────────────────────────── glob bindings ─────────────────────────── */

export interface RendererBinding {
  /** picomatch syntax. A leading `!` makes it an exclusion. Braces rejected. */
  readonly pattern: Glob;
  readonly renderer: RendererId;
  /** Where this came from, e.g. 'control manifest'. Used in shadow reports. */
  readonly source?: string;
  /**
   * Repo-relative prefix this binding is allowed to match under (the component
   * root). A binding reaching outside it is a config error — one component
   * must not be able to hijack another's rendering.
   */
  readonly scope?: RepoPath;
}

interface CompiledBinding {
  readonly binding: RendererBinding;
  readonly index: number;
  readonly negated: boolean;
  readonly specificity: number;
  readonly segments: number;
  readonly isMatch: (p: string) => boolean;
}

const GLOB_META = /[*?[\]()!+@]/;

function literalSegmentCount(parts: readonly string[]): number {
  let n = 0;
  for (const p of parts) {
    if (p.length > 0 && !GLOB_META.test(p)) n += 1;
  }
  return n;
}

/**
 * Strip the negation prefix WITHOUT handing it to picomatch. See file header.
 *
 * `!(a|b)` is an extglob, not a negation — picomatch reads it that way, so we
 * must too, or `!(draft|tmp).txt` inverts the whole binding.
 */
function positiveBody(pattern: string): { body: string; negated: boolean } {
  if (pattern.startsWith('!') && !pattern.startsWith('!(')) {
    return { body: pattern.slice(1), negated: true };
  }
  return { body: pattern, negated: false };
}

export function compileBinding(binding: RendererBinding, index: number): CompiledBinding {
  const { body, negated } = positiveBody(binding.pattern);
  const scan = picomatch.scan(body, { parts: true });
  const parts = scan.parts ?? body.split('/');
  // `dot: true` because snapshot corpora legitimately contain dotfiles
  // (`.vibes-selected`, `.gitattributes`) and a binding that silently skips
  // them looks like a renderer bug, not a glob rule.
  const isMatch = picomatch(body, { dot: true });
  return {
    binding,
    index,
    negated,
    specificity: literalSegmentCount(parts),
    segments: parts.length,
    isMatch,
  };
}

export interface BindingResolution {
  readonly renderer: RendererId | null;
  readonly winner: RendererBinding | null;
  /** Bindings that matched but lost. Logged so a dead binding is visible. */
  readonly shadowed: readonly RendererBinding[];
  /** Set when the winning vote was an exclusion. */
  readonly excludedBy: RendererBinding | null;
}

export class BindingTable {
  private readonly compiled: readonly CompiledBinding[];

  constructor(bindings: readonly RendererBinding[]) {
    this.compiled = bindings.map(compileBinding);
  }

  resolve(path: RepoPath): BindingResolution {
    let best: CompiledBinding | null = null;
    const matched: CompiledBinding[] = [];
    for (const c of this.compiled) {
      if (!c.isMatch(path)) continue;
      matched.push(c);
      if (best === null || beats(c, best)) best = c;
    }
    if (best === null) {
      return { renderer: null, winner: null, shadowed: [], excludedBy: null };
    }
    const shadowed = matched.filter((m) => m !== best).map((m) => m.binding);
    if (best.negated) {
      return { renderer: null, winner: null, shadowed, excludedBy: best.binding };
    }
    return { renderer: best.binding.renderer, winner: best.binding, shadowed, excludedBy: null };
  }
}

function beats(candidate: CompiledBinding, incumbent: CompiledBinding): boolean {
  if (candidate.specificity !== incumbent.specificity) {
    return candidate.specificity > incumbent.specificity;
  }
  if (candidate.segments !== incumbent.segments) {
    return candidate.segments > incumbent.segments;
  }
  // Ties go to the last declared binding — the only place declaration order
  // is allowed to matter.
  return candidate.index > incumbent.index;
}

/* ───────────────────────────── validation ────────────────────────────── */

export interface BindingError {
  readonly pattern: Glob;
  readonly message: string;
}

/**
 * Reject at config time what would otherwise be a silent no-op at run time.
 *
 * Braces are rejected because `git ls-files -- '**\/x.{ts,tsx}'` matches
 * nothing at all — a pattern that works in picomatch and fails in git is the
 * worst kind of half-working.
 */
export function validateBindings(
  bindings: readonly RendererBinding[],
  knownRenderers: ReadonlySet<RendererId>,
): BindingError[] {
  const errors: BindingError[] = [];
  for (const b of bindings) {
    const { body } = positiveBody(b.pattern);
    if (body.trim().length === 0) {
      errors.push({ pattern: b.pattern, message: 'empty glob' });
      continue;
    }
    if (body.includes('{') || body.includes('}')) {
      errors.push({
        pattern: b.pattern,
        message: 'brace expansion is rejected: it matches nothing under `git ls-files`',
      });
    }
    if (!knownRenderers.has(b.renderer)) {
      errors.push({ pattern: b.pattern, message: `unknown renderer id "${b.renderer}"` });
    }
    if (b.scope !== undefined) {
      const scan = picomatch.scan(body, { parts: true });
      const base = scan.base;
      const scope = b.scope.replace(/\/+$/, '');
      if (!base.startsWith(scope)) {
        errors.push({
          pattern: b.pattern,
          message: `binding may only match paths under "${scope}"; its literal base is "${base || '<repo root>'}"`,
        });
      }
    }
  }
  return errors;
}

/* ──────────────────────────── the registry ───────────────────────────── */

export const DEFAULT_RENDERER_ID = 'text';

export interface ResolvedRenderer {
  readonly id: RendererId;
  readonly module: RendererModule;
  /** How the renderer was chosen — printed beside the diff in the report. */
  readonly via: 'glob' | 'producer' | 'format' | 'default' | 'fallback';
  readonly shadowed: readonly RendererBinding[];
}

export interface RegistryOptions {
  readonly bindings?: readonly RendererBinding[];
  /** Producer-level `renderer` field, keyed `component/producer`. */
  readonly producerRenderers?: ReadonlyMap<string, RendererId>;
  /** Chooses a builtin from file shape when nothing was declared. */
  readonly sniff?: (input: RenderInput) => RendererId | null;
}

export class RendererRegistry {
  private readonly modules = new Map<RendererId, RendererModule>();
  private readonly table: BindingTable;
  private readonly producerRenderers: ReadonlyMap<string, RendererId>;
  private readonly sniff: ((input: RenderInput) => RendererId | null) | null;

  constructor(
    modules: Readonly<Record<RendererId, RendererModule>>,
    options: RegistryOptions = {},
  ) {
    for (const [id, mod] of Object.entries(modules)) this.modules.set(id, mod);
    this.table = new BindingTable(options.bindings ?? []);
    this.producerRenderers = options.producerRenderers ?? new Map();
    this.sniff = options.sniff ?? null;
  }

  has(id: RendererId): boolean {
    return this.modules.has(id);
  }

  ids(): ReadonlySet<RendererId> {
    return new Set(this.modules.keys());
  }

  /**
   * Resolution chain: glob binding → producer field → format sniff → text.
   *
   * The glob map deliberately outranks the producer's own `renderer` field: a
   * per-path binding is a narrower statement than a whole-producer default, and
   * inverting the two makes it impossible to special-case one file.
   */
  resolve(input: RenderInput): ResolvedRenderer {
    const bound = this.table.resolve(input.ref.repoPath);
    const candidates: { id: RendererId; via: ResolvedRenderer['via'] }[] = [];
    if (bound.renderer !== null) candidates.push({ id: bound.renderer, via: 'glob' });

    const producerKey = `${input.ref.component}/${input.ref.producer}`;
    const fromProducer = this.producerRenderers.get(producerKey);
    if (fromProducer !== undefined) candidates.push({ id: fromProducer, via: 'producer' });

    const sniffed = this.sniff?.(input) ?? null;
    if (sniffed !== null) candidates.push({ id: sniffed, via: 'format' });

    for (const c of candidates) {
      const mod = this.modules.get(c.id);
      if (mod === undefined) continue;
      if (mod.canRender && !mod.canRender(input)) continue;
      return { id: c.id, module: mod, via: c.via, shadowed: bound.shadowed };
    }

    const fallback = this.modules.get(DEFAULT_RENDERER_ID);
    if (fallback === undefined) {
      throw new Error(
        'renderer registry has no "text" renderer; the default is not optional',
      );
    }
    return {
      id: DEFAULT_RENDERER_ID,
      module: fallback,
      via: candidates.length > 0 ? 'fallback' : 'default',
      shadowed: bound.shadowed,
    };
  }
}
