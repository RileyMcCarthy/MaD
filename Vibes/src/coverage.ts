/**
 * Patch coverage: of the lines THIS change added, which never ran.
 *
 * Repo-wide coverage is a number nobody acts on — it barely moves and it
 * describes code the author did not touch. The added-but-unexercised lines are
 * the part someone can do something about, and they are the forcing function
 * for writing the behaviours in the first place.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Coverage } from './report.js';

/** lcov `DA:line,hits`. ABSENT means the line was never instrumented — a
 *  comment, a type, a file coverage never loaded. That is NOT the same as
 *  `hits === 0`, which means instrumented and never executed. Collapsing the
 *  two misreports in both directions, so they stay separate here. */
function parseLcov(text: string, prefix: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const p = line.slice(3).trim();
      const key = p.startsWith('/') ? p : `${prefix}${p}`;
      current = new Map();
      files.set(key, current);
    } else if (line.startsWith('DA:') && current !== null) {
      const [n, h] = line.slice(3).split(',');
      if (n !== undefined && h !== undefined) current.set(Number(n), Number(h));
    }
  }
  return files;
}

/** Added line numbers per file, from a unified diff with zero context. */
export function addedLines(repoRoot: string, base: string): Map<string, number[]> {
  const diff = execFileSync('git', ['diff', '-U0', `${base}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const out = new Map<string, number[]>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6).trim();
      if (file !== '/dev/null') out.set(file, []);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m?.[1] !== undefined && file !== null && file !== '/dev/null') {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const list = out.get(file);
      if (list !== undefined) for (let i = 0; i < count; i += 1) list.push(start + i);
    }
  }
  return out;
}

export interface LcovSource {
  /** Path to an lcov tracefile. */
  readonly path: string;
  /** Repo-relative directory its `SF:` paths are relative to, e.g. `Software/Control/`. */
  readonly prefix: string;
}

/**
 * @param interesting Only these files are scored. Test files and generated code
 *   are excluded by the caller — counting a test file's own added lines as
 *   "unspecified" is noise, and generated code is not authored.
 */
export function patchCoverage(
  repoRoot: string,
  base: string,
  sources: readonly LcovSource[],
  interesting: (file: string) => boolean,
): Coverage | null {
  const present = sources.filter((s) => existsSync(s.path));
  if (present.length === 0) return null;

  const cov = new Map<string, Map<number, number>>();
  for (const s of present) {
    for (const [f, lines] of parseLcov(readFileSync(s.path, 'utf8'), s.prefix)) cov.set(f, lines);
  }

  let covered = 0;
  let uncovered = 0;
  const unmeasured: string[] = [];
  const worst: [string, number][] = [];

  for (const [file, lines] of addedLines(repoRoot, base)) {
    if (!interesting(file)) continue;
    const m = cov.get(file);
    if (m === undefined) {
      // Named, never counted as covered: coverage not mentioning a file is not
      // evidence that the file ran.
      unmeasured.push(file);
      continue;
    }
    let u = 0;
    for (const ln of lines) {
      const hits = m.get(ln);
      if (hits === undefined) continue; // uninstrumented, not uncovered
      if (hits > 0) covered += 1;
      else {
        uncovered += 1;
        u += 1;
      }
    }
    if (u > 0) worst.push([file, u]);
  }

  worst.sort((a, b) => b[1] - a[1]);
  return { covered, uncovered, unmeasuredFiles: unmeasured.sort(), worst };
}
