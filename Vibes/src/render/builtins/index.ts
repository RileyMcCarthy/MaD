/**
 * The builtin renderer set, plus the format sniffer that selects among them
 * when nothing was declared.
 */

import type { RendererId } from '../../types.js';
import type { RenderInput, RendererModule } from '../registry.js';
import { decodeText, looksBinary } from '../textDiff.js';
import { binaryRenderer } from './binary.js';
import { jsonRenderer } from './json.js';
import { seriesRenderer } from './series.js';
import { textRenderer } from './text.js';

export { binaryRenderer, hexDump, firstDifferingOffset, sha256 } from './binary.js';
export { jsonRenderer, canonicalJson } from './json.js';
export { seriesRenderer, parseDelimited, columnStat } from './series.js';
export { textRenderer, renderTextDiff } from './text.js';

export const BUILTIN_RENDERERS: Readonly<Record<RendererId, RendererModule>> = Object.freeze({
  text: textRenderer,
  json: jsonRenderer,
  series: seriesRenderer,
  binary: binaryRenderer,
});

function parsesAsJson(buf: Buffer | null): boolean {
  if (buf === null) return true; // an absent side never blocks the choice
  if (looksBinary(buf)) return false;
  const { text, lossy } = decodeText(buf);
  if (lossy) return false;
  const head = text.trimStart()[0];
  if (head !== '{' && head !== '[') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format sniff, in the spec's order: binary → series → json → (fall through).
 *
 * Binary first because a NUL byte makes every other answer wrong. Series is
 * driven by the COMPARATOR's mode, not by the file extension: a `.csv` compared
 * exactly wants a line diff (the reviewer needs to see which row moved), while
 * a tolerance-compared file wants shape. The mode is the statement of intent;
 * the extension is a guess.
 */
export function sniffRenderer(input: RenderInput): RendererId | null {
  if (
    (input.baseline !== null && looksBinary(input.baseline)) ||
    (input.received !== null && looksBinary(input.received))
  ) {
    return 'binary';
  }
  if (input.ref.verdict.mode === 'tolerance') return 'series';
  if (input.baseline !== null || input.received !== null) {
    if (parsesAsJson(input.baseline) && parsesAsJson(input.received)) return 'json';
  }
  return null;
}
