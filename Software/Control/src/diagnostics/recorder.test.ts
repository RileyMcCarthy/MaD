import { describe, it, expect, beforeEach } from 'vitest';
import { record, diagnosticsSnapshot, resetDiagnostics } from './recorder';

describe('diagnostics recorder', () => {
  beforeEach(() => resetDiagnostics());

  it('records entries and tallies per-tag counters', () => {
    record('info', 'connected');
    record('error', 'device-error', 'boom');
    record('warn', 'timeout');
    record('warn', 'timeout');
    const s = diagnosticsSnapshot();
    expect(s.total).toBe(4);
    expect(s.entries).toHaveLength(4);
    expect(s.counters).toMatchObject({ connected: 1, 'device-error': 1, timeout: 2 });
    expect(s.entries[1]).toMatchObject({ level: 'error', tag: 'device-error', message: 'boom' });
  });

  it('bounds the ring but keeps the running total', () => {
    for (let i = 0; i < 1200; i++) record('info', 'tick', String(i));
    const s = diagnosticsSnapshot();
    expect(s.entries.length).toBe(1000); // CAPACITY
    expect(s.total).toBe(1200);
    // Oldest entries were dropped; newest retained.
    expect(s.entries[s.entries.length - 1].message).toBe('1199');
  });

  it('reset clears entries, counters, and total', () => {
    record('info', 'connected');
    resetDiagnostics();
    const s = diagnosticsSnapshot();
    expect(s.entries).toHaveLength(0);
    expect(s.total).toBe(0);
    expect(Object.keys(s.counters)).toHaveLength(0);
  });
});
