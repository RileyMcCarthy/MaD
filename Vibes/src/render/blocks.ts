/**
 * Render blocks — the only thing a renderer is allowed to return.
 *
 * WHY structured blocks and never HTML strings: escaping and the byte budget
 * stay in the core. Renderers are project-authored code and will get both
 * wrong, and a block schema is the only way markdown and HTML stay
 * semantically identical instead of drifting into two hand-maintained
 * templates that slowly disagree about what the report says.
 *
 * There is deliberately NO `{ kind: 'html' }` member. It would be both a
 * markdown/HTML parity hole and the report's only injection surface.
 */

import { stripVTControlCharacters } from 'node:util';
import type { Severity } from '../types.js';

/* ───────────────────────────── patch model ───────────────────────────── */

/** One hunk, lines carrying jsdiff's leading ' ' / '-' / '+' / '\' marker. */
export interface PatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/**
 * Vibes' own patch shape rather than jsdiff's `StructuredPatch`.
 *
 * WHY: the block schema is a contract that project renderers write against and
 * that report.json serialises. Pinning it to a dependency's interface means a
 * jsdiff minor bump can change the report format. It also lets `truncated`
 * live on the patch, so "this diff was cut short" survives into both emitters
 * instead of being a fact only the producer of the patch knew.
 */
export interface Patch {
  readonly oldLabel: string;
  readonly newLabel: string;
  readonly hunks: readonly PatchHunk[];
  /** Set when the budget cut hunks. Emitters MUST render this, not hide it. */
  readonly truncated: boolean;
  /** Number of patch lines dropped by the budget. */
  readonly droppedLines: number;
}

/* ───────────────────────────── the blocks ────────────────────────────── */

export interface HeadingBlock {
  readonly kind: 'heading';
  readonly level: 2 | 3 | 4;
  readonly text: string;
}
export interface TextBlock {
  readonly kind: 'text';
  readonly text: string;
}
export interface KvBlock {
  readonly kind: 'kv';
  readonly entries: readonly (readonly [string, string])[];
}
export interface CodeBlock {
  readonly kind: 'code';
  readonly text: string;
  /** A HINT only. Never used to drive highlighting — see `emit/html.ts`. */
  readonly lang?: string;
}
export interface DiffBlock {
  readonly kind: 'diff';
  readonly patch: Patch;
  readonly intraLine?: 'word' | 'none';
  readonly view?: 'unified' | 'split';
}
export interface TableBlock {
  readonly kind: 'table';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | null)[])[];
  readonly align?: readonly ('left' | 'right')[];
}
export interface SeriesBlock {
  readonly kind: 'series';
  readonly label: string;
  readonly unit?: string;
  readonly epsilon?: number;
  readonly x: { readonly x0: number; readonly dx: number } | readonly number[];
  readonly old: readonly number[];
  readonly new: readonly number[];
}
export interface NoteBlock {
  readonly kind: 'note';
  readonly level: Severity;
  readonly text: string;
}
export interface DetailsBlock {
  readonly kind: 'details';
  readonly summary: string;
  readonly open?: boolean;
  readonly children: readonly RenderBlock[];
}

export type RenderBlock =
  | HeadingBlock
  | TextBlock
  | KvBlock
  | CodeBlock
  | DiffBlock
  | TableBlock
  | SeriesBlock
  | NoteBlock
  | DetailsBlock;

/* ─────────────────────────── text sanitisation ───────────────────────── */

/**
 * U+240D SYMBOL FOR CARRIAGE RETURN. A lone CR renders as nothing in both
 * markdown and HTML, so a CRLF/LF-only change would show as an identical-
 * looking line pair — the single most confusing possible diff. Make it visible.
 */
const CR_GLYPH = '␍';

/**
 * Strip ANSI/VT sequences and the remaining unprintable C0 controls.
 *
 * `stripVTControlCharacters` is a node:util builtin on both Node 20 and 23, so
 * this costs no dependency. It is not only cosmetic: an escape sequence in
 * snapshot bytes is an injection surface for any terminal that later cats the
 * markdown, and a stray ESC inside an HTML attribute is a parser hazard.
 */
export function sanitizeText(input: string): string {
  const stripped = stripVTControlCharacters(input);
  let out = '';
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\n' || ch === '\t') {
      out += ch;
    } else if (ch === '\r') {
      out += CR_GLYPH;
    } else if (code < 0x20 || code === 0x7f) {
      // Replacement, not deletion: dropping it would make two different byte
      // sequences render identically, which is the lie this tool exists to stop.
      out += '�';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Single-line variant: newlines collapse to spaces (headings, summaries, kv). */
export function sanitizeInline(input: string): string {
  return sanitizeText(input).replace(/[\n\t]+/g, ' ').trim();
}

/* ──────────────────────────── block utilities ────────────────────────── */

export function countBlocks(blocks: readonly RenderBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    n += 1;
    if (b.kind === 'details') n += countBlocks(b.children);
  }
  return n;
}

/**
 * Cheap byte estimate used for budget decisions BEFORE emitting.
 *
 * Deliberately an over-estimate on structured blocks (tables, diffs) — a
 * budget that under-estimates silently blows the real limit, and for the
 * markdown surface that means GitHub refusing to render the file at all.
 */
export function estimateBytes(blocks: readonly RenderBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        n += b.text.length + 8;
        break;
      case 'text':
        n += b.text.length + 2;
        break;
      case 'kv':
        for (const [k, v] of b.entries) n += k.length + v.length + 8;
        break;
      case 'code':
        n += b.text.length + 16;
        break;
      case 'diff':
        for (const h of b.patch.hunks) {
          // 6 bytes of table markup per line is the HTML surface's real cost;
          // markdown is cheaper, and over-estimating is the safe direction.
          n += 40;
          for (const line of h.lines) n += line.length + 6;
        }
        break;
      case 'table':
        n += b.columns.join('').length + 16;
        for (const row of b.rows) {
          for (const cell of row) n += String(cell ?? '').length + 4;
        }
        break;
      case 'series':
        // Rendered as a downsampled SVG/table, not as raw points.
        n += 6_000 + b.label.length;
        break;
      case 'note':
        n += b.text.length + 16;
        break;
      case 'details':
        n += b.summary.length + 32 + estimateBytes(b.children);
        break;
    }
  }
  return n;
}

/* ────────────────────────── schema validation ────────────────────────── */

export interface BlockValidation {
  readonly blocks: readonly RenderBlock[];
  readonly errors: readonly string[];
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validateHunk(v: unknown): PatchHunk | null {
  if (typeof v !== 'object' || v === null) return null;
  const h = v as Record<string, unknown>;
  if (!isNum(h['oldStart']) || !isNum(h['oldLines'])) return null;
  if (!isNum(h['newStart']) || !isNum(h['newLines'])) return null;
  if (!Array.isArray(h['lines'])) return null;
  const lines = (h['lines'] as unknown[]).filter(isStr).map(sanitizeText);
  return {
    oldStart: h['oldStart'],
    oldLines: h['oldLines'],
    newStart: h['newStart'],
    newLines: h['newLines'],
    lines,
  };
}

function validateBlock(v: unknown, errors: string[], depth: number): RenderBlock | null {
  if (typeof v !== 'object' || v === null) {
    errors.push('block is not an object');
    return null;
  }
  const b = v as Record<string, unknown>;
  const kind = b['kind'];
  switch (kind) {
    case 'heading': {
      const level = b['level'];
      if (level !== 2 && level !== 3 && level !== 4) {
        errors.push('heading.level must be 2, 3 or 4');
        return null;
      }
      return { kind: 'heading', level, text: sanitizeInline(String(b['text'] ?? '')) };
    }
    case 'text':
      return { kind: 'text', text: sanitizeText(String(b['text'] ?? '')) };
    case 'kv': {
      if (!Array.isArray(b['entries'])) {
        errors.push('kv.entries must be an array');
        return null;
      }
      const entries: (readonly [string, string])[] = [];
      for (const e of b['entries'] as unknown[]) {
        if (!Array.isArray(e) || e.length < 2) continue;
        entries.push([sanitizeInline(String(e[0])), sanitizeInline(String(e[1]))]);
      }
      return { kind: 'kv', entries };
    }
    case 'code': {
      const lang = b['lang'];
      const text = sanitizeText(String(b['text'] ?? ''));
      // exactOptionalPropertyTypes: build the two shapes, never assign undefined.
      return isStr(lang) && /^[A-Za-z0-9_+-]{1,20}$/.test(lang)
        ? { kind: 'code', text, lang }
        : { kind: 'code', text };
    }
    case 'diff': {
      const p = b['patch'];
      if (typeof p !== 'object' || p === null) {
        errors.push('diff.patch must be an object');
        return null;
      }
      const pr = p as Record<string, unknown>;
      const rawHunks = Array.isArray(pr['hunks']) ? (pr['hunks'] as unknown[]) : [];
      const hunks: PatchHunk[] = [];
      for (const h of rawHunks) {
        const parsed = validateHunk(h);
        if (parsed) hunks.push(parsed);
      }
      const patch: Patch = {
        oldLabel: sanitizeInline(String(pr['oldLabel'] ?? 'baseline')),
        newLabel: sanitizeInline(String(pr['newLabel'] ?? 'received')),
        hunks,
        truncated: pr['truncated'] === true,
        droppedLines: isNum(pr['droppedLines']) ? pr['droppedLines'] : 0,
      };
      const intraLine = b['intraLine'] === 'word' ? 'word' : 'none';
      const view = b['view'] === 'split' ? 'split' : 'unified';
      return { kind: 'diff', patch, intraLine, view };
    }
    case 'table': {
      if (!Array.isArray(b['columns']) || !Array.isArray(b['rows'])) {
        errors.push('table needs columns[] and rows[]');
        return null;
      }
      const columns = (b['columns'] as unknown[]).map((c) => sanitizeInline(String(c)));
      const rows: (string | number | null)[][] = [];
      for (const r of b['rows'] as unknown[]) {
        if (!Array.isArray(r)) continue;
        rows.push(
          (r as unknown[]).map((cell) =>
            cell === null || cell === undefined
              ? null
              : isNum(cell)
                ? cell
                : sanitizeInline(String(cell)),
          ),
        );
      }
      const rawAlign = Array.isArray(b['align']) ? (b['align'] as unknown[]) : null;
      const align = rawAlign?.map((a) => (a === 'right' ? 'right' : 'left'));
      return align ? { kind: 'table', columns, rows, align } : { kind: 'table', columns, rows };
    }
    case 'series': {
      const oldArr = Array.isArray(b['old']) ? (b['old'] as unknown[]).filter(isNum) : null;
      const newArr = Array.isArray(b['new']) ? (b['new'] as unknown[]).filter(isNum) : null;
      if (!oldArr || !newArr) {
        errors.push('series needs numeric old[] and new[]');
        return null;
      }
      const rawX = b['x'];
      let x: { x0: number; dx: number } | number[];
      if (Array.isArray(rawX)) {
        x = (rawX as unknown[]).filter(isNum);
      } else if (typeof rawX === 'object' && rawX !== null) {
        const xo = rawX as Record<string, unknown>;
        x = { x0: isNum(xo['x0']) ? xo['x0'] : 0, dx: isNum(xo['dx']) ? xo['dx'] : 1 };
      } else {
        x = { x0: 0, dx: 1 };
      }
      const label = sanitizeInline(String(b['label'] ?? 'series'));
      const unit = b['unit'];
      const epsilon = b['epsilon'];
      const base = { kind: 'series' as const, label, x, old: oldArr, new: newArr };
      return {
        ...base,
        ...(isStr(unit) ? { unit: sanitizeInline(unit) } : {}),
        ...(isNum(epsilon) ? { epsilon } : {}),
      };
    }
    case 'note': {
      const level = b['level'];
      const lvl: Severity = level === 'error' || level === 'warn' ? level : 'info';
      return { kind: 'note', level: lvl, text: sanitizeText(String(b['text'] ?? '')) };
    }
    case 'details': {
      if (depth >= 3) {
        errors.push('details nested deeper than 3 levels');
        return null;
      }
      const children = Array.isArray(b['children'])
        ? validateBlocksInner(b['children'] as unknown[], errors, depth + 1)
        : [];
      const summary = sanitizeInline(String(b['summary'] ?? 'details'));
      return b['open'] === true
        ? { kind: 'details', summary, open: true, children }
        : { kind: 'details', summary, children };
    }
    default:
      errors.push(`unknown block kind ${JSON.stringify(kind)}`);
      return null;
  }
}

function validateBlocksInner(raw: unknown[], errors: string[], depth: number): RenderBlock[] {
  const out: RenderBlock[] = [];
  for (const v of raw) {
    const b = validateBlock(v, errors, depth);
    if (b) out.push(b);
  }
  return out;
}

/**
 * Validate + sanitise renderer output.
 *
 * Renderers are repo-owned code with the same trust as a producer `cmd`, so
 * this is not a sandbox — it bounds the blast radius on OUTPUT, not on
 * capability. What it does buy: a renderer cannot smuggle raw markup into
 * either emitter, and a renderer returning garbage degrades to "renderer-error
 * plus the default text diff" instead of aborting the run.
 */
export function validateBlocks(raw: unknown): BlockValidation {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    return { blocks: [], errors: ['renderer did not return an array of blocks'] };
  }
  return { blocks: validateBlocksInner(raw, errors, 0), errors };
}

/** Truncate a block list to at most `max` blocks (counting nested children). */
export function capBlocks(
  blocks: readonly RenderBlock[],
  max: number,
): { blocks: readonly RenderBlock[]; dropped: number } {
  const total = countBlocks(blocks);
  if (total <= max) return { blocks, dropped: 0 };
  const kept: RenderBlock[] = [];
  let used = 0;
  for (const b of blocks) {
    const cost = b.kind === 'details' ? 1 + countBlocks(b.children) : 1;
    if (used + cost > max) break;
    kept.push(b);
    used += cost;
  }
  return { blocks: kept, dropped: total - used };
}
