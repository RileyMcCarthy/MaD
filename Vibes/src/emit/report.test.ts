/**
 * End-to-end: real files on a real filesystem, in a real temp dir.
 *
 * A mocked `fs` would prove the emitter calls a function; only writing the
 * bytes proves the report a reviewer opens actually exists and parses.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunReport } from '../types.js';
import { emitReport } from './report.js';
import { assertNoExternalRefs } from './noExternal.js';
import { DISCLOSURE_SENTENCE } from './headline.js';
import { component, finding, makeReport, producer, snap } from './fixture.test.js';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vibes-emit-'));
}

const content = (b: string, r: string) => () => ({
  baseline: Buffer.from(b),
  received: Buffer.from(r),
});

function busyReport(): RunReport {
  return makeReport({
    fullyVerified: false,
    findings: [finding('governance-weakened', 'error', { paths: ['vibes.config.mjs'] })],
    components: [
      component({
        state: 'partial',
        producers: [producer('domain', 'ok'), producer('trace', 'timedOut')],
        snapshots: [
          snap('gcode/program.txt', 'changed'),
          snap('gcode/new.txt', 'added'),
          snap('gcode/gone.txt', 'deleted'),
          snap('trace/run.csv', 'not-run'),
          snap('trace/other.csv', 'not-selected'),
          snap('labels.txt', 'verified-unchanged'),
        ],
        unclaimedPaths: ['Software/Control/src/domain/gcode.ts'],
      }),
    ],
  });
}

describe('emitReport', () => {
  it('writes json, markdown and html into the out dir', async () => {
    const dir = await scratch();
    const result = await emitReport(busyReport(), {
      outDir: dir,
      content: content('a\n', 'b\n'),
      stepSummaryPath: null,
    });
    expect(result.files.map((f) => f.split('/').pop())).toEqual([
      'report.json',
      'report.md',
      'report.html',
    ]);
    const html = await readFile(join(dir, 'report.html'), 'utf8');
    expect(assertNoExternalRefs(html)).toEqual([]);
    const md = await readFile(join(dir, 'report.md'), 'utf8');
    expect(md).toContain(DISCLOSURE_SENTENCE);
  });

  it('writes report.json unabridged, whatever the other budgets did', async () => {
    const dir = await scratch();
    const report = busyReport();
    await emitReport(report, {
      outDir: dir,
      content: content('a\n', 'b\n'),
      budget: {
        markdownMaxBytes: 3_000,
        stepSummaryMaxBytes: 3_000,
        htmlMaxBytes: 3_000,
        maxRenderedFiles: 1,
        expandFirstNFiles: 1,
        maxPathsPerList: 1,
        maxLogTailBytes: 100,
      },
      stepSummaryPath: null,
    });
    const parsed = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as RunReport;
    expect(parsed.components[0]?.snapshots).toHaveLength(6);
    expect(parsed).toEqual(report);
  });

  it('appends the markdown to the step summary file', async () => {
    const dir = await scratch();
    const summary = join(dir, 'summary.md');
    await writeFile(summary, '# existing\n', 'utf8');
    const result = await emitReport(busyReport(), {
      outDir: dir,
      content: content('a\n', 'b\n'),
      stepSummaryPath: summary,
    });
    expect(result.stepSummaryWritten).toBe(true);
    const text = await readFile(summary, 'utf8');
    expect(text.startsWith('# existing')).toBe(true);
    expect(text).toContain(DISCLOSURE_SENTENCE);
  });

  it('caps the step summary and says it did, because GitHub drops the whole thing', async () => {
    const dir = await scratch();
    const summary = join(dir, 'summary.md');
    await writeFile(summary, '', 'utf8');
    const result = await emitReport(busyReport(), {
      outDir: dir,
      content: content('a\n', 'b\n'),
      stepSummaryPath: summary,
      budget: {
        markdownMaxBytes: 96_000,
        stepSummaryMaxBytes: 1_200,
        htmlMaxBytes: 4_000_000,
        maxRenderedFiles: 200,
        expandFirstNFiles: 5,
        maxPathsPerList: 50,
        maxLogTailBytes: 4_000,
      },
    });
    const text = await readFile(summary, 'utf8');
    expect(text).toContain('Step summary truncated');
    expect(result.truncations.some((t) => t.where === 'GitHub step summary')).toBe(true);
  });

  it('does not fail the run when the step summary path is unwritable', async () => {
    const dir = await scratch();
    const lines: string[] = [];
    const result = await emitReport(makeReport(), {
      outDir: dir,
      stepSummaryPath: join(dir, 'no', 'such', 'dir', 'summary.md'),
      log: (l) => lines.push(l),
    });
    expect(result.stepSummaryWritten).toBe(false);
    expect(lines.join(' ')).toMatch(/could not write \$GITHUB_STEP_SUMMARY/);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('honours a format subset', async () => {
    const dir = await scratch();
    const result = await emitReport(makeReport(), {
      outDir: dir,
      formats: ['json'],
      stepSummaryPath: null,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatch(/report\.json$/);
  });

  it('includes the log tail of a producer that did not complete', async () => {
    const dir = await scratch();
    const logPath = join(dir, 'trace.err.log');
    await writeFile(logPath, 'starting\nboom: emulator never bound the PTY\n', 'utf8');
    const report = makeReport({
      fullyVerified: false,
      components: [
        component({
          state: 'not-run',
          producers: [producer('trace', 'timedOut', { stderrPath: logPath })],
          snapshots: [snap('trace/run.csv', 'not-run')],
        }),
      ],
    });
    await emitReport(report, { outDir: dir, stepSummaryPath: null });
    const md = await readFile(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('boom: emulator never bound the PTY');
  });

  it('returns the headline it actually printed', async () => {
    const dir = await scratch();
    const result = await emitReport(busyReport(), { outDir: dir, stepSummaryPath: null });
    const md = await readFile(join(dir, 'report.md'), 'utf8');
    expect(md).toContain(result.headline);
    expect(/\bunchanged\b/i.test(result.headline)).toBe(false);
  });
});
