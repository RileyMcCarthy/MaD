/**
 * Computed triage summary for a diagnostics bundle.
 *
 * A maintainer opening a report should not have to read 5000 entries to find
 * out whether the link ever worked. This answers the first questions up front —
 * did it connect, did it stay healthy, what failed first, what failed most —
 * so the raw timeline becomes something you consult rather than something you
 * have to scan.
 *
 * Everything here is derived from the log; it adds no new capture.
 */

import type { LogEntry, LogSnapshot } from './log';

export interface TriageSummary {
  /** One-line verdict, suitable for an issue title or the top of a comment. */
  headline: string;
  sessionMs: number;
  entries: number;
  /** Entries evicted by ring wrap — a nonzero value means the log is truncated. */
  dropped: number;
  counts: { errors: number; warnings: number };
  /** Most frequent failure tags, worst first. */
  topFailures: Array<{ tag: string; count: number }>;
  firstError?: { at: number; tag: string; msg: string };
  lastError?: { at: number; tag: string; msg: string };
  /** Whether the app ever reached a working link this session. */
  everConnected: boolean;
  everResponded: boolean;
  /** Set when bytes arrived that never decoded — almost always baud or wiring. */
  undecodableTraffic: boolean;
  /** Observed sample rate from the last healthy aggregate, if any. */
  lastSampleRateHz?: number;
  /** Signals worth reading before anything else. */
  flags: string[];
}

const FAILURE_KEY = /error|nack|timeout|fail|trap|stall|jank|undecodable|abort|refus|reject/i;

function describe(e: LogEntry): { at: number; tag: string; msg: string } {
  return { at: e.t, tag: `${e.cat}/${e.tag}`, msg: e.msg ?? '' };
}

export function summariseForTriage(log: LogSnapshot): TriageSummary {
  const entries = log.entries;
  const errors = entries.filter((e) => e.level === 'error');
  const warnings = entries.filter((e) => e.level === 'warn');

  const has = (cat: string, tag: string): boolean =>
    entries.some((e) => e.cat === cat && e.tag === tag);

  const topFailures = Object.entries(log.counters)
    .filter(([key]) => FAILURE_KEY.test(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));

  const everConnected = has('store', 'connected') || has('device', 'connect');
  const undecodableTraffic = has('proto', 'undecodable');
  // A responding link is one that produced decoded sample traffic.
  const perf = entries.filter((e) => e.cat === 'perf' && e.tag === 'stream');
  const everResponded = perf.length > 0;
  const lastRate = perf[perf.length - 1]?.data?.rateHz;

  const flags: string[] = [];
  if (!everConnected) flags.push('never connected to a device');
  else if (!everResponded) flags.push('connected but the device never sent samples');
  if (undecodableTraffic) {
    flags.push('received bytes that never decoded — suspect baud rate, wiring, or firmware');
  }
  if (has('wasm', 'poll-trap')) flags.push('the protocol core trapped (WASM panic)');
  if (has('ui', 'render-crash')) flags.push('a screen crashed while rendering');
  if (has('flash', 'failed')) flags.push('a firmware flash failed');
  if (has('app', 'stall') || has('app', 'jank')) flags.push('the main thread stalled');
  if (log.dropped > 0) flags.push(`log truncated — ${log.dropped} entries evicted`);

  const sessionMs =
    entries.length > 0 ? Math.round(entries[entries.length - 1].t - log.startedAt) : 0;

  const headline =
    errors.length === 0 && flags.length === 0
      ? 'No errors recorded this session.'
      : [
          errors.length > 0 ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : '',
          warnings.length > 0 ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : '',
          flags[0] ?? '',
        ]
          .filter(Boolean)
          .join(' · ');

  const summary: TriageSummary = {
    headline,
    sessionMs,
    entries: entries.length,
    dropped: log.dropped,
    counts: { errors: errors.length, warnings: warnings.length },
    topFailures,
    everConnected,
    everResponded,
    undecodableTraffic,
    flags,
  };
  if (errors.length > 0) {
    // The FIRST error is usually the cause and the last is usually a symptom,
    // so a report that shows only one of them tends to mislead.
    summary.firstError = describe(errors[0]);
    summary.lastError = describe(errors[errors.length - 1]);
  }
  if (typeof lastRate === 'number') summary.lastSampleRateHz = lastRate;
  return summary;
}

/** Render the summary as plain text for an issue body or a terminal. */
export function formatTriage(t: TriageSummary): string {
  const lines = [
    t.headline,
    `Session: ${(t.sessionMs / 1000).toFixed(1)}s · ${t.entries} entries${
      t.dropped > 0 ? ` (+${t.dropped} evicted)` : ''
    }`,
    `Link: ${t.everConnected ? 'connected' : 'never connected'}${
      t.everConnected ? (t.everResponded ? ', device responded' : ', device never responded') : ''
    }${t.lastSampleRateHz !== undefined ? ` · ${t.lastSampleRateHz} Hz` : ''}`,
  ];
  if (t.flags.length > 0) lines.push('', 'Flags:', ...t.flags.map((f) => `  - ${f}`));
  if (t.firstError) lines.push('', `First error: ${t.firstError.tag} ${t.firstError.msg}`.trim());
  if (t.lastError && t.lastError.at !== t.firstError?.at) {
    lines.push(`Last error:  ${t.lastError.tag} ${t.lastError.msg}`.trim());
  }
  if (t.topFailures.length > 0) {
    lines.push('', 'Failure counts:', ...t.topFailures.map((f) => `  ${f.tag}: ${f.count}`));
  }
  return lines.join('\n');
}
