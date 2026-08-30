import { describe, it, expect } from 'vitest';
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
  it('says plainly when nothing went wrong', () => {
    const t = summariseForTriage(
      snap([e({ cat: 'store', tag: 'connected' }), e({ cat: 'perf', tag: 'stream' })]),
    );
    expect(t.headline).toMatch(/No errors/);
    expect(t.flags).toEqual([]);
    expect(t.counts.errors).toBe(0);
  });

  it('reports the first error and the last separately', () => {
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
  });

  it('flags never having connected', () => {
    const t = summariseForTriage(snap([e()]));
    expect(t.everConnected).toBe(false);
    expect(t.flags).toContain('never connected to a device');
  });

  it('distinguishes connected-but-silent from never connected', () => {
    const t = summariseForTriage(snap([e({ cat: 'store', tag: 'connected' })]));
    expect(t.everConnected).toBe(true);
    expect(t.everResponded).toBe(false);
    expect(t.flags).toContain('connected but the device never sent samples');
  });

  it('surfaces undecodable traffic with an actionable hint', () => {
    const t = summariseForTriage(
      snap([e({ cat: 'store', tag: 'connected' }), e({ level: 'error', cat: 'proto', tag: 'undecodable' })]),
    );
    expect(t.undecodableTraffic).toBe(true);
    expect(t.flags.join(' ')).toMatch(/baud rate, wiring, or firmware/);
  });

  it('makes log truncation visible', () => {
    const t = summariseForTriage(snap([e()], { dropped: 120 }));
    expect(t.flags.join(' ')).toContain('120 entries evicted');
  });

  it('ranks failure counters worst-first and ignores healthy ones', () => {
    const t = summariseForTriage(
      snap([e()], { counters: { 'proto:nack': 2, 'proto:tx': 900, 'proto:timeout': 9 } }),
    );
    expect(t.topFailures).toEqual([
      { tag: 'proto:timeout', count: 9 },
      { tag: 'proto:nack', count: 2 },
    ]);
  });

  it('picks up a failed firmware flash', () => {
    const t = summariseForTriage(snap([e({ level: 'error', cat: 'flash', tag: 'failed' })]));
    expect(t.flags).toContain('a firmware flash failed');
  });

  it('carries the last observed sample rate', () => {
    const t = summariseForTriage(
      snap([e({ cat: 'perf', tag: 'stream', data: { rateHz: 99.4 } })]),
    );
    expect(t.lastSampleRateHz).toBe(99.4);
  });

  it('survives an empty log', () => {
    const t = summariseForTriage(snap([]));
    expect(t.entries).toBe(0);
    expect(t.sessionMs).toBe(0);
    expect(() => formatTriage(t)).not.toThrow();
  });
});

describe('formatTriage', () => {
  it('leads with the verdict and includes the flags', () => {
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
  });

  it('does not repeat a single error as both first and last', () => {
    const text = formatTriage(
      summariseForTriage(snap([e({ level: 'error', cat: 'proto', tag: 'error', msg: 'only' })])),
    );
    expect(text.match(/only/g)?.length).toBe(1);
  });
});
