/**
 * The import surface other modules compose against.
 *
 * A broken re-export in index.ts is invisible to `tsc` inside this module (the
 * symbol still exists in its own file) and only explodes in whichever module
 * imports it next. This test makes that failure land here instead.
 */

import { describe, expect, it } from 'vitest';

import * as ingest from './index.js';

const EXPECTED_FUNCTIONS = [
  'ingestAll',
  'parseJUnitXml',
  'parseVitestJson',
  'parsePioJson',
  'parseLcov',
  'lcovToCoverage',
  'globFiles',
  'sniff',
  'createRelativizer',
  'mapArtifactPath',
  'toPosix',
  'componentInputFromSpec',
  'coverageTotals',
  'formatPercent',
  'globList',
  'mergeTestSummaries',
  'mergeCoverageSummaries',
  'mergeFileCoverage',
  'sourceLabel',
  'mergedSourceLabel',
  'coverageLabel',
  'testsLabel',
] as const;

describe('public API', () => {
  it('exports every function composing modules import', () => {
    for (const name of EXPECTED_FUNCTIONS) {
      expect(typeof (ingest as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('exports the error class and the stale-grace constant', () => {
    expect(typeof ingest.AdapterParseError).toBe('function');
    expect(ingest.DEFAULT_STALE_GRACE_MS).toBe(2000);
  });

  it('ingestAll on an empty component list is a well-formed empty report', async () => {
    const report = await ingest.ingestAll({ repoRoot: process.cwd(), runStartedAtMs: Date.now(), components: [] });
    expect(report).toEqual({ components: [], gaps: [] });
  });
});
