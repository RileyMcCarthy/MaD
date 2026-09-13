import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { summariseForTriage, formatTriage } from './triage';
import type { LogEntry, LogSnapshot } from './log';

let seq = 0;
function e(over: Partial<LogEntry> = {}): LogEntry {
  seq += 1;
  return {
    seq,
    t: Date.UTC(2026, 0, 1, 12, 0, 0) + seq * 1000,
    thread: 'main',
    level: 'info',
    cat: 'app',
    tag: 'boot',
    ...over,
  };
}

const snap = (entries: LogEntry[], over: Partial<LogSnapshot> = {}): LogSnapshot => ({
  entries,
  counters: {},
  dropped: 0,
  startedAt: Date.UTC(2026, 0, 1, 12, 0, 0),
  ...over,
});

describe('summariseForTriage', () => {
  behaviour(
    {
      id: 'diag.triage-healthy-session',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'a session log with only a connected event and a stream event',
      expect: {
        'zero-errors': 'triage reports zero errors',
        'no-flags': 'triage raises no warning flags',
      },
    },
    () => {
      const t = summariseForTriage(
        snap([e({ cat: 'store', tag: 'connected' }), e({ cat: 'perf', tag: 'stream' })]),
      );
      expect(t.headline).toMatch(/No errors/);
      expect(t.flags).toEqual([]);
      expect(t.counts.errors).toBe(0);
    },
  );

  behaviour(
    {
      id: 'diag.triage-first-and-last-error',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'a session with a protocol "bad crc" error followed by a device "link-lost" error',
      expect: {
        'first-error': 'the triage summary reports the first error',
        'last-error': 'the triage summary reports the last error as a separate entry',
      },
      why: {
        'first-error': 'the first error is usually the cause, so a report showing only the last one misleads',
        'last-error': 'the last error is usually a symptom, so a report showing only the first one misleads',
      },
    },
    () => {
      // The first is usually the cause and the last usually a symptom, so a
      // report showing only one of them misleads.
      const t = summariseForTriage(
        snap([
          e({ level: 'error', cat: 'proto', tag: 'error', msg: 'bad crc' }),
          e({ level: 'error', cat: 'device', tag: 'link-lost', msg: 'gone' }),
        ]),
      );
      expect(t.firstError?.msg).toBe('bad crc');
      expect(t.lastError?.msg).toBe('gone');
    },
  );

  behaviour(
    {
      id: 'diag.triage-never-connected',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'a session log with no connected event',
      expect: {
        'never-reached-a-device': 'triage flags the session as never having reached a device',
      },
    },
    () => {
      const t = summariseForTriage(snap([e()]));
      expect(t.everConnected).toBe(false);
      expect(t.flags).toContain('never connected to a device');
    },
  );

  behaviour(
    {
      id: 'diag.triage-connected-but-silent',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'a session log with a connected event and no sample-stream event',
      expect: {
        'silent-device-flag': 'triage raises a silent-device flag',
        'never-responded': 'triage records that the device never responded',
      },
    },
    () => {
      const t = summariseForTriage(snap([e({ cat: 'store', tag: 'connected' })]));
      expect(t.everConnected).toBe(true);
      expect(t.everResponded).toBe(false);
      expect(t.flags).toContain('connected but the device never sent samples');
    },
  );

  behaviour(
    {
      id: 'diag.triage-undecodable-traffic',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'a session that connected and then logged undecodable protocol traffic',
      expect: {
        'traffic-flagged': 'the summary flags the traffic',
        'what-to-check': 'the flag names baud rate, wiring, or firmware as what to check',
      },
    },
    () => {
      const t = summariseForTriage(
        snap([e({ cat: 'store', tag: 'connected' }), e({ level: 'error', cat: 'proto', tag: 'undecodable' })]),
      );
      expect(t.undecodableTraffic).toBe(true);
      expect(t.flags.join(' ')).toMatch(/baud rate, wiring, or firmware/);
    },
  );

  behaviour(
    {
      id: 'diag.triage-truncation-visible',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'a session whose crash log dropped 120 entries',
      expect: {
        'eviction-flagged': 'the summary raises a flag saying 120 entries were evicted',
      },
      why: {
        'eviction-flagged': 'a maintainer must know the log is incomplete before treating it as the whole session',
      },
    },
    () => {
      const t = summariseForTriage(snap([e()], { dropped: 120 }));
      expect(t.flags.join(' ')).toContain('120 entries evicted');
    },
  );

  behaviour(
    {
      id: 'diag.triage-ranks-failure-counters',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'a session whose counters include 9 timeouts, 2 nacks, and 900 ordinary transmits',
      expect: {
        'timeouts-first': 'the summary lists the timeouts ahead of the nacks',
        'transmits-left-out': 'the summary leaves out the transmit count',
      },
    },
    () => {
      const t = summariseForTriage(
        snap([e()], { counters: { 'proto:nack': 2, 'proto:tx': 900, 'proto:timeout': 9 } }),
      );
      expect(t.topFailures).toEqual([
        { tag: 'proto:timeout', count: 9 },
        { tag: 'proto:nack', count: 2 },
      ]);
    },
  );

  behaviour(
    {
      id: 'diag.triage-failed-firmware-flash',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'a session log with a firmware-flash failure',
      expect: {
        'flash-failure-flagged': 'the triage flags include a failed firmware flash',
      },
    },
    () => {
      const t = summariseForTriage(snap([e({ level: 'error', cat: 'flash', tag: 'failed' })]));
      expect(t.flags).toContain('a firmware flash failed');
    },
  );

  behaviour(
    {
      id: 'diag.triage-last-sample-rate',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'a session whose last stream event recorded 99.4 Hz',
      expect: {
        'sample-rate': 'the triage summary reports the session sample rate as 99.4 Hz',
      },
    },
    () => {
      const t = summariseForTriage(
        snap([e({ cat: 'perf', tag: 'stream', data: { rateHz: 99.4 } })]),
      );
      expect(t.lastSampleRateHz).toBe(99.4);
    },
  );

  behaviour(
    {
      id: 'diag.triage-empty-log',
      covers: 'src/diagnostics/triage.ts#summariseForTriage',
      given: 'an empty session log',
      expect: {
        'empty-summary': 'triage reports zero entries and zero duration',
        'text-renders': 'the readable text renders without error',
      },
    },
    () => {
      const t = summariseForTriage(snap([]));
      expect(t.entries).toBe(0);
      expect(t.sessionMs).toBe(0);
      expect(() => formatTriage(t)).not.toThrow();
    },
  );
});

describe('formatTriage', () => {
  behaviour(
    {
      id: 'diag.triage-format-leads-with-verdict',
      covers: 'src/diagnostics/triage.ts#formatTriage',
      given: 'a session that connected and then logged undecodable protocol traffic',
      expect: {
        'leads-with-error-count': 'the readable triage text leads with the error count',
        'baud-rate-hint': 'the text includes the baud-rate hint',
        'first-error-named': 'the text names the first error',
      },
    },
    () => {
      const text = formatTriage(
        summariseForTriage(
          snap([
            e({ cat: 'store', tag: 'connected' }),
            e({ level: 'error', cat: 'proto', tag: 'undecodable', msg: 'garbage' }),
          ]),
        ),
      );
      expect(text.split('\n')[0]).toMatch(/1 error/);
      expect(text).toContain('baud rate');
      expect(text).toContain('First error: proto/undecodable');
    },
  );

  behaviour(
    {
      id: 'diag.triage-format-single-error-once',
      covers: 'src/diagnostics/triage.ts#formatTriage',
      given: 'a session with exactly one error',
      expect: {
        'named-once': 'the readable triage text names that error exactly once',
      },
    },
    () => {
      const text = formatTriage(
        summariseForTriage(snap([e({ level: 'error', cat: 'proto', tag: 'error', msg: 'only' })])),
      );
      expect(text.match(/only/g)?.length).toBe(1);
    },
  );
});
