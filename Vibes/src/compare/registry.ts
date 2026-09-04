/**
 * Mode resolution and the one entry point the pipeline calls per snapshot file.
 *
 * Two rules live here and nowhere else:
 *  - a `CompareSpec` rule array is FIRST-MATCH-WINS, and an unmatched file falls
 *    back to `exact` — the strict direction, so a rule list that forgets a
 *    catch-all can never loosen a comparison by omission;
 *  - `added`/`deleted` are verdicts about EXISTENCE, produced only from a null
 *    side, never inferred from a comparison.
 */

import picomatch from 'picomatch';
import type { CompareMode, CompareSpec, Verdict, VerdictKind } from '../types.js';
import { compareExact } from './exact.js';
import type { ExactCompareResult, ExactOptions } from './exact.js';
import { compareTolerance } from './tolerance.js';
import type { ToleranceOptions, ToleranceReport } from './tolerance.js';
import type { NormalizationStep } from './normalize.js';
import { assertSupportedMode } from './pixel.js';
import type { StructuredPatch } from 'diff';

export const EXACT_MODE: CompareMode = { kind: 'exact' };

export interface ModeResolution {
  readonly mode: CompareMode;
  /** Index of the winning rule, or null for a bare mode / the exact fallback. */
  readonly ruleIndex: number | null;
  /** True when no rule matched and `exact` was substituted. */
  readonly fellBack: boolean;
}

/**
 * `relPath` is relative to the producer's out dir, POSIX-separated. `dot: true`
 * because snapshot dirs legitimately carry dotfiles (`.vibes-selected`,
 * `.gitattributes`) and a matcher that skips them would silently leave them on
 * the exact fallback while the author believed a rule covered them.
 */
export function resolveCompareMode(spec: CompareSpec | undefined, relPath: string): ModeResolution {
  if (spec === undefined) return { mode: EXACT_MODE, ruleIndex: null, fellBack: true };
  if (!Array.isArray(spec)) {
    return { mode: spec as CompareMode, ruleIndex: null, fellBack: false };
  }
  const rules = spec as readonly { readonly match: string; readonly use: CompareMode }[];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule === undefined) continue;
    if (picomatch(rule.match, { dot: true })(relPath)) {
      return { mode: rule.use, ruleIndex: i, fellBack: false };
    }
  }
  return { mode: EXACT_MODE, ruleIndex: null, fellBack: true };
}

export interface SnapshotCompareInput {
  /** Path relative to the producer's out dir; used for rule matching and text. */
  readonly file: string;
  /** Committed baseline bytes, or null when the file is new. */
  readonly baseline: Buffer | null;
  /** Freshly produced bytes, or null when the producer no longer emits it. */
  readonly received: Buffer | null;
  readonly spec?: CompareSpec;
  readonly options?: CompareOptions;
  /** Identifies the declaration site in a pixel-mode error message. */
  readonly where?: string;
}

export interface CompareOptions extends ExactOptions, ToleranceOptions {}

export interface CompareResult {
  readonly file: string;
  readonly verdict: Verdict;
  readonly mode: CompareMode['kind'];
  /** Which rule decided the mode, for the report's provenance column. */
  readonly ruleIndex: number | null;
  readonly patch: StructuredPatch | null;
  readonly tooDivergent: boolean;
  readonly absorbedBy: readonly NormalizationStep[] | null;
  readonly changedLines: { readonly added: number; readonly removed: number } | null;
  readonly tolerance: ToleranceReport | null;
  readonly notes: readonly string[];
}

function fromExact(file: string, res: ExactCompareResult, ruleIndex: number | null): CompareResult {
  return {
    file,
    verdict: res.verdict,
    mode: 'exact',
    ruleIndex,
    patch: res.patch,
    tooDivergent: res.tooDivergent,
    absorbedBy: res.absorbedBy,
    changedLines: res.changedLines,
    tolerance: null,
    notes: res.notes,
  };
}

function existenceResult(
  file: string,
  kind: Extract<VerdictKind, 'added' | 'deleted'>,
  mode: CompareMode['kind'],
  ruleIndex: number | null,
  bytes: number,
): CompareResult {
  return {
    file,
    verdict: {
      kind,
      mode,
      summary:
        kind === 'added'
          ? `new snapshot file (${bytes} bytes)`
          : `snapshot file no longer produced (was ${bytes} bytes)`,
    },
    mode,
    ruleIndex,
    patch: null,
    tooDivergent: false,
    absorbedBy: null,
    changedLines: null,
    tolerance: null,
    notes: [],
  };
}

/**
 * Compare one snapshot file.
 *
 * `not-run` and `not-selected` are deliberately NOT reachable from here: they
 * are statements about a producer's execution and this function has no way to
 * know one. A caller must stamp them before comparison and must not call this
 * function for a producer that did not run ok — otherwise a crashed producer's
 * stale bytes could be reported as clean.
 */
export function compareSnapshotFile(input: SnapshotCompareInput): CompareResult {
  const { mode, ruleIndex } = resolveCompareMode(input.spec, input.file);
  const where = input.where ?? input.file;
  // Throws. A pixel mode never yields a verdict of any kind.
  assertSupportedMode(mode, where);

  const { baseline, received } = input;
  if (baseline === null && received === null) {
    throw new Error(
      `compareSnapshotFile(${input.file}): both sides are absent; existence must be ` +
        'decided by the caller before comparison',
    );
  }
  if (baseline === null) {
    return existenceResult(input.file, 'added', mode.kind, ruleIndex, received?.byteLength ?? 0);
  }
  if (received === null) {
    return existenceResult(input.file, 'deleted', mode.kind, ruleIndex, baseline.byteLength);
  }

  const options = input.options ?? {};
  if (mode.kind === 'exact') {
    return fromExact(input.file, compareExact(baseline, received, options), ruleIndex);
  }

  // tolerance. Byte equality short-circuits before parsing: a 200k-row file
  // that did not move should not cost a scan.
  if (baseline.equals(received)) {
    return {
      file: input.file,
      verdict: { kind: 'identical', mode: 'tolerance', summary: 'byte-identical' },
      mode: 'tolerance',
      ruleIndex,
      patch: null,
      tooDivergent: false,
      absorbedBy: null,
      changedLines: null,
      tolerance: null,
      notes: [],
    };
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let baselineText: string;
  let receivedText: string;
  try {
    baselineText = decoder.decode(baseline);
  } catch {
    return structuralDecodeFailure(input.file, 'baseline', ruleIndex);
  }
  try {
    receivedText = decoder.decode(received);
  } catch {
    return structuralDecodeFailure(input.file, 'received', ruleIndex);
  }

  const res = compareTolerance(baselineText, receivedText, mode, options);
  return {
    file: input.file,
    verdict: res.verdict,
    mode: 'tolerance',
    ruleIndex,
    patch: null,
    tooDivergent: false,
    absorbedBy: null,
    changedLines: null,
    tolerance: res.report,
    notes: res.report?.notes ?? [],
  };
}

function structuralDecodeFailure(
  file: string,
  side: 'baseline' | 'received',
  ruleIndex: number | null,
): CompareResult {
  return {
    file,
    verdict: {
      kind: 'structural',
      mode: 'tolerance',
      summary: `${side} is not valid UTF-8 and cannot be read as a numeric series`,
    },
    mode: 'tolerance',
    ruleIndex,
    patch: null,
    tooDivergent: false,
    absorbedBy: null,
    changedLines: null,
    tolerance: null,
    notes: [`${side} failed strict UTF-8 decoding`],
  };
}

/* ───────────────────────── verdict classification ──────────────────────── */

/**
 * `identical` and `equivalent` are DISTINCT and both are non-changes;
 * `different` and `structural` are DISTINCT and both are changes. These two
 * predicates exist so no downstream module re-derives that from a string
 * comparison and quietly collapses a pair.
 */
export function isNonChange(kind: VerdictKind): boolean {
  return kind === 'identical' || kind === 'equivalent';
}

export function isChange(kind: VerdictKind): boolean {
  return (
    kind === 'different' || kind === 'structural' || kind === 'added' || kind === 'deleted'
  );
}

/** Neither a change nor a non-change: nothing was compared. */
export function isUnevaluated(kind: VerdictKind): boolean {
  return kind === 'not-run' || kind === 'not-selected';
}

export function verdictNotRun(mode: CompareMode['kind'], reason: string): Verdict {
  return { kind: 'not-run', mode, summary: reason };
}

export function verdictNotSelected(mode: CompareMode['kind'], reason: string): Verdict {
  return { kind: 'not-selected', mode, summary: reason };
}
