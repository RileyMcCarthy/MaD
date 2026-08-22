/**
 * Hand-rolled HTML diff tables.
 *
 * WHY not diff2html: its collapse control is inert without a 90 KB–1 MB UI
 * bundle (its stylesheet ships no `:checked` rules at all), its markup runs
 * roughly 18x the size of the patch against a 4 MB artifact budget, and it
 * consumes a unified-diff STRING — forcing a patch → text → reparse round trip
 * for data we already hold structured. Roughly 250 lines of table markup buys
 * back all three. If that trade ever flips, this file is the drop-in seam.
 *
 * WHY tables and not `<pre>`: line numbers. A behaviour diff is read by
 * pointing at a row, and a `<pre>` block has no rows to point at.
 */

import { diffWordsWithSpace } from 'diff';
import type { Patch, PatchHunk } from '../render/index.js';
import { escapeHtml } from './escape.js';

/** Beyond this, word-level highlighting costs more than it explains. */
const INTRALINE_MAX_LINE_CHARS = 400;
const INTRALINE_MAX_PAIRS = 200;

type Kind = 'ctx' | 'del' | 'add' | 'meta';

interface Row {
  readonly kind: Kind;
  readonly oldNo: number | null;
  readonly newNo: number | null;
  readonly text: string;
}

/** Split a hunk into typed rows with real line numbers on both sides. */
export function hunkRows(hunk: PatchHunk): Row[] {
  const rows: Row[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const raw of hunk.lines) {
    const marker = raw[0] ?? ' ';
    const text = raw.slice(1);
    if (marker === '\\') {
      // "\ No newline at end of file" — a real, reportable property.
      rows.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
    } else if (marker === '-') {
      rows.push({ kind: 'del', oldNo, newNo: null, text });
      oldNo += 1;
    } else if (marker === '+') {
      rows.push({ kind: 'add', oldNo: null, newNo, text });
      newNo += 1;
    } else {
      rows.push({ kind: 'ctx', oldNo, newNo, text });
      oldNo += 1;
      newNo += 1;
    }
  }
  return rows;
}

/**
 * Pair deletions with additions inside one change group so word-level marks
 * line up. Unequal group sizes are left unpaired — inventing a pairing across
 * a 3-for-1 rewrite produces highlighting that is confidently wrong.
 */
function pairChanges(rows: readonly Row[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i]?.kind !== 'del') {
      i += 1;
      continue;
    }
    let d = i;
    while (rows[d]?.kind === 'del') d += 1;
    let a = d;
    while (rows[a]?.kind === 'add') a += 1;
    const dels = d - i;
    const adds = a - d;
    if (dels === adds && dels > 0) {
      for (let k = 0; k < dels; k += 1) pairs.set(i + k, d + k);
    }
    i = a > i ? a : i + 1;
  }
  return pairs;
}

interface Marked {
  readonly oldHtml: string;
  readonly newHtml: string;
}

function markWords(oldText: string, newText: string): Marked {
  if (
    oldText.length > INTRALINE_MAX_LINE_CHARS ||
    newText.length > INTRALINE_MAX_LINE_CHARS
  ) {
    return { oldHtml: escapeHtml(oldText), newHtml: escapeHtml(newText) };
  }
  const parts = diffWordsWithSpace(oldText, newText);
  let oldHtml = '';
  let newHtml = '';
  for (const p of parts) {
    const esc = escapeHtml(p.value);
    if (p.added) newHtml += `<mark class="w">${esc}</mark>`;
    else if (p.removed) oldHtml += `<mark class="w">${esc}</mark>`;
    else {
      oldHtml += esc;
      newHtml += esc;
    }
  }
  return { oldHtml, newHtml };
}

export interface DiffTableOptions {
  readonly view?: 'unified' | 'split';
  readonly intraLine?: 'word' | 'none';
}

export function diffTableHtml(patch: Patch, options: DiffTableOptions = {}): string {
  const view = options.view ?? 'unified';
  const intra = options.intraLine ?? 'word';
  const out: string[] = [];
  out.push(
    `<table class="diff ${view}"><caption class="sr">Diff of ${escapeHtml(patch.newLabel)}</caption>`,
  );
  let pairsUsed = 0;

  for (const hunk of patch.hunks) {
    const rows = hunkRows(hunk);
    const pairs = intra === 'word' ? pairChanges(rows) : new Map<number, number>();
    const marked = new Map<number, string>();
    for (const [delIdx, addIdx] of pairs) {
      if (pairsUsed >= INTRALINE_MAX_PAIRS) break;
      const d = rows[delIdx];
      const a = rows[addIdx];
      if (!d || !a) continue;
      const m = markWords(d.text, a.text);
      marked.set(delIdx, m.oldHtml);
      marked.set(addIdx, m.newHtml);
      pairsUsed += 1;
    }

    out.push(
      `<tbody><tr class="hunk"><td colspan="${view === 'split' ? 4 : 3}">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</td></tr>`,
    );
    out.push(view === 'split' ? splitRows(rows, marked) : unifiedRows(rows, marked));
    out.push('</tbody>');
  }

  out.push('</table>');
  if (patch.truncated) {
    out.push(
      `<p class="note warn">Diff truncated: ${patch.droppedLines} further changed lines are not shown.</p>`,
    );
  }
  return out.join('');
}

function cell(html: string): string {
  // A zero-width space keeps an empty row from collapsing to zero height, which
  // otherwise makes a deleted blank line invisible.
  return html.length === 0 ? '&#8203;' : html;
}

function unifiedRows(rows: readonly Row[], marked: ReadonlyMap<number, string>): string {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r) continue;
    if (r.kind === 'meta') {
      out.push(`<tr class="meta"><td class="ln"></td><td class="ln"></td><td class="tx">${escapeHtml(r.text)}</td></tr>`);
      continue;
    }
    const sign = r.kind === 'del' ? '-' : r.kind === 'add' ? '+' : ' ';
    const body = marked.get(i) ?? escapeHtml(r.text);
    out.push(
      `<tr class="${r.kind}"><td class="ln">${r.oldNo ?? ''}</td><td class="ln">${r.newNo ?? ''}</td>` +
        `<td class="tx"><span class="sg">${sign}</span>${cell(body)}</td></tr>`,
    );
  }
  return out.join('');
}

function splitRows(rows: readonly Row[], marked: ReadonlyMap<number, string>): string {
  const out: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (!r) {
      i += 1;
      continue;
    }
    if (r.kind === 'ctx' || r.kind === 'meta') {
      const body = escapeHtml(r.text);
      out.push(
        `<tr class="${r.kind}"><td class="ln">${r.oldNo ?? ''}</td><td class="tx">${cell(body)}</td>` +
          `<td class="ln">${r.newNo ?? ''}</td><td class="tx">${cell(body)}</td></tr>`,
      );
      i += 1;
      continue;
    }
    // Collect the whole change group, then lay deletions and additions
    // side by side, padding the shorter column with empty cells.
    const dels: number[] = [];
    const adds: number[] = [];
    while (rows[i]?.kind === 'del') dels.push(i++);
    while (rows[i]?.kind === 'add') adds.push(i++);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k += 1) {
      const dIdx = dels[k];
      const aIdx = adds[k];
      const d = dIdx === undefined ? undefined : rows[dIdx];
      const a = aIdx === undefined ? undefined : rows[aIdx];
      const dHtml =
        d === undefined || dIdx === undefined ? '' : (marked.get(dIdx) ?? escapeHtml(d.text));
      const aHtml =
        a === undefined || aIdx === undefined ? '' : (marked.get(aIdx) ?? escapeHtml(a.text));
      out.push(
        `<tr class="pair">` +
          `<td class="ln">${d?.oldNo ?? ''}</td><td class="tx ${d ? 'del' : 'nil'}">${cell(dHtml)}</td>` +
          `<td class="ln">${a?.newNo ?? ''}</td><td class="tx ${a ? 'add' : 'nil'}">${cell(aHtml)}</td>` +
          `</tr>`,
      );
    }
  }
  return out.join('');
}
