import { describe, it, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  buildIssueFields,
  buildIssueUrl,
  bundleFileName,
  environmentBlock,
  ISSUE_URL_MAX,
  ISSUE_TEMPLATE,
  shortUserAgent,
} from './report';
import type { DiagnosticsBundle } from './exportBundle';
import type { LogEntry } from './log';
import { summariseForTriage } from './triage';

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    seq: 1,
    t: Date.UTC(2026, 0, 1, 12, 0, 0),
    thread: 'main',
    level: 'info',
    cat: 'app',
    tag: 'boot',
    ...over,
  };
}

function bundle(over: Partial<DiagnosticsBundle> = {}): DiagnosticsBundle {
  const log = over.log ?? { entries: [], counters: {}, dropped: 0, startedAt: 0 };
  return {
    triage: summariseForTriage(log),
    sessionId: 's-test',
    generatedAt: '2026-01-01T12:00:00.000Z',
    version: '0.1.0',
    gitSha: 'abc1234',
    userAgent: 'Mozilla/5.0 Chrome/130',
    buildMode: 'production',
    capabilities: { webSerial: true, fileSystemAccess: true },
    device: {
      connection: 'connected',
      responding: true,
      firmwareVersion: '1.2.3',
      portLabel: 'USB 0403:6001',
    },
    worker: {},
    log: { entries: [], counters: {}, dropped: 0, startedAt: 0 },
    ...over,
  };
}

describe('environmentBlock', () => {
  behaviour(
    {
      id: 'diag.report-environment-build-identity',
      covers: 'src/diagnostics/report.ts#environmentBlock',
      given: 'a diagnostics bundle with app version 0.1.0, git sha abc1234, and firmware 1.2.3',
      then: 'the issue-report environment block names the app version, git sha, and firmware version',
      why: 'the build identity is what decides whether a report is actionable',
    },
    () => {
      const text = environmentBlock(bundle());
      expect(text).toContain('App: 0.1.0 (abc1234)');
      expect(text).toContain('Firmware: 1.2.3');
    },
  );

  behaviour(
    {
      id: 'diag.report-environment-unknown-firmware',
      covers: 'src/diagnostics/report.ts#environmentBlock',
      given: 'a diagnostics bundle whose device has no firmware version',
      then: 'the issue-report environment block says firmware is unknown when none is known',
    },
    () => {
      const text = environmentBlock(
        bundle({ device: { connection: 'disconnected', responding: false, firmwareVersion: null, portLabel: null } }),
      );
      expect(text).toContain('Firmware: unknown');
    },
  );
});

describe('buildIssueFields', () => {
  behaviour(
    {
      id: 'diag.report-fields-template-and-attachment',
      covers: 'src/diagnostics/report.ts#buildIssueFields',
      given: 'an issue report whose summary is "jog does nothing"',
      then: 'the issue form targets the app-bug template, names the diagnostics attachment, and puts the reporter\'s summary in the title',
    },
    () => {
      const fields = buildIssueFields({ summary: 'jog does nothing' }, bundle(), 'mad-diagnostics-x.json');
      expect(fields.template).toBe(ISSUE_TEMPLATE);
      expect(fields.attachment).toBe('mad-diagnostics-x.json');
      expect(fields.title).toContain('jog does nothing');
    },
  );

  behaviour(
    {
      id: 'diag.report-fields-absent-repro-steps',
      covers: 'src/diagnostics/report.ts#buildIssueFields',
      given: 'an issue report whose reproduction steps are only whitespace',
      then: 'blank reproduction steps are recorded as not provided',
    },
    () => {
      expect(buildIssueFields({ summary: 'x', steps: '   ' }, bundle(), 'f.json').steps).toBe('(not provided)');
    },
  );

  behaviour(
    {
      id: 'diag.report-fields-failure-counters',
      covers: 'src/diagnostics/report.ts#buildIssueFields',
      given: 'a session whose counters include timeouts, nacks, ordinary transmits, and a boot event',
      then: 'the issue report lists only failure counters, most frequent first, and omits healthy traffic counts',
    },
    () => {
      const fields = buildIssueFields({ summary: 'x' }, bundle({
        log: {
          entries: [],
          counters: { 'proto:nack': 3, 'proto:tx': 900, 'proto:timeout': 7, 'app:boot': 1 },
          dropped: 0,
          startedAt: 0,
        },
      }), 'f.json');
      expect(fields.counters).toBe('proto:timeout: 7\nproto:nack: 3');
      expect(fields.counters).not.toContain('proto:tx');
    },
  );

  behaviour(
    {
      id: 'diag.report-fields-healthy-session',
      covers: 'src/diagnostics/report.ts#buildIssueFields',
      given: 'a session with no errors, nacks, or timeouts',
      then: 'the issue report says no errors were recorded when the session was healthy',
    },
    () => {
      const fields = buildIssueFields({ summary: 'x' }, bundle(), 'f.json');
      expect(fields.counters).toMatch(/No errors/);
      expect(fields.errors).toBe('None recorded.');
    },
  );

  behaviour(
    {
      id: 'diag.report-fields-recent-errors',
      covers: 'src/diagnostics/report.ts#buildIssueFields',
      given: 'a session log with an info boot event and an error "bad crc"',
      then: 'the issue report lists recent errors with their timestamps and omits non-error events',
    },
    () => {
      const fields = buildIssueFields({ summary: 'x' }, bundle({
        log: {
          entries: [
            entry({ level: 'info', tag: 'boot' }),
            entry({ level: 'error', cat: 'proto', tag: 'error', msg: 'bad crc' }),
          ],
          counters: {},
          dropped: 0,
          startedAt: 0,
        },
      }), 'f.json');
      expect(fields.errors).toContain('proto/error bad crc');
      expect(fields.errors).not.toContain('boot');
    },
  );
});

describe('buildIssueUrl', () => {
  behaviour(
    {
      id: 'diag.report-url-targets-template',
      covers: 'src/diagnostics/report.ts#buildIssueUrl',
      given: 'issue fields for a "broken" report',
      then: 'the prefilled issue link opens a new GitHub issue against the MaD repo with the app-bug template',
    },
    () => {
      const url = buildIssueUrl(buildIssueFields({ summary: 'broken' }, bundle(), 'f.json'));
      expect(url.startsWith('https://github.com/RileyMcCarthy/MaD/issues/new?')).toBe(true);
      expect(url).toContain(`template=${ISSUE_TEMPLATE}`);
    },
  );

  behaviour(
    {
      id: 'diag.report-url-stays-under-budget',
      covers: 'src/diagnostics/report.ts#buildIssueUrl',
      given: 'a long summary, long reproduction steps, 50 errors, and 40 failure counters',
      then: 'a long session still produces an issue link short enough for GitHub to open',
      why: 'GitHub rejects very long URLs, and a long session must not silently produce a dead link',
    },
    () => {
      // A long session must not produce a link GitHub refuses to open.
      const url = buildIssueUrl(
        buildIssueFields(
          { summary: 'x'.repeat(200), steps: 'y'.repeat(4000) },
          bundle({
            log: {
              entries: Array.from({ length: 50 }, (_, i) =>
                entry({ level: 'error', tag: `t${i}`, msg: 'z'.repeat(300) }),
              ),
              counters: Object.fromEntries(
                Array.from({ length: 40 }, (_, i) => [`proto:error-${i}`, i]),
              ),
              dropped: 0,
              startedAt: 0,
            },
          }),
          'f.json',
        ),
      );
      expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    },
  );

  behaviour(
    {
      id: 'diag.report-url-keeps-user-words',
      covers: 'src/diagnostics/report.ts#buildIssueUrl',
      given: 'a report whose error block alone would overflow the URL budget',
      then: 'when the issue link is too long, computed log excerpts are shortened first and the summary and steps the reporter typed survive',
      why: 'the reporter\'s own words are irreplaceable; computed log excerpts can be rebuilt from the attached diagnostics file',
    },
    () => {
      // Only `errors` is oversized here, so exactly one drop is needed — which is
      // what pins the ordering: derived blocks go before anything the user typed.
      const url = buildIssueUrl(
        buildIssueFields(
          { summary: 'the gantry stalls at 40mm', steps: 'jog to 40' },
          bundle({
            log: {
              entries: Array.from({ length: 5 }, (_, i) =>
                entry({ level: 'error', tag: `t${i}`, msg: 'q'.repeat(2000) }),
              ),
              counters: { 'proto:nack': 2 },
              dropped: 0,
              startedAt: 0,
            },
          }),
          'f.json',
        ),
      );
      const params = new URL(url).searchParams;
      expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
      expect(params.get('errors')).toContain('omitted');
      // Everything cheaper than `errors` survives untouched.
      expect(params.get('summary')).toBe('the gantry stalls at 40mm');
      expect(params.get('steps')).toBe('jog to 40');
      expect(params.get('counters')).toBe('proto:nack: 2');
    },
  );

  behaviour(
    {
      id: 'diag.report-url-omits-empty-values',
      covers: 'src/diagnostics/report.ts#buildIssueUrl',
      given: 'issue fields whose steps value is empty',
      then: 'empty issue-form fields are omitted from the prefilled link',
    },
    () => {
      expect(buildIssueUrl({ title: 'a', steps: '' })).not.toContain('steps=');
    },
  );
});

describe('bundleFileName', () => {
  behaviour(
    {
      id: 'diag.report-bundle-filename',
      covers: 'src/diagnostics/report.ts#bundleFileName',
      given: 'a diagnostics bundle saved at 2026-08-20 13:45:12.345 UTC',
      then: 'the diagnostics file name is timestamped and contains no colons',
    },
    () => {
      const name = bundleFileName(new Date(Date.UTC(2026, 7, 20, 13, 45, 12, 345)));
      expect(name).toBe('mad-diagnostics-2026-08-20T13-45-12-345Z.json');
      expect(name).not.toMatch(/[:]/);
    },
  );
});

describe('buildIssueUrl under pathological input', () => {
  behaviour(
    {
      id: 'diag.report-url-fits-huge-summary',
      covers: 'src/diagnostics/report.ts#buildIssueUrl',
      given: 'a 200000-character summary pasted into the issue report',
      then: 'an enormous pasted summary is truncated until the issue link still fits the GitHub URL budget',
    },
    () => {
      // A user can paste anything into the summary box; percent-encoding then
      // expands it further. The link must still be one GitHub will open.
      const url = buildIssueUrl(
        buildIssueFields({ summary: 'x'.repeat(200_000) }, bundle(), 'f.json'),
      );
      expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    },
  );

  behaviour(
    {
      id: 'diag.report-url-fits-percent-encoding',
      covers: 'src/diagnostics/report.ts#buildIssueUrl',
      given: 'a summary of newlines and ellipses that triple in size once URL-encoded',
      then: 'a summary whose characters expand when URL-encoded still produces an issue link within the GitHub URL budget',
      why: 'trimming by raw character count would undershoot on newlines and non-ASCII',
    },
    () => {
      // Newlines and non-ASCII cost 3 bytes each once encoded — the case a
      // single raw-length subtraction would undershoot.
      const url = buildIssueUrl(
        buildIssueFields({ summary: '\n…'.repeat(20_000) }, bundle(), 'f.json'),
      );
      expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    },
  );

  behaviour(
    {
      id: 'diag.report-url-usable-after-truncation',
      covers: 'src/diagnostics/report.ts#buildIssueUrl',
      given: 'a 50000-character summary that forces truncation',
      then: 'after truncation the link still opens a new GitHub issue with the app-bug template and a non-empty summary',
    },
    () => {
      const url = buildIssueUrl(buildIssueFields({ summary: 'q'.repeat(50_000) }, bundle(), 'f.json'));
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/RileyMcCarthy/MaD/issues/new');
      expect(parsed.searchParams.get('template')).toBe(ISSUE_TEMPLATE);
      expect((parsed.searchParams.get('summary') ?? '').length).toBeGreaterThan(0);
    },
  );
});

describe('shortUserAgent', () => {
  behaviour(
    {
      id: 'diag.report-short-ua-chrome-on-mac',
      covers: 'src/diagnostics/report.ts#shortUserAgent',
      given: 'a full Chrome-on-Mac user-agent string',
      then: 'a Chrome-on-Mac user-agent is reduced to "Chrome 130 on Intel Mac OS X 10_15_7"',
    },
    () => {
      expect(
        shortUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        ),
      ).toBe('Chrome 130 on Intel Mac OS X 10_15_7');
    },
  );

  behaviour(
    {
      id: 'diag.report-short-ua-names-edge',
      covers: 'src/diagnostics/report.ts#shortUserAgent',
      given: 'a Windows user-agent containing both Chrome and Edg tokens',
      then: 'an Edge user-agent is named Edge, even though it also contains Chrome',
      why: 'every Chromium user-agent contains Chrome, so a misnamed browser sends a bug hunt the wrong way',
    },
    () => {
      expect(shortUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Edg/130.0')).toContain('Edge 130');
    },
  );

  behaviour(
    {
      id: 'diag.report-short-ua-unknown-browser',
      covers: 'src/diagnostics/report.ts#shortUserAgent',
      given: 'a user-agent string that matches no known browser',
      then: 'an unrecognised user-agent is reported as an unknown browser',
    },
    () => {
      expect(shortUserAgent('something else entirely')).toBe('unknown browser');
    },
  );
});

describe('issue fields include the computed summary', () => {
  behaviour(
    {
      id: 'diag.report-fields-include-triage',
      covers: 'src/diagnostics/report.ts#buildIssueFields',
      given: 'an issue report built from a diagnostics bundle',
      then: 'the issue form includes a non-empty triage block a maintainer can read first',
    },
    () => {
      const fields = buildIssueFields({ summary: 'x' }, bundle(), 'f.json');
      expect(typeof fields.triage).toBe('string');
      expect(fields.triage.length).toBeGreaterThan(0);
    },
  );

  /* claimed by diag.report-url-keeps-user-words */
  it('drops the triage block before the user’s own words', () => {
    const url = buildIssueUrl(
      buildIssueFields(
        { summary: 'the gantry stalls', steps: 'jog to 40' },
        bundle({
          log: {
            entries: Array.from({ length: 5 }, (_, i) =>
              entry({ level: 'error', tag: `t${i}`, msg: 'q'.repeat(2000) }),
            ),
            counters: {},
            dropped: 0,
            startedAt: 0,
          },
        }),
        'f.json',
      ),
    );
    const params = new URL(url).searchParams;
    expect(params.get('summary')).toBe('the gantry stalls');
    expect(params.get('steps')).toBe('jog to 40');
  });
});

describe('shortUserAgent browser precedence', () => {
  behaviour(
    {
      id: 'diag.report-short-ua-names-opera',
      covers: 'src/diagnostics/report.ts#shortUserAgent',
      given: 'an Opera user-agent that also contains Chrome and Safari tokens',
      then: 'an Opera user-agent is named Opera even though it also contains Chrome',
      why: 'every Chromium user-agent contains Chrome, so a misnamed browser sends a bug hunt the wrong way',
    },
    () => {
      // Every Chromium UA contains "Chrome", so precedence is what makes this
      // correct — a misattributed browser sends a bug hunt the wrong way.
      expect(shortUserAgent('Mozilla/5.0 (X11) Chrome/130.0 Safari/537.36 OPR/115.0')).toContain('Opera 115');
    },
  );

  behaviour(
    {
      id: 'diag.report-short-ua-chrome-despite-safari',
      covers: 'src/diagnostics/report.ts#shortUserAgent',
      given: 'a Chrome user-agent that also contains a Safari token',
      then: 'a Chrome user-agent is named Chrome even though it also contains Safari',
    },
    () => {
      expect(
        shortUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'),
      ).toContain('Chrome 130');
    },
  );

  behaviour(
    {
      id: 'diag.report-short-ua-names-safari',
      covers: 'src/diagnostics/report.ts#shortUserAgent',
      given: 'a Safari user-agent with Version/17.4 and no Chrome token',
      then: 'a real Safari user-agent is named Safari',
    },
    () => {
      expect(
        shortUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/605.1 Version/17.4 Safari/605.1.15'),
      ).toContain('Safari 17');
    },
  );
});
