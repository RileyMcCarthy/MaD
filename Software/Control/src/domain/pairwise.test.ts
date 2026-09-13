/**
 * Sprint D — pairwise combinatorial coverage.
 */
import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
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

  behaviour(
    {
      id: 'matrix.pairwise-covers-all-pairs',
      covers: 'src/domain/pairwise.ts#pairwiseCases',
      given: 'four factors whose full product is 54 combinations',
      expect: {
        'all-pairs-covered': 'every pair of levels appears',
        'fewer-than-full-product': 'fewer cases are produced than the full product',
        'at-least-one-per-level': 'there are at least as many cases as the widest factor has levels',
      },
    },
    () => {
      const cases = pairwiseCases(factors);
      const full = fullProductSize(factors);
      const pairs = pairwisePairCount(factors);
      expect(full).toBe(2 * 3 * 3 * 3); // 54
      expect(pairs).toBeGreaterThan(20);
      expect(cases.length).toBeLessThan(full);
      expect(cases.length).toBeGreaterThanOrEqual(Math.max(...factors.map((f) => f.levels.length)));
      expect(coversAllPairs(factors, cases)).toBe(true);
    },
  );

  behaviour(
    {
      id: 'matrix.pairwise-is-deterministic',
      covers: 'src/domain/pairwise.ts#pairwiseCases',
      given: 'the same factor set generated twice',
      expect: {
        'same-cases-same-order': 'both runs produce the same cases in the same order',
      },
    },
    () => {
      const a = pairwiseCases(factors);
      const b = pairwiseCases(factors);
      expect(a).toEqual(b);
    },
  );

  behaviour(
    {
      id: 'matrix.pairwise-single-factor',
      covers: 'src/domain/pairwise.ts#pairwiseCases',
      given: 'a single factor with three levels',
      expect: {
        'one-case-per-level': 'there is one case per level, in the order the levels were written',
      },
    },
    () => {
      const one: Factor[] = [{ name: 'g', levels: ['0', '1', '122'] }];
      expect(pairwiseCases(one)).toEqual([{ g: '0' }, { g: '1' }, { g: '122' }]);
    },
  );

  behaviour(
    {
      id: 'matrix.pairwise-two-factors',
      covers: 'src/domain/pairwise.ts#pairwiseCases',
      given: 'two factors with two and three levels',
      expect: {
        'all-pairs-covered': 'every pair of levels appears',
        'at-most-six-cases': 'no more than six cases are produced',
      },
    },
    () => {
      const two: Factor[] = [
        { name: 'a', levels: ['x', 'y'] },
        { name: 'b', levels: ['1', '2', '3'] },
      ];
      const cases = pairwiseCases(two);
      expect(coversAllPairs(two, cases)).toBe(true);
      // 2×3 = 6 pairs for (a,b); may use ≤6 cases
      expect(cases.length).toBeLessThanOrEqual(6);
    },
  );
});
