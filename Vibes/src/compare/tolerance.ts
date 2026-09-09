/**
 * Tolerance comparison: keyed numeric series, per-key epsilon, worst deviation
 * and epsilon utilisation.
 *
 * The load-bearing rules, each of which exists because the obvious
 * implementation is wrong:
 *
 *  1. Shape mismatches (added/removed/reordered columns, differing row counts,
 *     an unparseable file) are `structural`, NEVER a numeric diff. A numeric
 *     comparison across a shifted schema compares unrelated pairs and reports a
 *     confident, meaningless delta.
 *  2. `Number('')` is 0 — blanks are classified as gaps before any coercion
 *     (see series.ts).
 *  3. `Math.abs(NaN - 1) > eps` is FALSE. A naive `if (delta > eps) fail` reports
 *     a firmware NaN as within tolerance. Non-finite values are branched on
 *     before any subtraction.
 *  4. `Math.abs(Infinity - Infinity)` is NaN, for the same reason.
 *  5. With a zero epsilon budget, `-0` and `0` are distinct: the file asked for
 *     numeric identity, and the sign of zero is real behaviour in this codebase.
 *     With a positive budget the difference is 0 and is absorbed — but it is
 *     counted and named in the summary rather than vanishing.
 *
 * No v1 producer uses this mode. The schema and the implementation are complete
 * anyway, because a half-built tolerance path is how a tolerance mode ships
 * later as "compare nothing".
 */

import type { CompareMode, Verdict } from '../types.js';
import { classifyCell, parseSeries } from './series.js';
import type { SeriesDelimiter, SeriesDocument } from './series.js';

export type ToleranceMode = Extract<CompareMode, { kind: 'tolerance' }>;

export interface ToleranceOptions {
  readonly delimiter?: SeriesDelimiter;
  readonly maxRows?: number;
  /** Cap on retained per-key series arrays (render input). Default 20 000. */
  readonly maxSeriesPoints?: number;
  /** Cap on the itemised cell differences carried in the report. Default 50. */
  readonly maxCellDiffs?: number;
}

export type CellDiffReason =
  | 'over-epsilon'
  | 'gap'
  | 'non-finite'
  | 'text'
  | 'signed-zero';

export interface CellDifference {
  readonly key: string;
  /** 0-based row index within the data rows. */
  readonly row: number;
  readonly baseline: string;
  readonly received: string;
  /** null when the pair was not numerically comparable. */
  readonly delta: number | null;
  /** The epsilon budget for this cell, null when none applied. */
  readonly allowed: number | null;
  readonly reason: CellDiffReason;
}

export interface KeyDeviation {
  readonly key: string;
  readonly epsilonAbs: number;
  readonly epsilonRel: number;
  /** True when `columns` excluded this key: it is compared as exact text. */
  readonly exactRequired: boolean;
  readonly comparedCells: number;
  /** Cells that exceeded the budget (or were not comparable). */
  readonly differingCells: number;
  /** Cells that differed but stayed inside the budget. */
  readonly absorbedCells: number;
  readonly worstAbsDelta: number;
  readonly worstRow: number | null;
  /** worstAbsDelta / budget-at-that-cell; null when no budget applied. */
  readonly utilisation: number | null;
  /** Retained only when every cell on both sides is finite and the series fits
   *  the point budget — a polyline cannot be drawn through a gap. */
  readonly baselineSeries: readonly number[] | null;
  readonly receivedSeries: readonly number[] | null;
}

export type StructuralKind =
  | 'parse-error'
  | 'columns-added'
  | 'columns-removed'
  | 'columns-reordered'
  | 'row-count'
  | 'header-presence';

export interface StructuralMismatch {
  readonly kind: StructuralKind;
  readonly detail: string;
  readonly addedKeys: readonly string[];
  readonly removedKeys: readonly string[];
}

export interface WorstDeviation {
  readonly key: string;
  readonly row: number;
  readonly baseline: string;
  readonly received: string;
  readonly delta: number;
  readonly allowed: number | null;
  readonly utilisation: number | null;
}

export interface ToleranceReport {
  readonly columns: readonly string[];
  readonly rows: number;
  readonly comparedCells: number;
  readonly differingCells: number;
  readonly absorbedCells: number;
  /** Rows carrying at least one cell that exceeded its budget. */
  readonly differingRows: number;
  /** Rows carrying at least one cell whose TEXT differs, budget or not. */
  readonly changedRows: number;
  readonly signedZeroFlips: number;
  /** Non-volatile comment lines that differ. Text, never numeric. */
  readonly commentLinesChanged: number;
  readonly worst: WorstDeviation | null;
  /**
   * Max utilisation across cells that had a positive budget, else null.
   *
   * NOT clamped to 1, even though `Verdict.epsilonUtilisation` documents 0..1:
   * a value above 1 happens exactly when the verdict is `different`, and it
   * says by how much the budget was blown. Clamping would render "8x over the
   * declared epsilon" as "exactly at the epsilon", which is the same class of
   * lie this tool exists to remove.
   */
  readonly epsilonUtilisation: number | null;
  readonly perKey: readonly KeyDeviation[];
  readonly structural: StructuralMismatch | null;
  /** Bounded, deterministically ordered sample of the hard differences. */
  readonly diffs: readonly CellDifference[];
  readonly truncatedDiffs: number;
  readonly notes: readonly string[];
}

export interface ToleranceCompareResult {
  readonly verdict: Verdict;
  readonly report: ToleranceReport | null;
}

interface KeyBudget {
  readonly abs: number;
  readonly rel: number;
  readonly exactRequired: boolean;
}

interface KeyAccumulator {
  readonly key: string;
  readonly budget: KeyBudget;
  compared: number;
  differing: number;
  absorbed: number;
  worstAbsDelta: number;
  worstRow: number | null;
  worstUtilisation: number | null;
  numericBaseline: number[] | null;
  numericReceived: number[] | null;
}

/** Compact, deterministic rendering of a delta for a one-line summary. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  return String(Number(n.toPrecision(3)));
}

function budgetFor(mode: ToleranceMode, key: string): KeyBudget {
  // `columns`, when present, RESTRICTS numeric tolerance to those columns. Any
  // other column is compared as exact text — the strict direction, so adding a
  // column can never buy a free pass.
  if (mode.columns !== undefined && !mode.columns.includes(key)) {
    return { abs: 0, rel: 0, exactRequired: true };
  }
  return { abs: mode.abs ?? 0, rel: mode.rel ?? 0, exactRequired: false };
}

function structuralVerdict(m: StructuralMismatch): Verdict {
  return { kind: 'structural', mode: 'tolerance', summary: m.detail };
}

function emptyReport(structural: StructuralMismatch, notes: readonly string[]): ToleranceReport {
  return {
    columns: [],
    rows: 0,
    comparedCells: 0,
    differingCells: 0,
    absorbedCells: 0,
    differingRows: 0,
    changedRows: 0,
    signedZeroFlips: 0,
    commentLinesChanged: 0,
    worst: null,
    epsilonUtilisation: null,
    perKey: [],
    structural,
    diffs: [],
    truncatedDiffs: 0,
    notes,
  };
}

function compareColumns(
  baseline: SeriesDocument,
  received: SeriesDocument,
): StructuralMismatch | null {
  const b = baseline.columns;
  const r = received.columns;
  if (baseline.headerless !== received.headerless) {
    return {
      kind: 'header-presence',
      detail: baseline.headerless
        ? 'baseline has no header row, received does'
        : 'received has no header row, baseline does',
      addedKeys: [],
      removedKeys: [],
    };
  }
  const bSet = new Set(b);
  const rSet = new Set(r);
  const added = r.filter((k) => !bSet.has(k));
  const removed = b.filter((k) => !rSet.has(k));
  if (added.length > 0 || removed.length > 0) {
    const parts: string[] = [];
    if (added.length > 0) parts.push(`+${added.join(', +')}`);
    if (removed.length > 0) parts.push(`-${removed.join(', -')}`);
    return {
      kind: added.length > 0 && removed.length === 0 ? 'columns-added' : 'columns-removed',
      detail: `columns changed: ${parts.join(' ')}`,
      addedKeys: added,
      removedKeys: removed,
    };
  }
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== r[i]) {
      return {
        kind: 'columns-reordered',
        detail:
          `column order changed at position ${i + 1}: ` +
          `${String(b[i])} -> ${String(r[i])}`,
        addedKeys: [],
        removedKeys: [],
      };
    }
  }
  return null;
}

export function compareTolerance(
  baselineText: string,
  receivedText: string,
  mode: ToleranceMode,
  options: ToleranceOptions = {},
): ToleranceCompareResult {
  const parseOpts = {
    delimiter: options.delimiter ?? (',' as SeriesDelimiter),
    maxRows: options.maxRows ?? 1_000_000,
  };
  const maxSeriesPoints = options.maxSeriesPoints ?? 20_000;
  const maxCellDiffs = options.maxCellDiffs ?? 50;
  const notes: string[] = [];

  const baseParse = parseSeries(baselineText, parseOpts);
  if (!baseParse.ok) {
    const m: StructuralMismatch = {
      kind: 'parse-error',
      detail: `baseline is not a readable series: line ${baseParse.error.line}: ${baseParse.error.message}`,
      addedKeys: [],
      removedKeys: [],
    };
    return { verdict: structuralVerdict(m), report: emptyReport(m, notes) };
  }
  const recvParse = parseSeries(receivedText, parseOpts);
  if (!recvParse.ok) {
    const m: StructuralMismatch = {
      kind: 'parse-error',
      detail: `received is not a readable series: line ${recvParse.error.line}: ${recvParse.error.message}`,
      addedKeys: [],
      removedKeys: [],
    };
    return { verdict: structuralVerdict(m), report: emptyReport(m, notes) };
  }

  const baseline = baseParse.doc;
  const received = recvParse.doc;

  const columnMismatch = compareColumns(baseline, received);
  if (columnMismatch !== null) {
    return {
      verdict: structuralVerdict(columnMismatch),
      report: emptyReport(columnMismatch, notes),
    };
  }
  if (baseline.rows.length !== received.rows.length) {
    const m: StructuralMismatch = {
      kind: 'row-count',
      detail: `row count changed: ${baseline.rows.length} -> ${received.rows.length}`,
      addedKeys: [],
      removedKeys: [],
    };
    return { verdict: structuralVerdict(m), report: emptyReport(m, notes) };
  }

  if (mode.columns !== undefined) {
    const missing = mode.columns.filter((c) => !baseline.columns.includes(c));
    if (missing.length > 0) {
      notes.push(
        `declared tolerance columns not present in the series: ${missing.join(', ')}`,
      );
    }
  }

  // Comments are text. They are compared in order and never contribute a
  // numeric delta; `# vibes-volatile:` lines were dropped at parse time.
  let commentLinesChanged = 0;
  const commentCount = Math.max(baseline.comments.length, received.comments.length);
  for (let i = 0; i < commentCount; i++) {
    if (baseline.comments[i]?.text !== received.comments[i]?.text) commentLinesChanged++;
  }

  const columns = baseline.columns;
  const rowCount = baseline.rows.length;
  const retainSeries = rowCount <= maxSeriesPoints;
  const accumulators: KeyAccumulator[] = columns.map((key) => ({
    key,
    budget: budgetFor(mode, key),
    compared: 0,
    differing: 0,
    absorbed: 0,
    worstAbsDelta: 0,
    worstRow: null,
    worstUtilisation: null,
    numericBaseline: retainSeries ? [] : null,
    numericReceived: retainSeries ? [] : null,
  }));

  const diffs: CellDifference[] = [];
  let differingCells = 0;
  let absorbedCells = 0;
  let comparedCells = 0;
  let signedZeroFlips = 0;
  let differingRows = 0;
  let changedRows = 0;
  let worst: WorstDeviation | null = null;
  let worstScore = -1;
  let epsilonUtilisation: number | null = null;

  // The retained sample is the first `maxCellDiffs` differences in FILE order,
  // not the N most severe: ranking would mean buffering every difference (a
  // 200k-row file can produce 800k of them), and the worst cell is reported
  // separately as `worst`, so nothing is lost by reading in file order.
  const pushDiff = (d: CellDifference): void => {
    if (diffs.length < maxCellDiffs) diffs.push(d);
  };

  for (let row = 0; row < rowCount; row++) {
    const bRow = baseline.rows[row] ?? [];
    const rRow = received.rows[row] ?? [];
    let rowDiffers = false;
    let rowChanged = false;

    for (let c = 0; c < columns.length; c++) {
      const acc = accumulators[c];
      if (acc === undefined) continue;
      const bRaw = bRow[c] ?? '';
      const rRaw = rRow[c] ?? '';
      comparedCells++;
      acc.compared++;

      const bCell = classifyCell(bRaw);
      const rCell = classifyCell(rRaw);

      if (acc.numericBaseline !== null && acc.numericReceived !== null) {
        if (bCell.kind === 'number' && rCell.kind === 'number') {
          acc.numericBaseline.push(bCell.value);
          acc.numericReceived.push(rCell.value);
        } else {
          // A polyline cannot cross a gap or a NaN; drop the whole series
          // rather than inventing a point.
          acc.numericBaseline = null;
          acc.numericReceived = null;
        }
      }

      if (bRaw === rRaw) continue; // identical text: nothing to classify.
      rowChanged = true;

      const record = (reason: CellDiffReason, delta: number | null, allowed: number | null): void => {
        differingCells++;
        acc.differing++;
        rowDiffers = true;
        pushDiff({ key: acc.key, row, baseline: bRaw, received: rRaw, delta, allowed, reason });
      };

      if (acc.budget.exactRequired) {
        record('text', null, null);
        continue;
      }
      if (bCell.kind === 'gap' || rCell.kind === 'gap') {
        // A blank became a reading, or a reading became blank. Never numeric.
        record('gap', null, null);
        continue;
      }
      if (bCell.kind === 'text' || rCell.kind === 'text') {
        record('text', null, null);
        continue;
      }
      if (bCell.kind === 'non-finite' || rCell.kind === 'non-finite') {
        // NaN and Infinity cannot be subtracted into a meaningful delta:
        // |NaN - 1| > eps is false and |Inf - Inf| is NaN, so any arithmetic
        // path here reports a fault as "within tolerance".
        record('non-finite', null, null);
        continue;
      }

      const bVal = bCell.value;
      const rVal = rCell.value;
      const delta = Math.abs(bVal - rVal);
      const allowed = Math.max(
        acc.budget.abs,
        acc.budget.rel * Math.max(Math.abs(bVal), Math.abs(rVal)),
      );

      if (delta === 0) {
        if (!Object.is(bVal, rVal)) {
          // -0 vs 0. With no budget this is a numeric identity failure; with a
          // budget it is inside it, but it is counted and named either way.
          signedZeroFlips++;
          if (allowed === 0) {
            record('signed-zero', 0, 0);
            continue;
          }
          absorbedCells++;
          acc.absorbed++;
          continue;
        }
        // Same value, different spelling (1.0 vs 1). Absorbed by definition.
        absorbedCells++;
        acc.absorbed++;
        continue;
      }

      const utilisation = allowed > 0 ? delta / allowed : null;
      if (utilisation !== null) {
        epsilonUtilisation =
          epsilonUtilisation === null ? utilisation : Math.max(epsilonUtilisation, utilisation);
      }
      if (delta > acc.worstAbsDelta) {
        acc.worstAbsDelta = delta;
        acc.worstRow = row;
        acc.worstUtilisation = utilisation;
      }
      // Score orders "how far over budget" first; cells with no budget at all
      // sort above every bounded cell, because an unbudgeted difference is an
      // outright failure rather than a fraction of an allowance.
      const score = allowed > 0 ? delta / allowed : Number.POSITIVE_INFINITY;
      if (score > worstScore) {
        worstScore = score;
        worst = {
          key: acc.key,
          row,
          baseline: bRaw,
          received: rRaw,
          delta,
          allowed: allowed > 0 ? allowed : null,
          utilisation,
        };
      }

      if (delta <= allowed) {
        absorbedCells++;
        acc.absorbed++;
        continue;
      }
      record('over-epsilon', delta, allowed);
    }

    if (rowDiffers) differingRows++;
    if (rowChanged) changedRows++;
  }

  const perKey: KeyDeviation[] = accumulators.map((a) => ({
    key: a.key,
    epsilonAbs: a.budget.abs,
    epsilonRel: a.budget.rel,
    exactRequired: a.budget.exactRequired,
    comparedCells: a.compared,
    differingCells: a.differing,
    absorbedCells: a.absorbed,
    worstAbsDelta: a.worstAbsDelta,
    worstRow: a.worstRow,
    utilisation: a.worstUtilisation,
    baselineSeries: a.numericBaseline,
    receivedSeries: a.numericReceived,
  }));

  if (!retainSeries) {
    notes.push(`series arrays omitted: ${rowCount} rows exceeds the ${maxSeriesPoints}-point budget`);
  }
  if (
    epsilonUtilisation !== null &&
    epsilonUtilisation < 0.01 &&
    absorbedCells + differingCells > 0
  ) {
    // The computable form of "this tolerance is set so wide it can never fail".
    notes.push(
      `epsilon-unused: the worst absorbed deviation consumed ${(epsilonUtilisation * 100).toFixed(2)}% of the declared budget`,
    );
  }

  const truncatedDiffs = Math.max(0, differingCells - diffs.length);
  if (truncatedDiffs > 0) {
    notes.push(
      `${truncatedDiffs} further differing cell(s) not itemised; the sample is the ` +
        'first ' + String(maxCellDiffs) + ' in file order and `worst` is the extreme',
    );
  }

  const report: ToleranceReport = {
    columns,
    rows: rowCount,
    comparedCells,
    differingCells,
    absorbedCells,
    differingRows,
    changedRows,
    signedZeroFlips,
    commentLinesChanged,
    worst,
    epsilonUtilisation,
    perKey,
    structural: null,
    diffs,
    truncatedDiffs,
    notes,
  };

  const verdict = verdictFor(report, baselineText === receivedText);
  return { verdict, report };
}

function verdictFor(report: ToleranceReport, textIdentical: boolean): Verdict {
  const worstText =
    report.worst === null
      ? ''
      : `; worst |Δ| ${fmt(report.worst.delta)} on ${report.worst.key} (row ${report.worst.row})` +
        (report.worst.utilisation === null
          ? ' with no epsilon budget'
          : ` = ${fmt(report.worst.utilisation * 100)}% of epsilon`);

  if (report.differingCells > 0) {
    const summary =
      `${report.differingRows} of ${report.rows} rows differ beyond tolerance ` +
      `(${report.differingCells} cells)${worstText}`;
    return {
      kind: 'different',
      mode: 'tolerance',
      summary,
      ...(report.epsilonUtilisation === null
        ? {}
        : { epsilonUtilisation: report.epsilonUtilisation }),
    };
  }

  if (report.commentLinesChanged > 0) {
    return {
      kind: 'different',
      mode: 'tolerance',
      summary:
        `numeric series within tolerance, but ${report.commentLinesChanged} ` +
        `comment line(s) changed`,
      ...(report.epsilonUtilisation === null
        ? {}
        : { epsilonUtilisation: report.epsilonUtilisation }),
    };
  }

  if (textIdentical) {
    return { kind: 'identical', mode: 'tolerance', summary: 'byte-identical' };
  }

  if (report.absorbedCells === 0) {
    // Bytes differ but no data cell does: blank lines, CRLF, volatile preamble.
    return {
      kind: 'equivalent',
      mode: 'tolerance',
      summary: 'no data cell differs; the byte difference is outside the compared series',
    };
  }

  const zeroNote =
    report.signedZeroFlips > 0 ? `; ${report.signedZeroFlips} signed-zero flip(s)` : '';
  const summary =
    `${report.changedRows} of ${report.rows} rows differ within tolerance ` +
    `(${report.absorbedCells} cells)${worstText}${zeroNote}`;
  return {
    kind: 'equivalent',
    mode: 'tolerance',
    summary,
    ...(report.epsilonUtilisation === null ? {} : { epsilonUtilisation: report.epsilonUtilisation }),
  };
}
