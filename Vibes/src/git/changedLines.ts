/**
 * Per-file line detail.
 *
 * The one trap here is the hunk header. `@@ -1,0 +2 @@` is a REAL header git
 * emits whenever a side's length is 1 — the count is omitted, not written as
 * `,1`. A regex that requires the comma silently drops those hunks, so a
 * one-line change reads as no change at all. That is why the count groups are
 * optional and why there is a regression test for exactly this string.
 */

import type { RepoPath } from '../types.js';
import type { GitRepo } from './repo.js';

/** Both count groups optional — see the file header. */
export const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ChangedLine {
  /** 1-based line number: in the NEW file for additions, the OLD for removals. */
  readonly line: number;
  readonly text: string;
}

export interface LineChanges {
  readonly added: readonly ChangedLine[];
  readonly removed: readonly ChangedLine[];
  readonly hunks: number;
  /** git refused to produce a text diff. Line detail is unavailable, not empty. */
  readonly binary: boolean;
  /** Line detail was capped. Callers must not treat the lists as complete. */
  readonly truncated: boolean;
  readonly modeChanged: boolean;
  readonly renamedFrom: RepoPath | null;
}

export interface ParseDiffOptions {
  /** Hard cap on retained lines per side. Prevents a 6 MB rewrite eating heap. */
  readonly maxLines?: number;
}

const EMPTY: LineChanges = {
  added: [],
  removed: [],
  hunks: 0,
  binary: false,
  truncated: false,
  modeChanged: false,
  renamedFrom: null,
};

export function parseUnifiedDiff(text: string, opts: ParseDiffOptions = {}): LineChanges {
  if (text === '') return EMPTY;
  const maxLines = opts.maxLines ?? 20_000;

  const added: ChangedLine[] = [];
  const removed: ChangedLine[] = [];
  let hunks = 0;
  let binary = false;
  let truncated = false;
  let modeChanged = false;
  let renamedFrom: RepoPath | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of text.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = HUNK_RE.exec(raw);
      if (m !== null) {
        hunks += 1;
        oldLine = Number(m[1]);
        newLine = Number(m[3]);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) {
      // Header region: everything before the first hunk.
      if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
        binary = true;
      } else if (raw.startsWith('old mode ') || raw.startsWith('new mode ')) {
        modeChanged = true;
      } else if (raw.startsWith('rename from ')) {
        renamedFrom = raw.slice('rename from '.length);
      }
      continue;
    }
    if (raw === '') continue;
    // `\ No newline at end of file` is a marker, not content.
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('diff --git ')) {
      // A second file in the same output (multi-path diff). Reset the counters
      // rather than attributing its lines to the previous file's numbering.
      inHunk = false;
      continue;
    }
    const kind = raw[0];
    const body = raw.slice(1);
    if (kind === '+') {
      if (added.length < maxLines) added.push({ line: newLine, text: body });
      else truncated = true;
      newLine += 1;
    } else if (kind === '-') {
      if (removed.length < maxLines) removed.push({ line: oldLine, text: body });
      else truncated = true;
      oldLine += 1;
    } else if (kind === ' ') {
      oldLine += 1;
      newLine += 1;
    }
  }

  return { added, removed, hunks, binary, truncated, modeChanged, renamedFrom };
}

export interface ChangedLinesOptions extends ParseDiffOptions {
  /**
   * The file is untracked, so there is no base side. git is asked for a
   * `--no-index` diff against /dev/null instead; a plain `git diff <base>`
   * would return nothing at all and the file would read as unchanged.
   */
  readonly untracked?: boolean;
}

export async function changedLinesFor(
  repo: GitRepo,
  base: string,
  path: RepoPath,
  opts: ChangedLinesOptions = {},
): Promise<LineChanges> {
  if (opts.untracked === true) {
    const r = await repo.exec(
      [
        'diff',
        '--no-index',
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        '/dev/null',
        path,
      ],
      // --no-index exits 1 when the files differ, which is the normal case.
      { allowCodes: [0, 1], strictFatal: false },
    );
    return parseUnifiedDiff(r.stdout.toString('utf8'), opts);
  }
  const text = await repo.diffUnified(base, path, { unified: 0 });
  return parseUnifiedDiff(text, opts);
}

/**
 * True when every changed line — added AND removed — matches at least one
 * pattern, and something actually changed.
 *
 * Two deliberate refusals:
 *  * A binary or truncated diff is NEVER cosmetic: we did not see the lines, so
 *    we cannot claim they were comments.
 *  * A mode change or rename with no line changes is not cosmetic either; an
 *    empty change set returns false rather than vacuously true.
 *
 * The patterns are compiled by the caller from the manifest. This module
 * invents none: a regex set that matches everything would silence the entire
 * honesty check, and detecting that is the config layer's job.
 */
export function isCosmetic(
  changes: LineChanges,
  patterns: readonly RegExp[],
): boolean {
  if (patterns.length === 0) return false;
  if (changes.binary || changes.truncated) return false;
  const all = [...changes.added, ...changes.removed];
  if (all.length === 0) return false;
  return all.every((l) => patterns.some((p) => p.test(l.text)));
}
