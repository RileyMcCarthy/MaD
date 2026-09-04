/**
 * The DEFAULT renderer. A plain unified text diff, nothing else.
 *
 * Every other renderer in the system is an optimisation on top of this one, and
 * every failure path in the pipeline falls back here. That is why it takes no
 * options it could get wrong and never returns zero blocks for a file that
 * actually changed.
 */

import type { RenderBlock } from '../blocks.js';
import type { RenderContext, RenderInput, RendererModule } from '../registry.js';
import {
  decodeText,
  deriveMaxEditLength,
  makePatch,
  patchLineCount,
  patchStat,
} from '../textDiff.js';

export function renderTextDiff(input: RenderInput, ctx: RenderContext): RenderBlock[] {
  const { baseline, received } = input;

  if (baseline === null && received === null) {
    return [
      {
        kind: 'note',
        level: 'warn',
        text: 'Neither the baseline nor the produced bytes were available to render.',
      },
    ];
  }

  const oldDecoded = baseline ? decodeText(baseline) : { text: '', lossy: false };
  const newDecoded = received ? decodeText(received) : { text: '', lossy: false };

  const blocks: RenderBlock[] = [];
  if (oldDecoded.lossy || newDecoded.lossy) {
    blocks.push({
      kind: 'note',
      level: 'warn',
      text: 'File is not valid UTF-8; invalid sequences are shown as U+FFFD. The bytes on disk are the contract, not this rendering.',
    });
  }

  const label = input.ref.file;
  const oldLabel = baseline === null ? `${label} (absent at base)` : label;
  const newLabel = received === null ? `${label} (removed)` : label;

  const patch = makePatch(oldDecoded.text, newDecoded.text, {
    oldLabel,
    newLabel,
    context: ctx.limits.diffContext,
    maxPatchLines: ctx.limits.maxPatchLines,
  });

  if (patch.hunks.length === 0) {
    blocks.push({
      kind: 'note',
      level: 'info',
      text: 'No line-level differences: the two files differ only in bytes that line-splitting removes (line endings, a trailing newline, or a BOM).',
    });
    return blocks;
  }

  const stat = patchStat(patch);
  const editLength = deriveMaxEditLength(
    oldDecoded.text,
    newDecoded.text,
    ctx.limits.editLengthCeiling,
  );
  if (stat.added + stat.removed > editLength) {
    // Derived per file, never a flat constant: a flat threshold fires on
    // ordinary same-size rewrites and the hatch stops meaning what it says.
    ctx.log(
      `${label}: rewrite is larger than ${editLength} edited lines; showing a bounded excerpt only`,
    );
  }

  if (patch.truncated) {
    blocks.push({
      kind: 'note',
      level: 'warn',
      text: `Diff truncated at ${patchLineCount(patch)} lines; ${patch.droppedLines} further changed lines are not shown.`,
    });
    ctx.log(`${label}: diff truncated, ${patch.droppedLines} lines not shown`);
  }

  blocks.push({ kind: 'diff', patch, intraLine: 'word', view: 'unified' });
  return blocks;
}

/**
 * No `canRender`. The default renderer never vetoes — something must be able to
 * render everything or the registry has a hole, and a hole in the registry is a
 * file that changed and produced no output.
 */
export const textRenderer: RendererModule = {
  name: 'text',
  render: renderTextDiff,
};
