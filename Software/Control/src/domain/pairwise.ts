/**
 * Pairwise (all-pairs) combinatorial coverage (Sprint D).
 *
 * For N dimensions each with k_i levels, full product is ∏k_i. Pairwise
 * coverage ensures every pair of dimension values appears in ≥1 case —
 * exponentially smaller, still catches most interaction bugs.
 *
 * Algorithm: greedy — repeatedly pick the unused combination that covers the
 * most yet-uncovered pairs (simple, deterministic, good enough for test gen).
 */

export type Factor = { name: string; levels: readonly string[] };

export type Case = Record<string, string>;

/** All unordered pairs of (factorIndex, level) that must appear together. */
function requiredPairs(factors: Factor[]): Set<string> {
  const need = new Set<string>();
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      for (const a of factors[i].levels) {
        for (const b of factors[j].levels) {
          need.add(`${i}:${a}|${j}:${b}`);
        }
      }
    }
  }
  return need;
}

function pairsCoveredBy(caseLevels: string[], factors: Factor[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      out.push(`${i}:${caseLevels[i]}|${j}:${caseLevels[j]}`);
    }
  }
  return out;
}

/**
 * Build a near-minimal set of cases with pairwise coverage.
 * Deterministic given factor order and level order.
 */
export function pairwiseCases(factors: Factor[]): Case[] {
  if (factors.length === 0) return [];
  if (factors.length === 1) {
    return factors[0].levels.map((l) => ({ [factors[0].name]: l }));
  }

  const need = requiredPairs(factors);
  const cases: Case[] = [];
  const maxLevel = Math.max(...factors.map((f) => f.levels.length));

  // Seed with a latin-like diagonal so we always make progress.
  for (let r = 0; r < maxLevel; r++) {
    const levels = factors.map((f) => f.levels[r % f.levels.length]);
    const key = pairsCoveredBy(levels, factors);
    let added = false;
    for (const p of key) {
      if (need.has(p)) {
        need.delete(p);
        added = true;
      }
    }
    if (added || cases.length === 0) {
      const c: Case = {};
      factors.forEach((f, i) => {
        c[f.name] = levels[i];
      });
      cases.push(c);
    }
  }

  // Greedy fill remaining pairs.
  let guard = 0;
  while (need.size > 0 && guard < 10_000) {
    guard += 1;
    let bestLevels: string[] | null = null;
    let bestCover = -1;

    // Sample a bounded search space: fix each uncovered pair and complete randomly-deterministically.
    const samplePairs = [...need].slice(0, 64);
    for (const pairKey of samplePairs) {
      const [left, right] = pairKey.split('|');
      const [iStr, a] = left.split(':');
      const [jStr, b] = right.split(':');
      const i = Number(iStr);
      const j = Number(jStr);
      const levels = factors.map((f, idx) => {
        if (idx === i) return a;
        if (idx === j) return b;
        // pick first level as default fill
        return f.levels[0];
      });
      // Try rotating other factors through their levels to maximize cover
      for (let t = 0; t < maxLevel; t++) {
        const tryLevels = levels.map((lv, idx) => {
          if (idx === i || idx === j) return lv;
          return factors[idx].levels[t % factors[idx].levels.length];
        });
        const covered = pairsCoveredBy(tryLevels, factors).filter((p) => need.has(p));
        if (covered.length > bestCover) {
          bestCover = covered.length;
          bestLevels = tryLevels;
        }
      }
    }

    if (!bestLevels || bestCover <= 0) {
      // Fallback: take any remaining pair with defaults
      const any = [...need][0];
      if (!any) break;
      const [left, right] = any.split('|');
      const [iStr, a] = left.split(':');
      const [jStr, b] = right.split(':');
      const i = Number(iStr);
      const j = Number(jStr);
      bestLevels = factors.map((f, idx) => {
        if (idx === i) return a;
        if (idx === j) return b;
        return f.levels[0];
      });
    }

    for (const p of pairsCoveredBy(bestLevels, factors)) need.delete(p);
    const c: Case = {};
    factors.forEach((f, i) => {
      c[f.name] = bestLevels![i];
    });
    cases.push(c);
  }

  return cases;
}

/** Count of pairs that must be covered for the factor set. */
export function pairwisePairCount(factors: Factor[]): number {
  return requiredPairs(factors).size;
}

/** Full cartesian product size (for comparison). */
export function fullProductSize(factors: Factor[]): number {
  return factors.reduce((n, f) => n * f.levels.length, 1);
}
