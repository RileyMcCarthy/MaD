/**
 * The report-facing one-liners.
 *
 * These exist so the "coverage: none" / "tests: n/a" wording lives in ONE
 * place. Every emitter that formats its own string is one refactor away from
 * printing "0%" for a component that has no coverage tool at all, and that
 * single character difference is the whole failure mode this tool exists to
 * prevent.
 */

import { coverageTotals, formatPercent, type ComponentIngest } from './model.js';

/** e.g. "244 passed · 1 failed · 3 skipped" or "not configured". */
export function testsLabel(ci: ComponentIngest): string {
  switch (ci.testsState) {
    case 'not-configured':
      return 'not configured';
    case 'not-run':
      return 'not run this run';
    case 'error':
      return ci.tests === null ? 'unusable (see gaps)' : 'unusable — stale or partial evidence (see gaps)';
    case 'ingested':
      break;
    default:
      return 'unknown';
  }
  const t = ci.tests;
  if (t === null) return 'unusable (see gaps)';
  const parts = [`${t.passed} passed`];
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  if (t.skipped > 0) parts.push(`${t.skipped} skipped`);
  return parts.join(' · ');
}

/**
 * e.g. "87.4% lines (12 files)". NEVER "0%" for an absent tool: `null`
 * coverage renders as the reason it is null, by name.
 */
export function coverageLabel(ci: ComponentIngest): string {
  switch (ci.coverageState) {
    case 'not-configured':
      return 'not configured';
    case 'not-run':
      return 'not run this run';
    case 'error':
      return 'unusable (see gaps)';
    case 'ingested':
      break;
    default:
      return 'unknown';
  }
  const c = ci.coverage;
  if (c === null) return 'unusable (see gaps)';
  const t = coverageTotals(c);
  const lines = `${formatPercent(t.linesHit, t.linesFound)} lines`;
  const branches = t.branchesTotal > 0 ? ` · ${formatPercent(t.branchesTaken, t.branchesTotal)} branches` : '';
  return `${lines}${branches} (${t.files} file${t.files === 1 ? '' : 's'})`;
}
