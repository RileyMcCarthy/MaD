import { describe, it, expect } from 'vitest';
import {
  buildIssueFields,
  buildIssueUrl,
  bundleFileName,
  environmentBlock,
  ISSUE_URL_MAX,
  ISSUE_TEMPLATE,
} from './report';
import type { DiagnosticsBundle } from './exportBundle';
import type { LogEntry } from './log';

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
  return {
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
  it('leads with the build identity that makes a report actionable', () => {
    const text = environmentBlock(bundle());
    expect(text).toContain('App: 0.1.0 (abc1234)');
    expect(text).toContain('Firmware: 1.2.3');
  });

  it('does not invent a firmware version when none is known', () => {
    const text = environmentBlock(
      bundle({ device: { connection: 'disconnected', responding: false, firmwareVersion: null, portLabel: null } }),
    );
    expect(text).toContain('Firmware: unknown');
  });
});

describe('buildIssueFields', () => {
  it('targets the issue template and names the attachment', () => {
    const fields = buildIssueFields({ summary: 'jog does nothing' }, bundle(), 'mad-diagnostics-x.json');
    expect(fields.template).toBe(ISSUE_TEMPLATE);
    expect(fields.attachment).toBe('mad-diagnostics-x.json');
    expect(fields.title).toContain('jog does nothing');
  });

  it('marks absent repro steps rather than sending an empty field', () => {
    expect(buildIssueFields({ summary: 'x', steps: '   ' }, bundle(), 'f.json').steps).toBe('(not provided)');
  });

  it('surfaces only failure-ish counters, most frequent first', () => {
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
  });

  it('says so plainly when nothing went wrong', () => {
    const fields = buildIssueFields({ summary: 'x' }, bundle(), 'f.json');
    expect(fields.counters).toMatch(/No errors/);
    expect(fields.errors).toBe('None recorded.');
  });

  it('includes the most recent errors with timestamps', () => {
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
  });
});

describe('buildIssueUrl', () => {
  it('produces a template-targeted issue URL', () => {
    const url = buildIssueUrl(buildIssueFields({ summary: 'broken' }, bundle(), 'f.json'));
    expect(url.startsWith('https://github.com/RileyMcCarthy/MaD/issues/new?')).toBe(true);
    expect(url).toContain(`template=${ISSUE_TEMPLATE}`);
  });

  it('stays under the URL budget even with a huge log', () => {
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
  });

  it("keeps the user's own words and drops derived blocks first", () => {
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
  });

  it('omits empty values instead of sending blank params', () => {
    expect(buildIssueUrl({ title: 'a', steps: '' })).not.toContain('steps=');
  });
});

describe('bundleFileName', () => {
  it('is filesystem-safe and timestamped', () => {
    const name = bundleFileName(new Date(Date.UTC(2026, 7, 20, 13, 45, 12, 345)));
    expect(name).toBe('mad-diagnostics-2026-08-20T13-45-12-345Z.json');
    expect(name).not.toMatch(/[:]/);
  });
});

describe('buildIssueUrl under pathological input', () => {
  it('fits the budget even when the summary alone dwarfs it', () => {
    // A user can paste anything into the summary box; percent-encoding then
    // expands it further. The link must still be one GitHub will open.
    const url = buildIssueUrl(
      buildIssueFields({ summary: 'x'.repeat(200_000) }, bundle(), 'f.json'),
    );
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
  });

  it('fits when every character percent-expands', () => {
    // Newlines and non-ASCII cost 3 bytes each once encoded — the case a
    // single raw-length subtraction would undershoot.
    const url = buildIssueUrl(
      buildIssueFields({ summary: '\n…'.repeat(20_000) }, bundle(), 'f.json'),
    );
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
  });

  it('still produces a usable issue link after truncation', () => {
    const url = buildIssueUrl(buildIssueFields({ summary: 'q'.repeat(50_000) }, bundle(), 'f.json'));
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/RileyMcCarthy/MaD/issues/new');
    expect(parsed.searchParams.get('template')).toBe(ISSUE_TEMPLATE);
    expect((parsed.searchParams.get('summary') ?? '').length).toBeGreaterThan(0);
  });
});
