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
      expect: {
        'app-version-and-sha': 'the environment block carries the app version with the sha in brackets',
        'firmware-version': 'the environment block carries the firmware version',
      },
      why: {
        'app-version-and-sha': 'the build identity is what decides whether a report is actionable',
      },
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
      expect: {
        'firmware-unknown': 'the environment block reports the firmware as unknown',
      },
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
      expect: {
        'app-bug-template': 'the issue form targets the app-bug template',
        'attachment-named': 'the issue form names the diagnostics attachment',
        'summary-in-title': 'the reporter\'s summary appears in the title',
      },
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
      expect: {
        'steps-not-provided': 'the issue form records the steps as not provided',
      },
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
      expect: {
        'failures-only': 'the issue report lists only the failure counts',
        'highest-first': 'the failure counts are listed highest first',
      },
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
      expect: {
        'counters-block-clean': 'the counter block states that no errors were recorded',
        'errors-block-clean': 'the error block states that none were recorded',
      },
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
      expect: {
        'error-listed': 'the report\'s error block lists the error with its timestamp',
        'non-errors-left-out': 'the error block carries no non-error entries',
      },
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
      expect: {
        'new-issue-on-mad': 'the prefilled link opens a new GitHub issue against the MaD repo',
        'app-bug-template': 'the link carries the app-bug template',
      },
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
      expect: {
        'within-url-budget': 'the issue link stays within the maximum length GitHub will open',
      },
      why: {
        'within-url-budget':
          'GitHub rejects very long URLs, and a long session must not silently produce a dead link',
      },
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
      expect: {
        'within-url-budget': 'the issue link stays within the maximum length GitHub will open',
        'errors-point-at-attachment':
          'the error block is replaced by a note pointing at the attached diagnostics file',
        'cheaper-blocks-kept': 'the summary, steps, and counters survive intact',
      },
      why: {
        'cheaper-blocks-kept':
          'the reporter\'s own words are irreplaceable; computed log excerpts can be rebuilt from the attached diagnostics file',
      },
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
      expect: {
        'empty-field-omitted': 'the empty field is left out of the prefilled link entirely',
      },
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
      expect: {
        'time-to-the-millisecond': 'the file name carries that time to the millisecond',
        'no-colons': 'the file name contains no colons',
      },
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
      expect: {
        'within-url-budget':
          'the summary is trimmed until the issue link fits the maximum length GitHub will open',
      },
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
      expect: {
        'within-url-budget': 'the encoded issue link stays within the maximum length GitHub will open',
      },
      why: {
        'within-url-budget': 'trimming by raw character count would undershoot on newlines and non-ASCII',
      },
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
      expect: {
        'new-issue-on-mad': 'the link still opens a new GitHub issue against the MaD repo',
        'app-bug-template': 'the link still carries the app-bug template',
        'summary-survives': 'the summary in the link is not empty',
      },
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
      expect: {
        'browser-and-platform': 'the browser line reads "Chrome 130 on Intel Mac OS X 10_15_7"',
      },
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
      expect: {
        'edge-named': 'the browser is reported as Edge 130',
      },
      why: {
        'edge-named':
          'every Chromium user-agent contains Chrome, so a misnamed browser sends a bug hunt the wrong way',
      },
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
      expect: {
        'unknown-browser': 'the browser line reads "unknown browser"',
      },
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
      expect: {
        'triage-present': 'the issue form carries a non-empty triage summary',
      },
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
      expect: {
        'opera-named': 'the browser is reported as Opera 115',
      },
      why: {
        'opera-named':
          'every Chromium user-agent contains Chrome, so a misnamed browser sends a bug hunt the wrong way',
      },
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
      expect: {
        'chrome-named': 'the browser is reported as Chrome 130',
      },
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
      expect: {
        'safari-named': 'the browser is reported as Safari 17',
      },
    },
    () => {
      expect(
        shortUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/605.1 Version/17.4 Safari/605.1.15'),
      ).toContain('Safari 17');
    },
  );
});
