/**
 * LCOV tracefile parser — hand-rolled, on purpose.
 *
 * The format is trivial (`PREFIX:csv` lines, sections ended by
 * `end_of_record`), but every published parser normalises away the three
 * distinctions this tool is built on:
 *
 *   1. ABSENT `DA` vs `DA:<line>,0`. Absent means the line was never
 *      instrumented — a comment, a type declaration, a blank. `DA:12,0` means
 *      the line WAS instrumented and never ran. Collapsing them turns
 *      "unmeasured" into "uncovered" (or worse, the reverse) and destroys
 *      patch coverage. `lines` therefore holds exactly the DA records.
 *
 *   2. `BRDA` taken `-` vs `0`. `-` means the enclosing block never executed,
 *      so the branch was never even evaluated; `0` means it was evaluated and
 *      never taken. Both are uncovered, but only one of them is reachable
 *      evidence about the branch itself.
 *
 *   3. The `e` exception prefix on BRDA block/branch ids (geninfo ≥ 2.0),
 *      which marks compiler-generated exception paths. Dropping it silently
 *      merges an exception branch with a real one.
 *
 * And the structural requirement: the parser is an ORDER-INDEPENDENT BAG per
 * `SF:` section, not a state machine. geninfo, istanbul and llvm-cov emit
 * their records in three different orders, and any parser that expects one
 * order mishandles at least one producer.
 */

import type { CoverageSummary, FileCoverage, RepoPath } from '../../types.js';
import type { CoverageParseResult, ParseNote } from './shared.js';
import { mapArtifactPath, type Relativizer } from '../paths.js';
import { mergeFileCoverage, sortedLineMap, type UnmappedCoveragePath } from '../model.js';

/* ─────────────────────────── the raw model ────────────────────────────── */

export interface LcovBranch {
  readonly line: number;
  /** Block id WITHOUT the exception marker. */
  readonly block: string;
  /** Branch id WITHOUT the exception marker. */
  readonly branch: string;
  /** null === the tracefile said `-`: the block never executed. */
  readonly taken: number | null;
  readonly exceptionBlock: boolean;
  readonly exceptionBranch: boolean;
}

export interface LcovFunction {
  readonly name: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly hits: number;
}

/** Counts the tracefile asserts about itself. Kept for cross-checking, never
 *  used as the answer: a producer that lies in LH is exactly what we look for. */
export interface LcovReportedCounts {
  readonly lf: number | null;
  readonly lh: number | null;
  readonly brf: number | null;
  readonly brh: number | null;
  readonly fnf: number | null;
  readonly fnh: number | null;
}

export interface LcovSection {
  /** Raw `SF:` value, exactly as written. Mapping happens later. */
  readonly file: string;
  readonly testNames: readonly string[];
  /** DA records. Absent line === uninstrumented. */
  readonly lines: ReadonlyMap<number, number>;
  readonly checksums: ReadonlyMap<number, string>;
  readonly branches: readonly LcovBranch[];
  readonly functions: readonly LcovFunction[];
  readonly reported: LcovReportedCounts;
  readonly version: string | null;
}

export interface LcovParseResult {
  readonly sections: readonly LcovSection[];
  readonly notes: readonly ParseNote[];
  /** Prefixes we did not understand, with counts. Never silently ignored. */
  readonly unknownRecords: ReadonlyMap<string, number>;
}

/* ─────────────────────────── mutable bag ──────────────────────────────── */

interface Bag {
  file: string | null;
  testNames: string[];
  lines: Map<number, number>;
  checksums: Map<number, string>;
  branches: Map<string, { line: number; block: string; branch: string; taken: number | null; eb: boolean; ebr: boolean }>;
  /** Keyed by name — FN and FNDA arrive in either order, and in either section half. */
  functions: Map<string, { name: string; startLine: number | null; endLine: number | null; hits: number }>;
  reported: { lf: number | null; lh: number | null; brf: number | null; brh: number | null; fnf: number | null; fnh: number | null };
  version: string | null;
  touched: boolean;
}

function newBag(): Bag {
  return {
    file: null,
    testNames: [],
    lines: new Map(),
    checksums: new Map(),
    branches: new Map(),
    functions: new Map(),
    reported: { lf: null, lh: null, brf: null, brh: null, fnf: null, fnh: null },
    version: null,
    touched: false,
  };
}

const BOM = '﻿';

/**
 * Parse a tracefile. Never throws on malformed records — a half-written
 * coverage file should degrade into notes plus whatever is legible, because
 * throwing loses the good sections too.
 */
export function parseLcov(text: string): LcovParseResult {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const notes: ParseNote[] = [];
  const unknown = new Map<string, number>();
  const bags: Bag[] = [];

  let bag = newBag();
  let lineNo = 0;
  let malformed = 0;

  const flush = (explicit: boolean): void => {
    if (!bag.touched && bag.file === null) return;
    if (bag.file === null) {
      notes.push({
        reason: 'parse-failed',
        severity: 'warn',
        detail: `dropped ${bag.lines.size} DA record(s) in a section with no SF: line`,
      });
    } else {
      bags.push(bag);
      if (!explicit) {
        notes.push({
          reason: 'parse-failed',
          severity: 'warn',
          detail: `section for ${bag.file} has no end_of_record; parsed to end of file`,
        });
      }
    }
    bag = newBag();
  };

  for (const rawLine of src.split(/\r?\n/)) {
    lineNo += 1;
    const line = rawLine.trim();
    if (line === '') continue;

    if (line === 'end_of_record') {
      flush(true);
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) {
      malformed += 1;
      bump(unknown, line.slice(0, 12));
      continue;
    }
    const prefix = line.slice(0, colon);
    const value = line.slice(colon + 1);

    switch (prefix) {
      case 'TN':
        // TN with an empty value is normal (`TN:`); record it anyway so a
        // multi-test tracefile can still be attributed.
        bag.touched = true;
        if (value !== '') bag.testNames.push(value);
        break;

      case 'SF': {
        // A second SF without end_of_record starts a new section.
        if (bag.file !== null) flush(false);
        bag.file = value.trim();
        bag.touched = true;
        break;
      }

      case 'VER':
        bag.version = value.trim();
        bag.touched = true;
        break;

      case 'DA': {
        // DA:<line>,<count>[,<checksum>] — checksum never contains a comma.
        const parts = splitN(value, 2);
        const ln = int(parts[0]);
        const count = int(parts[1]);
        if (ln === null || count === null) {
          malformed += 1;
          break;
        }
        bag.touched = true;
        // Duplicate DA for one line inside one section: sum. gcov emits this
        // for template instantiations, and taking the last would UNDERCOUNT.
        bag.lines.set(ln, (bag.lines.get(ln) ?? 0) + count);
        const cks = parts[2];
        if (cks !== undefined && cks !== '') bag.checksums.set(ln, cks);
        break;
      }

      case 'BRDA': {
        // BRDA:<line>,[e]<block>,[e]<branch>,<taken|->
        const parts = splitN(value, 3);
        const ln = int(parts[0]);
        const rawBlock = parts[1];
        const rawBranch = parts[2];
        const takenRaw = parts[3];
        if (ln === null || rawBlock === undefined || rawBranch === undefined || takenRaw === undefined) {
          malformed += 1;
          break;
        }
        const eb = rawBlock.startsWith('e');
        const ebr = rawBranch.startsWith('e');
        const block = eb ? rawBlock.slice(1) : rawBlock;
        const branch = ebr ? rawBranch.slice(1) : rawBranch;
        const taken = takenRaw === '-' ? null : int(takenRaw);
        if (takenRaw !== '-' && taken === null) {
          malformed += 1;
          break;
        }
        bag.touched = true;
        const key = `${ln}|${eb ? 'e' : ''}${block}|${ebr ? 'e' : ''}${branch}`;
        const prev = bag.branches.get(key);
        if (prev === undefined) {
          bag.branches.set(key, { line: ln, block, branch, taken, eb, ebr });
        } else {
          // Merging '-' with a count keeps the count: one instantiation
          // evaluated the branch, so it is NOT "never evaluated" any more.
          prev.taken = prev.taken === null ? taken : taken === null ? prev.taken : prev.taken + taken;
        }
        break;
      }

      case 'FN': {
        // Two dialects: FN:<line>,<name> (istanbul, older geninfo) and
        // FN:<start>,<end>,<name> (geninfo >= 2.0). Names can contain commas
        // (`foo<int,int>`), so split from the LEFT by a bounded count and only
        // treat field 2 as an end line when it is entirely digits.
        const two = splitN(value, 1);
        const start = int(two[0]);
        const rest = two[1] ?? '';
        if (start === null) {
          malformed += 1;
          break;
        }
        let endLine: number | null = null;
        let name = rest;
        const nextComma = rest.indexOf(',');
        if (nextComma > 0) {
          const maybeEnd = rest.slice(0, nextComma);
          if (/^\d+$/.test(maybeEnd)) {
            endLine = Number(maybeEnd);
            name = rest.slice(nextComma + 1);
          }
        }
        if (name === '') {
          malformed += 1;
          break;
        }
        bag.touched = true;
        const fn = bag.functions.get(name);
        if (fn === undefined) bag.functions.set(name, { name, startLine: start, endLine, hits: 0 });
        else {
          fn.startLine = start;
          fn.endLine = endLine;
        }
        break;
      }

      case 'FNDA': {
        // FNDA:<count>,<name> — the name is everything after the FIRST comma.
        const two = splitN(value, 1);
        const hits = int(two[0]);
        const name = two[1] ?? '';
        if (hits === null || name === '') {
          malformed += 1;
          break;
        }
        bag.touched = true;
        const fn = bag.functions.get(name);
        if (fn === undefined) bag.functions.set(name, { name, startLine: null, endLine: null, hits });
        else fn.hits += hits;
        break;
      }

      case 'LF':
      case 'LH':
      case 'BRF':
      case 'BRH':
      case 'FNF':
      case 'FNH': {
        const n = int(value.trim());
        if (n === null) {
          malformed += 1;
          break;
        }
        bag.touched = true;
        const key = prefix.toLowerCase() as 'lf' | 'lh' | 'brf' | 'brh' | 'fnf' | 'fnh';
        bag.reported[key] = n;
        break;
      }

      default:
        // FNL/FNA (geninfo 2.x index form) and anything else: counted, named,
        // never fatal. A tracefile we half-understand is still evidence.
        bump(unknown, prefix);
        break;
    }
    void lineNo;
  }
  flush(false);

  if (malformed > 0) {
    notes.push({ reason: 'parse-failed', severity: 'warn', detail: `${malformed} malformed record(s) skipped` });
  }
  for (const [prefix, count] of unknown) {
    notes.push({ reason: 'unsupported-format', severity: 'info', detail: `${count} unsupported '${prefix}' record(s)` });
  }

  const sections = bags.map(freeze);
  for (const s of sections) {
    const computedLh = countHit(s.lines);
    if (s.reported.lh !== null && s.reported.lh !== computedLh) {
      notes.push({
        reason: 'count-mismatch',
        severity: 'warn',
        detail: `${s.file}: LH says ${s.reported.lh}, DA records say ${computedLh}`,
      });
    }
    if (s.reported.lf !== null && s.reported.lf !== s.lines.size) {
      notes.push({
        reason: 'count-mismatch',
        severity: 'warn',
        detail: `${s.file}: LF says ${s.reported.lf}, DA records say ${s.lines.size}`,
      });
    }
  }

  return { sections, notes, unknownRecords: unknown };
}

function freeze(b: Bag): LcovSection {
  const branches = [...b.branches.values()]
    .sort((x, y) => x.line - y.line || cmp(x.block, y.block) || cmp(x.branch, y.branch))
    .map((x) => ({
      line: x.line,
      block: x.block,
      branch: x.branch,
      taken: x.taken,
      exceptionBlock: x.eb,
      exceptionBranch: x.ebr,
    }));
  const functions = [...b.functions.values()]
    .sort((x, y) => cmp(x.name, y.name))
    .map((x) => ({ name: x.name, startLine: x.startLine, endLine: x.endLine, hits: x.hits }));
  return {
    file: b.file ?? '',
    testNames: b.testNames,
    lines: sortedLineMap(b.lines),
    checksums: b.checksums,
    branches,
    functions,
    reported: b.reported,
    version: b.version,
  };
}

/* ────────────────────── raw sections → CoverageSummary ────────────────── */

export interface LcovToCoverageOptions {
  readonly relativize: Relativizer;
  readonly repoRoot: string;
  /** Absolute anchor for relative `SF:` values. */
  readonly sourceRootAbs: string;
  readonly sourceLabel: string;
  readonly artifactPath: string;
  readonly stale: boolean;
  readonly trackedPaths?: ReadonlySet<RepoPath> | undefined;
}

/**
 * `branchesTotal` counts every BRDA record, including the `-` ones: a branch
 * whose block never ran is instrumented-and-uncovered, so it belongs in the
 * denominator. Excluding it would make dead code improve the branch rate.
 */
export function lcovToCoverage(parsed: LcovParseResult, opts: LcovToCoverageOptions): CoverageParseResult {
  const notes: ParseNote[] = [...parsed.notes];
  const unmapped: UnmappedCoveragePath[] = [];
  const byPath = new Map<RepoPath, FileCoverage[]>();
  let fallbackCount = 0;

  for (const section of parsed.sections) {
    if (section.file === '') continue;
    const mapped = mapArtifactPath(section.file, {
      relativize: opts.relativize,
      repoRoot: opts.repoRoot,
      anchorAbs: opts.sourceRootAbs,
      trackedPaths: opts.trackedPaths,
    });
    if (!mapped.ok) {
      unmapped.push({
        raw: section.file,
        resolved: mapped.resolved,
        reason: mapped.reason,
        lines: section.lines.size,
        artifact: opts.artifactPath,
      });
      continue;
    }
    if (mapped.viaRepoRootFallback) fallbackCount += 1;

    let taken = 0;
    for (const b of section.branches) if (b.taken !== null && b.taken > 0) taken += 1;
    const fc: FileCoverage = {
      file: mapped.path,
      lines: section.lines,
      branchesTaken: taken,
      branchesTotal: section.branches.length,
    };
    const bucket = byPath.get(mapped.path);
    if (bucket === undefined) byPath.set(mapped.path, [fc]);
    else bucket.push(fc);
  }

  if (unmapped.length > 0) {
    const droppedLines = unmapped.reduce((n, u) => n + u.lines, 0);
    notes.push({
      reason: 'unmapped-paths',
      severity: 'warn',
      detail: `${unmapped.length} SF: path(s) not mapped into the repo (${droppedLines} instrumented line(s) dropped); first: ${unmapped[0]?.raw ?? ''}`,
    });
  }
  if (fallbackCount > 0) {
    notes.push({
      reason: 'unmapped-paths',
      severity: 'info',
      detail: `${fallbackCount} SF: path(s) were repo-root-relative, not relative to the declared sourceRoot`,
    });
  }

  const files = [...byPath.keys()].sort().map((k) => mergeFileCoverage(byPath.get(k) ?? []));
  const summary: CoverageSummary = { files, source: opts.sourceLabel, stale: opts.stale };
  return { summary, notes, unmapped };
}

/* ──────────────────────────────── helpers ─────────────────────────────── */

/** Split into at most `n` commas' worth of fields; the remainder stays whole. */
function splitN(s: string, n: number): readonly (string | undefined)[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    const idx = s.indexOf(',', start);
    if (idx < 0) break;
    out.push(s.slice(start, idx));
    start = idx + 1;
  }
  out.push(s.slice(start));
  return out;
}

function int(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function countHit(lines: ReadonlyMap<number, number>): number {
  let n = 0;
  for (const v of lines.values()) if (v > 0) n += 1;
  return n;
}
