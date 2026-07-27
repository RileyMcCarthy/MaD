/**
 * Sprint D — pairwise combinatorial coverage.
 */
import { describe, it, expect } from 'vitest';
import { pairwiseCases, pairwisePairCount, fullProductSize, type Factor } from './pairwise';

function coversAllPairs(factors: Factor[], cases: Record<string, string>[]): boolean {
  const need = new Set<string>();
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      for (const a of factors[i].levels) {
        for (const b of factors[j].levels) {
          need.add(`${factors[i].name}=${a}|${factors[j].name}=${b}`);
        }
      }
    }
  }
  for (const c of cases) {
    for (let i = 0; i < factors.length; i++) {
      for (let j = i + 1; j < factors.length; j++) {
        const key = `${factors[i].name}=${c[factors[i].name]}|${factors[j].name}=${c[factors[j].name]}`;
        need.delete(key);
      }
    }
  }
  return need.size === 0;
}

describe('pairwise coverage', () => {
  const factors: Factor[] = [
    { name: 'shape', levels: ['sine', 'triangle'] },
    { name: 'amp', levels: ['3', '5', '10'] },
    { name: 'freq', levels: ['0.5', '1', '2'] },
    { name: 'cycles', levels: ['1', '2', '3'] },
  ];

  it('covers all pairs with far fewer cases than full product', () => {
    const cases = pairwiseCases(factors);
    const full = fullProductSize(factors);
    const pairs = pairwisePairCount(factors);
    expect(full).toBe(2 * 3 * 3 * 3); // 54
    expect(pairs).toBeGreaterThan(20);
    expect(cases.length).toBeLessThan(full);
    expect(cases.length).toBeGreaterThanOrEqual(Math.max(...factors.map((f) => f.levels.length)));
    expect(coversAllPairs(factors, cases)).toBe(true);
  });

  it('is deterministic', () => {
    const a = pairwiseCases(factors);
    const b = pairwiseCases(factors);
    expect(a).toEqual(b);
  });

  it('handles a single factor', () => {
    const one: Factor[] = [{ name: 'g', levels: ['0', '1', '122'] }];
    expect(pairwiseCases(one)).toEqual([{ g: '0' }, { g: '1' }, { g: '122' }]);
  });

  it('two-factor product is exact pairs', () => {
    const two: Factor[] = [
      { name: 'a', levels: ['x', 'y'] },
      { name: 'b', levels: ['1', '2', '3'] },
    ];
    const cases = pairwiseCases(two);
    expect(coversAllPairs(two, cases)).toBe(true);
    // 2×3 = 6 pairs for (a,b); may use ≤6 cases
    expect(cases.length).toBeLessThanOrEqual(6);
  });
});
