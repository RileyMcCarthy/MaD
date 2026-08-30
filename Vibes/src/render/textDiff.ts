/**
 * The DEFAULT renderer's engine: a plain unified text diff.
 *
 * WHY this is the default and not "no renderer": a project with zero custom
 * renderers must still get a working report on its first run. A registry whose
 * miss case is an empty section teaches people the tool has nothing to say.
 */

import { structuredPatch } from 'diff';
import type { Patch, PatchHunk, RenderBlock } from './blocks.js';
import { sanitizeText } from './blocks.js';

/** git's own rule: a NUL byte in the first 8000 bytes means binary. */
export const BINARY_SNIFF_BYTES = 8000;

export function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export interface DecodedText {
  readonly text: string;
  /** True when the bytes were not valid UTF-8 and lossy replacement happened. */
  readonly lossy: boolean;
}

const STRICT = new TextDecoder('utf-8', { fatal: true });
const LOSSY = new TextDecoder('utf-8', { fatal: false });

export function decodeText(buf: Buffer): DecodedText {
  try {
    return { text: STRICT.decode(buf), lossy: false };
  } catch {
    // Invalid UTF-8 is a real, reportable property of the file — not a crash
    // and not a reason to silently show nothing.
    return { text: LOSSY.decode(buf), lossy: true };
  }
}

export interface PatchOptions {
  readonly oldLabel: string;
  readonly newLabel: string;
  readonly context?: number;
  /** Hard cap on emitted patch lines across all hunks. */
  readonly maxPatchLines: number;
}

/**
 * Build a bounded unified patch.
 *
 * The cap is applied hunk-by-hunk and the remainder is reported through
 * `Patch.truncated` / `droppedLines`, never dropped quietly: an emitter that
 * shows 400 of 4000 changed lines with no marker reads as "that was all of it".
 */
export function makePatch(oldText: string, newText: string, opts: PatchOptions): Patch {
  const sp = structuredPatch(
    opts.oldLabel,
    opts.newLabel,
    oldText,
    newText,
    '',
    '',
    { context: opts.context ?? 3 },
  );

  const hunks: PatchHunk[] = [];
  let used = 0;
  let dropped = 0;
  let truncated = false;

  for (const h of sp.hunks) {
    if (truncated) {
      dropped += h.lines.length;
      continue;
    }
    const room = opts.maxPatchLines - used;
    if (room <= 0) {
      truncated = true;
      dropped += h.lines.length;
      continue;
    }
    const lines = h.lines.slice(0, room).map(sanitizeText);
    if (lines.length < h.lines.length) {
      truncated = true;
      dropped += h.lines.length - lines.length;
    }
    used += lines.length;
    hunks.push({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines,
    });
  }

  return {
    oldLabel: opts.oldLabel,
    newLabel: opts.newLabel,
    hunks,
    truncated,
    droppedLines: dropped,
  };
}

export function patchLineCount(patch: Patch): number {
  let n = 0;
  for (const h of patch.hunks) n += h.lines.length;
  return n;
}

/** Counts of +/- lines, for one-line summaries. */
export function patchStat(patch: Patch): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of patch.hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/**
 * `maxEditLength` is derived per file, never a flat constant.
 *
 * A flat "too divergent to diff" threshold fires on ordinary same-size
 * rewrites, so the hatch stops meaning what it says. 4x the line count is the
 * documented derivation; the ceiling is what keeps a pathological file from
 * costing the whole run.
 */
export function deriveMaxEditLength(oldText: string, newText: string, ceiling: number): number {
  const lines = Math.max(countLines(oldText), countLines(newText));
  return Math.min(4 * lines, ceiling);
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

/** A whole-file "added" / "deleted" pseudo-patch, so both sides render alike. */
export function wholeFilePatch(
  text: string,
  direction: 'added' | 'deleted',
  opts: PatchOptions,
): Patch {
  return direction === 'added'
    ? makePatch('', text, opts)
    : makePatch(text, '', opts);
}

export interface TextDiffOptions extends PatchOptions {
  readonly intraLine?: 'word' | 'none';
  readonly view?: 'unified' | 'split';
}

/** The blocks the default renderer emits for a text pair. */
export function textDiffBlocks(
  oldText: string,
  newText: string,
  opts: TextDiffOptions,
): RenderBlock[] {
  const patch = makePatch(oldText, newText, opts);
  if (patch.hunks.length === 0) {
    return [
      {
        kind: 'note',
        level: 'info',
        text: 'No line-level differences. The files differ only in bytes git normalises away (line endings, trailing newline, or a BOM).',
      },
    ];
  }
  const stat = patchStat(patch);
  const blocks: RenderBlock[] = [
    {
      kind: 'diff',
      patch,
      intraLine: opts.intraLine ?? 'word',
      view: opts.view ?? 'unified',
    },
  ];
  if (patch.truncated) {
    blocks.unshift({
      kind: 'note',
      level: 'warn',
      text: `Diff truncated to ${patchLineCount(patch)} lines; ${patch.droppedLines} further changed lines are not shown (+${stat.added}/-${stat.removed} shown).`,
    });
  }
  return blocks;
}
