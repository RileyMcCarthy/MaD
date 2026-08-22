/**
 * The emit budget and its ledger.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: silent truncation reads as "covered
 * everything". Every byte this module refuses to emit is recorded as a
 * `Truncation`, rendered inside the report itself, AND handed to `log()`. A
 * reader must never be able to mistake "we ran out of room" for "there was
 * nothing more to say".
 */

/**
 * The ONE definition of every emit-side ceiling. §4.13: a single budget object
 * is constructed once and threaded through. No other module declares its own.
 *
 * The numbers are not arbitrary:
 *  - GitHub refuses to RENDER a markdown file over 512 KB, so 96 KB leaves
 *    room to be wrong about the estimate and still render.
 *  - `$GITHUB_STEP_SUMMARY` caps at 1 MiB and silently drops the WHOLE summary
 *    past it — the failure is total, so the margin is large.
 *  - The HTML is an uploaded artifact; 4 MB keeps it openable on a laptop.
 */
export interface EmitBudget {
  readonly markdownMaxBytes: number;
  readonly stepSummaryMaxBytes: number;
  readonly htmlMaxBytes: number;
  /** Snapshot files rendered with full diffs before the rest become a roster. */
  readonly maxRenderedFiles: number;
  /** How many of those are expanded rather than behind a `<details>`. */
  readonly expandFirstNFiles: number;
  /** Longest path list printed before it becomes "and N more". */
  readonly maxPathsPerList: number;
  /** Bytes of producer log tail shown for a failed producer. */
  readonly maxLogTailBytes: number;
}

export const DEFAULT_EMIT_BUDGET: EmitBudget = Object.freeze({
  markdownMaxBytes: 96_000,
  stepSummaryMaxBytes: 900_000,
  htmlMaxBytes: 4_000_000,
  maxRenderedFiles: 200,
  expandFirstNFiles: 5,
  maxPathsPerList: 50,
  maxLogTailBytes: 4_000,
});

export interface Truncation {
  /** Report section or file the truncation happened in. */
  readonly where: string;
  /** What was left out, in the reader's terms ("12 changed files"). */
  readonly what: string;
  /** Which ceiling caused it, named so it can be raised deliberately. */
  readonly limit: string;
}

export class TruncationLedger {
  private readonly entries: Truncation[] = [];
  private readonly sink: ((line: string) => void) | null;

  constructor(sink?: (line: string) => void) {
    this.sink = sink ?? null;
  }

  record(t: Truncation): void {
    this.entries.push(t);
    // Both surfaces, always. The in-report note is for the reviewer; the log
    // line is for whoever has to decide whether to raise the ceiling.
    this.sink?.(`vibes: truncated in ${t.where}: ${t.what} (limit: ${t.limit})`);
  }

  get all(): readonly Truncation[] {
    return this.entries;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** One sentence for the banner, so truncation is visible above the fold. */
  summary(): string | null {
    if (this.entries.length === 0) return null;
    const what = this.entries.map((e) => e.what);
    const head = what.slice(0, 3).join('; ');
    const more = what.length > 3 ? `; and ${what.length - 3} more` : '';
    return `This report is incomplete: ${head}${more}. See “What was left out” at the end.`;
  }
}

/**
 * Trim a list to `max` entries, returning the overflow count.
 *
 * Callers must render the overflow. There is no variant of this that silently
 * drops, on purpose.
 */
export function capList<T>(items: readonly T[], max: number): { shown: readonly T[]; hidden: number } {
  if (items.length <= max) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, max), hidden: items.length - max };
}

/** Keep the TAIL of a log: errors live at the end. */
export function tailBytes(text: string, maxBytes: number): { text: string; dropped: number } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, dropped: 0 };
  const kept = buf.subarray(buf.length - maxBytes).toString('utf8');
  // The first character may be a split multi-byte sequence; drop the partial line.
  const nl = kept.indexOf('\n');
  const trimmed = nl >= 0 ? kept.slice(nl + 1) : kept;
  return { text: trimmed, dropped: buf.length - Buffer.byteLength(trimmed, 'utf8') };
}
