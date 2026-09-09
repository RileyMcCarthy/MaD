/**
 * The series (CSV-ish) scanner, hand-rolled on purpose.
 *
 * WHY NOT A CSV LIBRARY: every general CSV library sniffs its dialect —
 * delimiter, quote char, header presence — from the CONTENT. That would make
 * the comparison RESULT depend on the content it is comparing: a baseline that
 * sniffs as comma-delimited and a received file that sniffs as semicolon-
 * delimited would be declared "structurally different" because of one stray
 * character in a comment. The dialect here is DECLARED by the caller and fixed
 * for both sides of every comparison.
 *
 * ON-DISK FORMAT (this is the contract a tolerance-mode producer must emit):
 *
 *     # free-form comment lines, '#' at column 0, any number, anywhere
 *     # vibes-volatile: started=2026-08-21T10:00:00Z
 *     time_us,position_um,force_mN        <- first non-comment, non-blank line
 *     0,0,0
 *     1000,25.5,3.5
 *
 *   - The FIRST non-comment, non-blank line is the header. Column names are the
 *     comparison KEYS; a cell is addressed as (column, row index).
 *   - `# vibes-volatile:` lines are excluded from comparison ENTIRELY. That is
 *     the escape hatch for wall-clock stamps and hostnames, and it is a prefix
 *     rather than a regex so it cannot be widened by accident.
 *   - Every other `#` line is compared as ordered text.
 *   - Quoting is RFC 4180 minus embedded newlines: a field may be wrapped in
 *     `"`, `""` is a literal quote. A newline inside a quoted field is REJECTED
 *     with the line number, which is what keeps the whole file line-oriented
 *     and keeps a 200k-row scan linear and allocation-light.
 *   - Blank lines carry no data and are ignored on both sides.
 *   - Duplicate, empty, or ragged columns are parse errors: they make the
 *     (column, row) key ambiguous, and an ambiguous key cannot yield an honest
 *     verdict.
 */

export const VOLATILE_PREFIX = '# vibes-volatile:';

export type SeriesDelimiter = ',' | '\t' | ';' | '|';

export interface SeriesParseOptions {
  /** Declared, never sniffed. Default ','. */
  readonly delimiter?: SeriesDelimiter;
  /** Hard cap so a runaway producer cannot exhaust memory. Default 1e6. */
  readonly maxRows?: number;
}

export interface SeriesComment {
  /** Position among the non-volatile comments, for ordered comparison. */
  readonly index: number;
  readonly line: number;
  readonly text: string;
}

export interface SeriesDocument {
  readonly columns: readonly string[];
  /** Raw cell text, unquoted. Never coerced to a number here — `Number('')` is
   *  0, and that coercion is precisely how a missing reading becomes a
   *  confident 0.000. Classification happens at compare time. */
  readonly rows: readonly (readonly string[])[];
  /** Non-volatile comments, in file order. */
  readonly comments: readonly SeriesComment[];
  readonly volatileComments: readonly SeriesComment[];
  readonly delimiter: SeriesDelimiter;
  /** True when no header line was found (file was empty or all comments). */
  readonly headerless: boolean;
}

export interface SeriesParseError {
  readonly line: number;
  readonly column: number | null;
  readonly message: string;
}

export type SeriesParseResult =
  | { readonly ok: true; readonly doc: SeriesDocument }
  | { readonly ok: false; readonly error: SeriesParseError };

/** Split a single line into fields. Returns null with a message on failure. */
function scanLine(
  line: string,
  delimiter: string,
  lineNo: number,
): { fields: string[] } | { error: SeriesParseError } {
  const fields: string[] = [];
  let i = 0;
  const n = line.length;
  while (true) {
    // Start of a field.
    if (i < n && line.charCodeAt(i) === 0x22 /* " */) {
      let value = '';
      i++;
      let closed = false;
      while (i < n) {
        const ch = line.charCodeAt(i);
        if (ch === 0x22) {
          if (i + 1 < n && line.charCodeAt(i + 1) === 0x22) {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += line[i];
        i++;
      }
      if (!closed) {
        return {
          error: {
            line: lineNo,
            column: i + 1,
            message:
              'unterminated quoted field (a newline inside a quoted field is not ' +
              'permitted in a vibes series file)',
          },
        };
      }
      if (i < n && line[i] !== delimiter) {
        return {
          error: {
            line: lineNo,
            column: i + 1,
            message: `unexpected character ${JSON.stringify(line[i])} after a closing quote`,
          },
        };
      }
      fields.push(value);
    } else {
      let end = line.indexOf(delimiter, i);
      if (end === -1) end = n;
      fields.push(line.slice(i, end));
      i = end;
    }
    if (i >= n) return { fields };
    // Sitting on a delimiter; consume it and start the next field.
    i++;
    if (i === n) {
      // Trailing delimiter means a final empty field, which is real data.
      fields.push('');
      return { fields };
    }
  }
}

export function parseSeries(
  text: string,
  options: SeriesParseOptions = {},
): SeriesParseResult {
  const delimiter: SeriesDelimiter = options.delimiter ?? ',';
  const maxRows = options.maxRows ?? 1_000_000;

  const rawLines = text.split('\n');
  const comments: SeriesComment[] = [];
  const volatileComments: SeriesComment[] = [];
  const rows: string[][] = [];
  let columns: string[] | null = null;

  for (let idx = 0; idx < rawLines.length; idx++) {
    const lineNo = idx + 1;
    let line = rawLines[idx] ?? '';
    // Strip a trailing CR so a CRLF file scans identically to an LF one. The
    // EOL difference is still visible to exact mode; here it carries no data.
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;

    if (line.charCodeAt(0) === 0x23 /* # */) {
      if (line.startsWith(VOLATILE_PREFIX)) {
        volatileComments.push({ index: volatileComments.length, line: lineNo, text: line });
      } else {
        comments.push({ index: comments.length, line: lineNo, text: line });
      }
      continue;
    }

    const scanned = scanLine(line, delimiter, lineNo);
    if ('error' in scanned) return { ok: false, error: scanned.error };

    if (columns === null) {
      const seen = new Set<string>();
      for (let c = 0; c < scanned.fields.length; c++) {
        const name = scanned.fields[c] ?? '';
        if (name.length === 0) {
          return {
            ok: false,
            error: {
              line: lineNo,
              column: c + 1,
              message: `empty column name at position ${c + 1}; a series key must be nameable`,
            },
          };
        }
        if (seen.has(name)) {
          return {
            ok: false,
            error: {
              line: lineNo,
              column: c + 1,
              message: `duplicate column name ${JSON.stringify(name)}; the (column, row) key would be ambiguous`,
            },
          };
        }
        seen.add(name);
      }
      columns = scanned.fields;
      continue;
    }

    if (scanned.fields.length !== columns.length) {
      return {
        ok: false,
        error: {
          line: lineNo,
          column: null,
          message: `row has ${scanned.fields.length} cells, header declares ${columns.length}`,
        },
      };
    }
    if (rows.length >= maxRows) {
      return {
        ok: false,
        error: {
          line: lineNo,
          column: null,
          message: `series exceeds the ${maxRows}-row budget`,
        },
      };
    }
    rows.push(scanned.fields);
  }

  return {
    ok: true,
    doc: {
      columns: columns ?? [],
      rows,
      comments,
      volatileComments,
      delimiter,
      headerless: columns === null,
    },
  };
}

/* ─────────────────────────── cell classification ───────────────────────── */

export type CellKind = 'gap' | 'number' | 'non-finite' | 'text';

export interface CellValue {
  readonly kind: CellKind;
  /** Only meaningful when kind === 'number' or 'non-finite'. */
  readonly value: number;
}

const GAP: CellValue = { kind: 'gap', value: Number.NaN };

/**
 * Classify a raw cell.
 *
 * THE TRAP: `Number('')` is 0 and `Number('  ')` is 0. A blank cell — a force
 * reading the device never sent — would silently become a confident 0.000 N and
 * compare inside any epsilon. Blank is therefore classified BEFORE any Number()
 * call, and a gap on one side only is always a change.
 */
export function classifyCell(raw: string): CellValue {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return GAP;

  // Explicit tokens first: `Number('Infinity')` works but `Number('inf')` is
  // NaN, and we want the spelling to be part of the comparison, not the value.
  if (trimmed === 'NaN') return { kind: 'non-finite', value: Number.NaN };
  if (trimmed === 'Infinity' || trimmed === '+Infinity') {
    return { kind: 'non-finite', value: Number.POSITIVE_INFINITY };
  }
  if (trimmed === '-Infinity') return { kind: 'non-finite', value: Number.NEGATIVE_INFINITY };

  const n = Number(trimmed);
  if (Number.isNaN(n)) return { kind: 'text', value: Number.NaN };
  if (!Number.isFinite(n)) return { kind: 'non-finite', value: n };
  return { kind: 'number', value: n };
}
