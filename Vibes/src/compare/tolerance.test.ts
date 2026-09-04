import { describe, expect, it } from 'vitest';
import { compareTolerance } from './tolerance.js';
import type { ToleranceMode } from './tolerance.js';

const MODE: ToleranceMode = {
  kind: 'tolerance',
  abs: 0.15,
  reason: 'ADC LSB is ~0.1 mN; below that is quantisation, not behaviour.',
};

const HEADER = 'time_us,force_mN\n';

function run(baseline: string, received: string, mode: ToleranceMode = MODE) {
  return compareTolerance(baseline, received, mode);
}

describe('compareTolerance — verdicts', () => {
  it('identical bytes are identical, not merely equivalent', () => {
    const text = `${HEADER}0,1.0\n1,2.0\n`;
    const r = run(text, text);
    expect(r.verdict.kind).toBe('identical');
  });

  it('a sub-epsilon move is equivalent and reports utilisation', () => {
    const r = run(`${HEADER}0,1.00\n1,2.00\n`, `${HEADER}0,1.05\n1,2.00\n`);
    expect(r.verdict.kind).toBe('equivalent');
    expect(r.verdict.epsilonUtilisation).toBeCloseTo(0.05 / 0.15, 10);
    expect(r.report?.absorbedCells).toBe(1);
    expect(r.report?.differingCells).toBe(0);
    expect(r.verdict.summary).toContain('within tolerance');
  });

  it('an over-epsilon move is different and names the worst cell', () => {
    const r = run(`${HEADER}0,1.00\n1,2.00\n`, `${HEADER}0,1.00\n1,2.40\n`);
    expect(r.verdict.kind).toBe('different');
    expect(r.report?.worst?.key).toBe('force_mN');
    expect(r.report?.worst?.row).toBe(1);
    expect(r.report?.worst?.delta).toBeCloseTo(0.4, 10);
    expect(r.verdict.epsilonUtilisation).toBeCloseTo(0.4 / 0.15, 10);
    expect(r.verdict.summary).toContain('worst');
  });

  it('formatting-only numeric change is equivalent (1.0 vs 1)', () => {
    const r = run(`${HEADER}0,1.0\n`, `${HEADER}0,1\n`);
    expect(r.verdict.kind).toBe('equivalent');
    expect(r.report?.absorbedCells).toBe(1);
  });
});

describe('compareTolerance — structural, never numeric', () => {
  it('an added column is structural', () => {
    const r = run(`${HEADER}0,1.0\n`, 'time_us,force_mN,temp_c\n0,1.0,20\n');
    expect(r.verdict.kind).toBe('structural');
    expect(r.report?.structural?.kind).toBe('columns-added');
    expect(r.report?.structural?.addedKeys).toEqual(['temp_c']);
  });

  it('a removed column is structural', () => {
    const r = run('time_us,force_mN,temp_c\n0,1.0,20\n', `${HEADER}0,1.0\n`);
    expect(r.verdict.kind).toBe('structural');
    expect(r.report?.structural?.removedKeys).toEqual(['temp_c']);
  });

  it('a reordered column is structural, not a shifted numeric diff', () => {
    const r = run('a,b\n1,2\n', 'b,a\n2,1\n');
    expect(r.verdict.kind).toBe('structural');
    expect(r.report?.structural?.kind).toBe('columns-reordered');
  });

  it('a row-count change is structural', () => {
    const r = run(`${HEADER}0,1.0\n1,2.0\n`, `${HEADER}0,1.0\n`);
    expect(r.verdict.kind).toBe('structural');
    expect(r.report?.structural?.kind).toBe('row-count');
    expect(r.verdict.summary).toContain('2 -> 1');
  });

  it('an unparseable side is structural with the line number', () => {
    const r = run(`${HEADER}0,1.0\n`, 'a,a\n1,2\n');
    expect(r.verdict.kind).toBe('structural');
    expect(r.report?.structural?.kind).toBe('parse-error');
    expect(r.verdict.summary).toContain('line 1');
  });
});

describe('compareTolerance — the three arithmetic traps', () => {
  it("a blank cell is a gap, not Number('') === 0", () => {
    const r = run(`${HEADER}0,0.00\n`, `${HEADER}0,\n`);
    // With abs=0.15 and a naive coercion, 0.00 vs '' would be |0-0| = 0 and
    // pass silently.
    expect(r.verdict.kind).toBe('different');
    expect(r.report?.diffs[0]?.reason).toBe('gap');
  });

  it('a NaN never passes as within tolerance', () => {
    // Math.abs(NaN - 1) > 0.15 is FALSE; a naive `if (d > eps) fail` reports a
    // firmware NaN as clean.
    expect(Math.abs(Number.NaN - 1) > 0.15).toBe(false);
    const r = run(`${HEADER}0,1.00\n`, `${HEADER}0,NaN\n`);
    expect(r.verdict.kind).toBe('different');
    expect(r.report?.diffs[0]?.reason).toBe('non-finite');
  });

  it('Infinity vs Infinity spelled differently never subtracts to NaN', () => {
    expect(Number.isNaN(Math.abs(Infinity - Infinity))).toBe(true);
    const r = run(`${HEADER}0,Infinity\n`, `${HEADER}0,-Infinity\n`);
    expect(r.verdict.kind).toBe('different');
    expect(r.report?.diffs[0]?.reason).toBe('non-finite');
  });

  it('identical NaN text is identical, not a difference', () => {
    const text = `${HEADER}0,NaN\n`;
    expect(run(text, text).verdict.kind).toBe('identical');
  });
});

describe('compareTolerance — signed zero', () => {
  it('is a difference when the budget is zero', () => {
    const strict: ToleranceMode = { kind: 'tolerance', abs: 0, rel: 0, reason: 'numeric identity' };
    const r = run(`${HEADER}0,0\n`, `${HEADER}0,-0\n`, strict);
    expect(r.verdict.kind).toBe('different');
    expect(r.report?.diffs[0]?.reason).toBe('signed-zero');
  });

  it('is absorbed but counted when a budget exists', () => {
    const r = run(`${HEADER}0,0\n`, `${HEADER}0,-0\n`);
    expect(r.verdict.kind).toBe('equivalent');
    expect(r.report?.signedZeroFlips).toBe(1);
    expect(r.verdict.summary).toContain('signed-zero');
  });
});

describe('compareTolerance — keys, columns and comments', () => {
  it('a column outside `columns` is compared exactly', () => {
    const mode: ToleranceMode = {
      kind: 'tolerance',
      abs: 10,
      columns: ['force_mN'],
      reason: 'only the force channel carries ADC noise',
    };
    const withinOnListed = run(`${HEADER}0,1.0\n`, `${HEADER}0,9.0\n`, mode);
    expect(withinOnListed.verdict.kind).toBe('equivalent');

    const onUnlisted = run(`${HEADER}0,1.0\n`, `${HEADER}5,1.0\n`, mode);
    expect(onUnlisted.verdict.kind).toBe('different');
    expect(onUnlisted.report?.diffs[0]?.key).toBe('time_us');
    expect(onUnlisted.report?.diffs[0]?.reason).toBe('text');
  });

  it('notes a declared column that is not in the series', () => {
    const mode: ToleranceMode = {
      kind: 'tolerance',
      abs: 1,
      columns: ['force_mN', 'torque_nm'],
      reason: 'x',
    };
    const r = run(`${HEADER}0,1.0\n`, `${HEADER}0,1.0\n`, mode);
    expect(r.report?.notes.join(' ')).toContain('torque_nm');
  });

  it('a volatile preamble line never causes a diff', () => {
    const r = run(
      `# vibes-volatile: started=A\n${HEADER}0,1.0\n`,
      `# vibes-volatile: started=B\n${HEADER}0,1.0\n`,
    );
    expect(r.verdict.kind).toBe('equivalent');
    expect(r.report?.commentLinesChanged).toBe(0);
  });

  it('a non-volatile comment change is different and stays textual', () => {
    const r = run(`# profile SN-1\n${HEADER}0,1.0\n`, `# profile SN-2\n${HEADER}0,1.0\n`);
    expect(r.verdict.kind).toBe('different');
    expect(r.report?.commentLinesChanged).toBe(1);
    expect(r.report?.differingCells).toBe(0);
  });

  it('a relative epsilon scales with magnitude', () => {
    const mode: ToleranceMode = { kind: 'tolerance', rel: 1e-9, reason: 'float64 text rendering' };
    const ok = run(`${HEADER}0,1000000\n`, `${HEADER}0,1000000.0005\n`, mode);
    expect(ok.verdict.kind).toBe('equivalent');
    const bad = run(`${HEADER}0,1\n`, `${HEADER}0,1.0005\n`, mode);
    expect(bad.verdict.kind).toBe('different');
  });
});

describe('compareTolerance — report shape', () => {
  it('retains per-key series for rendering and bounds the diff list', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `${i},${i * 2}`).join('\n');
    const moved = Array.from({ length: 30 }, (_, i) => `${i},${i * 2 + 1}`).join('\n');
    const r = run(`${HEADER}${rows}\n`, `${HEADER}${moved}\n`, {
      kind: 'tolerance',
      abs: 0.1,
      reason: 'x',
    });
    expect(r.verdict.kind).toBe('different');
    expect(r.report?.perKey.find((k) => k.key === 'force_mN')?.baselineSeries).toHaveLength(30);
    const bounded = compareTolerance(`${HEADER}${rows}\n`, `${HEADER}${moved}\n`, {
      kind: 'tolerance',
      abs: 0.1,
      reason: 'x',
    }, { maxCellDiffs: 5 });
    expect(bounded.report?.diffs).toHaveLength(5);
    expect(bounded.report?.truncatedDiffs).toBe(25);
  });

  it('drops the series when a gap makes it undrawable', () => {
    const r = run(`${HEADER}0,\n1,2\n`, `${HEADER}0,\n1,2\n`);
    expect(r.verdict.kind).toBe('identical');
    const changed = run(`${HEADER}0,\n1,2\n`, `${HEADER}0,\n1,3\n`);
    expect(changed.report?.perKey.find((k) => k.key === 'force_mN')?.baselineSeries).toBeNull();
  });

  it('flags an epsilon that could never fail', () => {
    const r = run(`${HEADER}0,1.0000\n`, `${HEADER}0,1.0001\n`, {
      kind: 'tolerance',
      abs: 1,
      reason: 'deliberately wide',
    });
    expect(r.verdict.kind).toBe('equivalent');
    expect(r.report?.notes.join(' ')).toContain('epsilon-unused');
  });
});
