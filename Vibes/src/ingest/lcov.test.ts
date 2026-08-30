import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { lcovToCoverage, parseLcov } from './adapters/lcov.js';
import { coverageTotals, formatPercent, mergeCoverageSummaries } from './model.js';
import { createRelativizer } from './paths.js';

const REPO = '/Users/ci/work/repo';
const COMPONENT = `${REPO}/Software/Control`;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

function convert(text: string, sourceRootAbs = COMPONENT, trackedPaths?: ReadonlySet<string>) {
  return lcovToCoverage(parseLcov(text), {
    relativize: createRelativizer(REPO),
    repoRoot: REPO,
    sourceRootAbs,
    sourceLabel: 'lcov:test',
    artifactPath: 'test.info',
    stale: false,
    trackedPaths,
  });
}

describe('parseLcov — order independence', () => {
  // The whole reason this parser is a bag and not a state machine.
  const orders = ['lcov-geninfo.info', 'lcov-istanbul.info', 'lcov-llvm.info'];

  it('produces identical sections for geninfo, istanbul and llvm-cov record orders', () => {
    const shapes = orders.map((f) => {
      const parsed = parseLcov(fixture(f));
      return parsed.sections.map((s) => ({
        file: s.file,
        lines: [...s.lines.entries()],
        branches: s.branches,
        functions: s.functions,
      }));
    });
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it('produces identical coverage summaries across the three orders', () => {
    const summaries = orders.map((f) => convert(fixture(f)).summary.files.map((x) => ({
      file: x.file,
      lines: [...x.lines.entries()],
      taken: x.branchesTaken,
      total: x.branchesTotal,
    })));
    expect(summaries[1]).toEqual(summaries[0]);
    expect(summaries[2]).toEqual(summaries[0]);
  });
});

describe('parseLcov — the distinctions every library normalises away', () => {
  it('keeps absent-DA and DA-with-0 apart', () => {
    const [section] = parseLcov(fixture('lcov-geninfo.info')).sections;
    const lines = section?.lines;
    // Line 13 is instrumented and never ran.
    expect(lines?.get(13)).toBe(0);
    expect(lines?.has(13)).toBe(true);
    // Line 14 has no DA record: it is UNINSTRUMENTED, not uncovered.
    expect(lines?.has(14)).toBe(false);
    expect(lines?.get(14)).toBeUndefined();
  });

  it('keeps BRDA "-" (never evaluated) apart from BRDA 0 (evaluated, not taken)', () => {
    const [section] = parseLcov(fixture('lcov-geninfo.info')).sections;
    const byKey = new Map(section?.branches.map((b) => [`${b.line}:${b.block}:${b.branch}`, b]));
    expect(byKey.get('12:0:1')?.taken).toBe(0);
    expect(byKey.get('26:0:0')?.taken).toBeNull();
  });

  it('preserves the geninfo `e` exception marker on block and branch ids', () => {
    const parsed = parseLcov(['SF:a.ts', 'BRDA:8,e0,1,3', 'BRDA:8,0,e1,-', 'end_of_record'].join('\n'));
    const branches = parsed.sections[0]?.branches ?? [];
    const exceptionBlock = branches.find((b) => b.exceptionBlock);
    const exceptionBranch = branches.find((b) => b.exceptionBranch);
    expect(exceptionBlock).toMatchObject({ block: '0', branch: '1', taken: 3, exceptionBranch: false });
    expect(exceptionBranch).toMatchObject({ block: '0', branch: '1', taken: null, exceptionBlock: false });
    // Two distinct records, not one merged pair.
    expect(branches).toHaveLength(2);
  });

  it('counts "-" branches in the denominator', () => {
    // A branch whose block never ran is instrumented-and-uncovered. Dropping
    // it would let dead code improve the branch rate.
    const cov = convert(fixture('lcov-geninfo.info'));
    const gcode = cov.summary.files.find((f) => f.file.endsWith('gcode.ts'));
    expect(gcode?.branchesTotal).toBe(4);
    expect(gcode?.branchesTaken).toBe(1);
  });
});

describe('parseLcov — CSV edge cases', () => {
  it('keeps commas inside function names', () => {
    const parsed = parseLcov(
      ['SF:a.cpp', 'FN:3,std::map<int, int>::insert', 'FNDA:5,std::map<int, int>::insert', 'end_of_record'].join('\n'),
    );
    expect(parsed.sections[0]?.functions).toEqual([
      { name: 'std::map<int, int>::insert', startLine: 3, endLine: null, hits: 5 },
    ]);
  });

  it('handles the geninfo 2.x FN:<start>,<end>,<name> form', () => {
    const parsed = parseLcov(['SF:a.c', 'FN:10,42,do_thing', 'FNDA:1,do_thing', 'end_of_record'].join('\n'));
    expect(parsed.sections[0]?.functions[0]).toEqual({
      name: 'do_thing',
      startLine: 10,
      endLine: 42,
      hits: 1,
    });
  });

  it('does not mistake a numeric-looking name for an end line', () => {
    const parsed = parseLcov(['SF:a.js', 'FN:7,anon_7,extra', 'end_of_record'].join('\n'));
    expect(parsed.sections[0]?.functions[0]?.name).toBe('anon_7,extra');
    expect(parsed.sections[0]?.functions[0]?.endLine).toBeNull();
  });

  it('keeps the DA checksum field without letting it corrupt the count', () => {
    const parsed = parseLcov(['SF:a.c', 'DA:5,3,PF4Rz2r7RTliO9u6bZ7h6g', 'end_of_record'].join('\n'));
    expect(parsed.sections[0]?.lines.get(5)).toBe(3);
    expect(parsed.sections[0]?.checksums.get(5)).toBe('PF4Rz2r7RTliO9u6bZ7h6g');
  });

  it('sums duplicate DA records for one line (template instantiations)', () => {
    const parsed = parseLcov(['SF:a.cpp', 'DA:5,3', 'DA:5,4', 'end_of_record'].join('\n'));
    expect(parsed.sections[0]?.lines.get(5)).toBe(7);
  });

  it('merges BRDA "-" with a later count instead of keeping "never evaluated"', () => {
    const parsed = parseLcov(['SF:a.cpp', 'BRDA:5,0,0,-', 'BRDA:5,0,0,2', 'end_of_record'].join('\n'));
    expect(parsed.sections[0]?.branches[0]?.taken).toBe(2);
  });
});

describe('parseLcov — degrading honestly', () => {
  it('does not throw on malformed records; it counts them', () => {
    const parsed = parseLcov(['SF:a.c', 'DA:notanumber,1', 'DA:4,2', 'end_of_record'].join('\n'));
    expect(parsed.sections[0]?.lines.get(4)).toBe(2);
    expect(parsed.notes.some((n) => n.detail.includes('malformed'))).toBe(true);
  });

  it('flushes a section that never got end_of_record, with a note', () => {
    const parsed = parseLcov(['SF:a.c', 'DA:1,1'].join('\n'));
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.notes.some((n) => n.detail.includes('no end_of_record'))).toBe(true);
  });

  it('starts a new section when SF appears without end_of_record', () => {
    const parsed = parseLcov(['SF:a.c', 'DA:1,1', 'SF:b.c', 'DA:2,2', 'end_of_record'].join('\n'));
    expect(parsed.sections.map((s) => s.file)).toEqual(['a.c', 'b.c']);
  });

  it('reports unknown record prefixes with counts instead of ignoring them', () => {
    const parsed = parseLcov(['SF:a.c', 'FNL:0,1,2', 'FNA:0,3,name', 'end_of_record'].join('\n'));
    expect(parsed.unknownRecords.get('FNL')).toBe(1);
    expect(parsed.unknownRecords.get('FNA')).toBe(1);
  });

  it('flags a tracefile whose own LH disagrees with its DA records', () => {
    const parsed = parseLcov(['SF:a.c', 'DA:1,1', 'DA:2,0', 'LF:2', 'LH:2', 'end_of_record'].join('\n'));
    expect(parsed.notes.some((n) => n.reason === 'count-mismatch' && n.detail.includes('LH says 2'))).toBe(true);
  });

  it('tolerates CRLF and a UTF-8 BOM', () => {
    const parsed = parseLcov('﻿SF:a.c\r\nDA:1,1\r\nend_of_record\r\n');
    expect(parsed.sections[0]?.file).toBe('a.c');
    expect(parsed.sections[0]?.lines.get(1)).toBe(1);
  });
});

describe('lcovToCoverage — SF path mapping (R-I4)', () => {
  it('anchors relative SF paths at the declared sourceRoot', () => {
    const cov = convert(fixture('lcov-geninfo.info'));
    expect(cov.summary.files.map((f) => f.file)).toEqual([
      'Software/Control/src/domain/csv.ts',
      'Software/Control/src/domain/gcode.ts',
    ]);
  });

  it('makes absolute SF paths repo-relative', () => {
    const cov = convert([`SF:${COMPONENT}/src/domain/gcode.ts`, 'DA:1,1', 'end_of_record'].join('\n'));
    expect(cov.summary.files[0]?.file).toBe('Software/Control/src/domain/gcode.ts');
  });

  it('reports paths outside the repo as unmapped WITH the line count, never silently', () => {
    const cov = convert(['SF:/opt/vendor/lib.ts', 'DA:1,1', 'DA:2,0', 'end_of_record'].join('\n'));
    expect(cov.summary.files).toHaveLength(0);
    expect(cov.unmapped).toEqual([
      { raw: '/opt/vendor/lib.ts', resolved: '/opt/vendor/lib.ts', reason: 'outside-repo', lines: 2, artifact: 'test.info' },
    ]);
    expect(cov.notes.some((n) => n.reason === 'unmapped-paths' && n.detail.includes('2 instrumented line(s) dropped'))).toBe(
      true,
    );
  });

  it('rejects a mapping that is not in the tracked set', () => {
    const cov = convert(['SF:src/ghost.ts', 'DA:1,1', 'end_of_record'].join('\n'), COMPONENT, new Set(['Software/Control/src/real.ts']));
    expect(cov.summary.files).toHaveLength(0);
    expect(cov.unmapped[0]?.reason).toBe('untracked');
  });

  it('detects the --root ../.. double-prefix trap when a tracked set is available', () => {
    // The same tool, run from the monorepo root, emits repo-root-relative SF
    // paths. Anchoring those at the component root invents a directory.
    const tracked = new Set(['Software/Control/src/domain/gcode.ts']);
    const cov = convert(
      ['SF:Software/Control/src/domain/gcode.ts', 'DA:1,1', 'end_of_record'].join('\n'),
      COMPONENT,
      tracked,
    );
    expect(cov.summary.files[0]?.file).toBe('Software/Control/src/domain/gcode.ts');
    expect(cov.notes.some((n) => n.detail.includes('repo-root-relative'))).toBe(true);
  });

  it('merges two tracefiles covering the same file by summing hits and unioning lines', () => {
    const a = convert(['SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'end_of_record'].join('\n')).summary;
    const b = convert(['SF:src/a.ts', 'DA:1,2', 'DA:3,5', 'end_of_record'].join('\n')).summary;
    const merged = mergeCoverageSummaries([a, b]);
    const file = merged?.files[0];
    expect([...(file?.lines.entries() ?? [])]).toEqual([
      [1, 3],
      [2, 0],
      [3, 5],
    ]);
  });
});

describe('coverage arithmetic', () => {
  it('counts instrumented lines only — an uninstrumented line is in neither bucket', () => {
    const cov = convert(fixture('lcov-geninfo.info')).summary;
    const totals = coverageTotals(cov);
    expect(totals).toEqual({ linesFound: 8, linesHit: 4, branchesTotal: 4, branchesTaken: 1, files: 2 });
    expect(formatPercent(totals.linesHit, totals.linesFound)).toBe('50.0%');
  });
});
