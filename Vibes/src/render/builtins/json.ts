/**
 * JSON renderer: canonicalise both sides, then diff the canonical text.
 *
 * WHY canonicalise instead of diffing the raw bytes: a producer that switches
 * serialisers reorders keys, and a raw diff then paints the entire file red for
 * a change nobody made. Canonical form makes key order invisible — and a
 * key-order-only change therefore renders as "no line-level differences",
 * which is exactly the honest answer.
 *
 * WHY it still shows a diff and not just "equivalent": deciding equivalence is
 * the comparator's job. This module renders; it never issues a verdict.
 */

import type { RenderBlock } from '../blocks.js';
import type { RenderContext, RenderInput, RendererModule } from '../registry.js';
import { decodeText, looksBinary, makePatch, patchLineCount } from '../textDiff.js';

/**
 * Stable stringify: object keys sorted, arrays left in order.
 *
 * Array order is NEVER sorted. An array is an ordered value in JSON, and a
 * producer whose output order became nondeterministic is a real finding — one
 * this renderer would erase.
 */
export function canonicalJson(value: unknown, indent = 2): string {
  return `${stringify(value, indent, 0)}\n`;
}

function stringify(value: unknown, indent: number, depth: number): string {
  const pad = ' '.repeat(indent * depth);
  const padIn = ' '.repeat(indent * (depth + 1));
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => `${padIn}${stringify(v, indent, depth + 1)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (entries.length === 0) return '{}';
    const items = entries.map(
      ([k, v]) => `${padIn}${JSON.stringify(k)}: ${stringify(v, indent, depth + 1)}`,
    );
    return `{\n${items.join(',\n')}\n${pad}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // JSON.stringify renders NaN, Infinity and -Infinity all as `null`, making
    // three distinct behaviours indistinguishable from a legitimate null.
    return JSON.stringify(String(value));
  }
  return JSON.stringify(value) ?? 'null';
}

function parse(buf: Buffer | null): { ok: true; value: unknown } | { ok: false } {
  if (buf === null) return { ok: true, value: null };
  if (looksBinary(buf)) return { ok: false };
  const { text, lossy } = decodeText(buf);
  if (lossy) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function renderJsonDiff(input: RenderInput, ctx: RenderContext): RenderBlock[] {
  const oldParsed = parse(input.baseline);
  const newParsed = parse(input.received);
  if (!oldParsed.ok || !newParsed.ok) {
    ctx.log(`${input.ref.file}: not parseable as JSON on both sides`);
    return [
      {
        kind: 'note',
        level: 'warn',
        text: 'Selected as JSON but one side did not parse; nothing was rendered by this renderer.',
      },
    ];
  }

  const oldText = input.baseline === null ? '' : canonicalJson(oldParsed.value);
  const newText = input.received === null ? '' : canonicalJson(newParsed.value);

  const patch = makePatch(oldText, newText, {
    oldLabel: `${input.ref.file} (canonical)`,
    newLabel: `${input.ref.file} (canonical)`,
    context: ctx.limits.diffContext,
    maxPatchLines: ctx.limits.maxPatchLines,
  });

  const blocks: RenderBlock[] = [
    {
      kind: 'note',
      level: 'info',
      text: 'Keys are sorted and re-indented before diffing, so key order alone never shows as a change. Array order is preserved and IS compared.',
    },
  ];
  if (patch.hunks.length === 0) {
    blocks.push({
      kind: 'note',
      level: 'info',
      text: 'The two documents are identical once key order and whitespace are normalised.',
    });
    return blocks;
  }
  if (patch.truncated) {
    blocks.push({
      kind: 'note',
      level: 'warn',
      text: `Diff truncated at ${patchLineCount(patch)} lines; ${patch.droppedLines} further changed lines are not shown.`,
    });
    ctx.log(`${input.ref.file}: JSON diff truncated, ${patch.droppedLines} lines not shown`);
  }
  blocks.push({ kind: 'diff', patch, intraLine: 'word', view: 'unified' });
  return blocks;
}

export const jsonRenderer: RendererModule = {
  name: 'json',
  canRender(input: RenderInput): boolean {
    return parse(input.baseline).ok && parse(input.received).ok;
  },
  render: renderJsonDiff,
};
