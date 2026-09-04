/**
 * Pixel comparison — NOT implemented in v1, and loudly so.
 *
 * The reasons are dispositive, not scheduling: MaD's committed screenshots are
 * 2880 px wide (19–40 MB decoded RGBA each), they are captured by system Chrome
 * on macOS while CI is ubuntu — so font substitution changes all of them at
 * once with zero code change — they live under `docs/**` which matches no CI
 * path filter, and PNG bytes do not delta-compress in a pack file that is
 * already 226 MiB.
 *
 * The ONE thing this module guarantees: a `pixel` compare mode is a hard,
 * named configuration error. It can never be a silent pass, and it can never
 * degrade into "exact" behind the author's back — either of which would let a
 * config declare image coverage the tool does not have.
 */

import type { CompareMode } from '../types.js';

export const PIXEL_UNSUPPORTED_CODE = 'V04F_PIXEL_UNSUPPORTED';

export const PIXEL_UNSUPPORTED_REASON =
  'pixel comparison is not available in v1: cross-platform image baselines are ' +
  'not stable (macOS-captured screenshots vs ubuntu CI substitute fonts, which ' +
  'changes every image with no code change), and multi-megabyte RGBA decoding ' +
  'has no byte budget in the report';

export const PIXEL_UNSUPPORTED_FIX =
  'Remove the `pixel` compare mode, or replace the image producer with one that ' +
  'emits a textual or numeric artifact (e.g. measured element geometry) that can ' +
  'be compared exactly or with a declared tolerance.';

export interface CompareConfigError {
  readonly code: string;
  /** Where the offending mode was declared, e.g. "control/screens: **\/*.png". */
  readonly where: string;
  readonly message: string;
  readonly fix: string;
}

export class PixelComparisonUnsupportedError extends Error {
  readonly code = PIXEL_UNSUPPORTED_CODE;
  readonly where: string;
  readonly fix = PIXEL_UNSUPPORTED_FIX;

  constructor(where: string) {
    super(`${PIXEL_UNSUPPORTED_CODE}: ${PIXEL_UNSUPPORTED_REASON} (declared at ${where})`);
    this.name = 'PixelComparisonUnsupportedError';
    this.where = where;
  }
}

/** Structured form, for the config layer to render as a diagnostic. */
export function pixelConfigError(where: string): CompareConfigError {
  return {
    code: PIXEL_UNSUPPORTED_CODE,
    where,
    message: PIXEL_UNSUPPORTED_REASON,
    fix: PIXEL_UNSUPPORTED_FIX,
  };
}

export type SupportedCompareMode = Exclude<CompareMode, { kind: 'pixel' }>;

export function isPixelMode(mode: CompareMode): mode is Extract<CompareMode, { kind: 'pixel' }> {
  return mode.kind === 'pixel';
}

/** Throws on `pixel`. There is no code path that returns a verdict for it. */
export function assertSupportedMode(
  mode: CompareMode,
  where: string,
): asserts mode is SupportedCompareMode {
  if (mode.kind === 'pixel') throw new PixelComparisonUnsupportedError(where);
}

/**
 * Collect the pixel declarations in a spec so `vibes doctor` / config
 * validation can report ALL of them at once instead of dying on the first.
 */
export function collectPixelErrors(
  modes: readonly { readonly mode: CompareMode; readonly where: string }[],
): CompareConfigError[] {
  return modes
    .filter((m) => m.mode.kind === 'pixel')
    .map((m) => pixelConfigError(m.where));
}
