/**
 * Exact comparison: byte equality after declared normalization.
 *
 * `identical` means the same bytes. `equivalent` means the bytes differ but a
 * DECLARED normalization step accounts for the whole difference, and the report
 * names the step. Two states, never one.
 */

import { structuredPatch } from 'diff';
import type { StructuredPatch } from 'diff';
import type { Verdict } from '../types.js';
import type { NormalizationOptions, NormalizationStep } from './normalize.js';
import { bisectNormalization, describeAbsorption, resolveNormalization } from './normalize.js';

export interface ExactOptions {
  readonly normalization?: Partial<NormalizationOptions>;
  /** Files larger than this are reported as changed but not diffed. */
  readonly maxFileBytes?: number;
  /** Ceiling for the derived `maxEditLength`. */
  readonly editLengthCeiling?: number;
  readonly context?: number;
}

export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_EDIT_LENGTH_CEILING = 50_000;
export const DEFAULT_CONTEXT = 3;

export interface ExactCompareResult {
  readonly verdict: Verdict;
  /** null when no text diff was computed (identical, binary, oversize, aborted). */
  readonly patch: StructuredPatch | null;
  /** True when `maxEditLength` aborted the diff: the files are too divergent. */
  readonly tooDivergent: boolean;
  readonly absorbedBy: readonly NormalizationStep[] | null;
  readonly changedLines: { readonly added: number; readonly removed: number } | null;
  readonly notes: readonly string[];
}

const NUL_SCAN_BYTES = 8000;

/** git's own rule: a NUL byte in the first 8000 bytes means binary. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, NUL_SCAN_BYTES).includes(0);
}

/**
 * Decode as strict UTF-8.
 *
 * NON-NEGOTIABLE: `Buffer.toString('utf8')` replaces every invalid sequence
 * with U+FFFD, so two DIFFERENT invalid files decode to the same string and
 * compare `identical`. `fatal: true` makes that impossible.
 */
function decodeStrict(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function compareExact(
  baseline: Buffer,
  received: Buffer,
  options: ExactOptions = {},
): ExactCompareResult {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const ceiling = options.editLengthCeiling ?? DEFAULT_EDIT_LENGTH_CEILING;
  const context = options.context ?? DEFAULT_CONTEXT;
  const normalization = resolveNormalization(options.normalization);
  const notes: string[] = [];

  if (baseline.equals(received)) {
    return {
      verdict: { kind: 'identical', mode: 'exact', summary: 'byte-identical' },
      patch: null,
      tooDivergent: false,
      absorbedBy: null,
      changedLines: null,
      notes,
    };
  }

  if (baseline.byteLength > maxFileBytes || received.byteLength > maxFileBytes) {
    return {
      verdict: {
        kind: 'different',
        mode: 'exact',
        summary:
          `bytes differ (${baseline.byteLength} -> ${received.byteLength}); ` +
          `not diffed: exceeds the ${maxFileBytes}-byte budget`,
      },
      patch: null,
      tooDivergent: true,
      absorbedBy: null,
      changedLines: null,
      notes: [`file exceeds maxFileBytes (${maxFileBytes})`],
    };
  }

  const baselineBinary = looksBinary(baseline);
  const receivedBinary = looksBinary(received);
  const baselineText = baselineBinary ? null : decodeStrict(baseline);
  const receivedText = receivedBinary ? null : decodeStrict(received);

  if (baselineText === null && receivedText === null) {
    return {
      verdict: {
        kind: 'different',
        mode: 'exact',
        summary: `binary content differs (${baseline.byteLength} -> ${received.byteLength} bytes)`,
      },
      patch: null,
      tooDivergent: false,
      absorbedBy: null,
      changedLines: null,
      notes: ['both sides are binary or not valid UTF-8; compared as bytes'],
    };
  }

  if (baselineText === null || receivedText === null) {
    // One side stopped being text. That is a change of KIND, not of content,
    // and calling it `different` would invite a reader to look for a line diff
    // that cannot exist.
    const which = baselineText === null ? 'baseline' : 'received';
    return {
      verdict: {
        kind: 'structural',
        mode: 'exact',
        summary: `${which} is binary or not valid UTF-8 while the other side is text`,
      },
      patch: null,
      tooDivergent: false,
      absorbedBy: null,
      changedLines: null,
      notes: [`${which} failed strict UTF-8 decoding or contains a NUL byte`],
    };
  }

  const absorbed = bisectNormalization(baselineText, receivedText, normalization);
  if (absorbed.equal && absorbed.absorbedBy !== null) {
    return {
      verdict: {
        kind: 'equivalent',
        mode: 'exact',
        summary: describeAbsorption(absorbed.absorbedBy, absorbed.decisive),
      },
      patch: null,
      tooDivergent: false,
      absorbedBy: absorbed.absorbedBy,
      changedLines: null,
      notes,
    };
  }

  const lines = Math.max(countLines(absorbed.baseline), countLines(absorbed.received));
  // Derived, not flat: a flat constant fires on ordinary same-size rewrites, so
  // "too divergent to diff" would stop meaning what it says.
  const maxEditLength = Math.max(1, Math.min(4 * lines, ceiling));

  const patch = structuredPatch(
    'baseline',
    'received',
    absorbed.baseline,
    absorbed.received,
    undefined,
    undefined,
    {
      context,
      // MaD builds on ubuntu AND macos. Without this one CRLF flip reads as a
      // total rewrite even when `eol` normalization is disabled.
      stripTrailingCr: true,
      maxEditLength,
    },
  );

  if (patch === undefined) {
    return {
      verdict: {
        kind: 'different',
        mode: 'exact',
        summary: `too divergent to diff (edit distance exceeds ${maxEditLength})`,
      },
      patch: null,
      tooDivergent: true,
      absorbedBy: null,
      changedLines: null,
      notes: [`maxEditLength ${maxEditLength} reached; no patch was produced`],
    };
  }

  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      const c = line.charCodeAt(0);
      if (c === 43 /* + */) added++;
      else if (c === 45 /* - */) removed++;
    }
  }

  return {
    verdict: {
      kind: 'different',
      mode: 'exact',
      summary: `${added + removed} changed lines (+${added} / -${removed}) in ${patch.hunks.length} hunk(s)`,
    },
    patch,
    tooDivergent: false,
    absorbedBy: null,
    changedLines: { added, removed },
    notes,
  };
}
