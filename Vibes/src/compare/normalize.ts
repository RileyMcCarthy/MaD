/**
 * Declared text normalization, and the `absorbedBy` bisect.
 *
 * The rule this module encodes: normalization NEVER produces `identical`.
 * `identical` means the committed bytes and the produced bytes are the same
 * bytes. When they differ but agree after a declared normalization step, the
 * verdict is `equivalent` and the report names the step. Collapsing those two
 * into one green state is exactly the lie this tool exists to prevent — but
 * rendering a CRLF flip as a 400-line rewrite is the failure mode that gets the
 * report ignored, and MaD builds on both ubuntu and macos.
 */

/**
 * Fixed order. It is fixed because the bisect reports a PREFIX of this list,
 * so a reordering would silently change what the report claims absorbed the
 * difference.
 */
export const NORMALIZATION_ORDER = [
  'bom',
  'eol',
  'trailing-ws',
  'json-canonical',
  'final-newline',
] as const;

export type NormalizationStep = (typeof NORMALIZATION_ORDER)[number];

export interface NormalizationOptions {
  readonly bom: boolean;
  readonly eol: boolean;
  readonly trailingWhitespace: boolean;
  /** Default OFF: key order is wire-format-relevant when one schema generates
   *  C, TypeScript and Rust, so reordering keys is a real change here. */
  readonly jsonCanonical: boolean;
  readonly finalNewline: boolean;
}

export const DEFAULT_NORMALIZATION: NormalizationOptions = {
  bom: true,
  eol: true,
  // Default OFF: this repo's snapshot format pads keys to a fixed width, so a
  // trailing space can be load-bearing layout rather than noise.
  trailingWhitespace: false,
  jsonCanonical: false,
  finalNewline: true,
};

export function resolveNormalization(
  overrides?: Partial<NormalizationOptions>,
): NormalizationOptions {
  if (overrides === undefined) return DEFAULT_NORMALIZATION;
  return {
    bom: overrides.bom ?? DEFAULT_NORMALIZATION.bom,
    eol: overrides.eol ?? DEFAULT_NORMALIZATION.eol,
    trailingWhitespace:
      overrides.trailingWhitespace ?? DEFAULT_NORMALIZATION.trailingWhitespace,
    jsonCanonical: overrides.jsonCanonical ?? DEFAULT_NORMALIZATION.jsonCanonical,
    finalNewline: overrides.finalNewline ?? DEFAULT_NORMALIZATION.finalNewline,
  };
}

export function enabledSteps(options: NormalizationOptions): NormalizationStep[] {
  const on: NormalizationStep[] = [];
  if (options.bom) on.push('bom');
  if (options.eol) on.push('eol');
  if (options.trailingWhitespace) on.push('trailing-ws');
  if (options.jsonCanonical) on.push('json-canonical');
  if (options.finalNewline) on.push('final-newline');
  return on;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalJsonValue(source[key]);
    }
    return out;
  }
  return value;
}

export function applyStep(text: string, step: NormalizationStep): string {
  switch (step) {
    case 'bom':
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    case 'eol':
      // Only CRLF -> LF. A lone CR is left alone: on a file that genuinely uses
      // CR line endings, rewriting it would hide a real format change.
      return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text;
    case 'trailing-ws':
      return text.replace(/[ \t]+$/gm, '');
    case 'json-canonical': {
      // A non-JSON file (or invalid JSON) is passed through untouched rather
      // than erroring: this step is a comparison aid, not a validator.
      try {
        return `${JSON.stringify(canonicalJsonValue(JSON.parse(text)), null, 2)}\n`;
      } catch {
        return text;
      }
    }
    case 'final-newline': {
      const stripped = text.replace(/\n+$/, '');
      return stripped.length === 0 ? '' : `${stripped}\n`;
    }
    default: {
      const exhaustive: never = step;
      throw new Error(`unknown normalization step: ${String(exhaustive)}`);
    }
  }
}

export function normalizeText(text: string, options: NormalizationOptions): string {
  let out = text;
  for (const step of enabledSteps(options)) out = applyStep(out, step);
  return out;
}

export interface AbsorbResult {
  /** True when some prefix of the enabled steps made the two texts equal. */
  readonly equal: boolean;
  /** The cumulative prefix that achieved equality, or null. */
  readonly absorbedBy: readonly NormalizationStep[] | null;
  /** The last step in that prefix — the one that closed the gap. */
  readonly decisive: NormalizationStep | null;
  /** Fully normalized texts, for the diff when `equal` is false. */
  readonly baseline: string;
  readonly received: string;
}

/**
 * Walk the enabled steps cumulatively, comparing after each. At most five
 * in-memory string compares, and it converts "total rewrite" into "differs only
 * in line endings".
 */
export function bisectNormalization(
  baselineText: string,
  receivedText: string,
  options: NormalizationOptions,
): AbsorbResult {
  let b = baselineText;
  let r = receivedText;
  const applied: NormalizationStep[] = [];
  for (const step of enabledSteps(options)) {
    b = applyStep(b, step);
    r = applyStep(r, step);
    applied.push(step);
    if (b === r) {
      return {
        equal: true,
        absorbedBy: [...applied],
        decisive: step,
        baseline: b,
        received: r,
      };
    }
  }
  return { equal: false, absorbedBy: null, decisive: null, baseline: b, received: r };
}

const STEP_PHRASE: Readonly<Record<NormalizationStep, string>> = {
  bom: 'a byte-order mark',
  eol: 'line endings',
  'trailing-ws': 'trailing whitespace',
  'json-canonical': 'JSON key order or formatting',
  'final-newline': 'the trailing newline',
};

/**
 * One-line phrase for a Verdict summary. The decisive step is named first
 * because it is the one that closed the gap; the full prefix is listed because
 * an earlier step may ALSO have absorbed part of the difference, and claiming
 * only the decisive one would over-narrow the claim.
 */
export function describeAbsorption(
  absorbedBy: readonly NormalizationStep[],
  decisive: NormalizationStep | null,
): string {
  const named = decisive ?? absorbedBy[absorbedBy.length - 1] ?? null;
  const head = named === null ? 'declared normalization' : STEP_PHRASE[named];
  if (absorbedBy.length <= 1) return `differs only in ${head}`;
  return `differs only in ${head} (normalized: ${absorbedBy.join(', ')})`;
}
