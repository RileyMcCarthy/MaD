import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LOG_CAPACITY,
  LOG_FLUSH_INTERVAL_MS,
  LOG_FLUSH_MAX_ENTRIES,
  SANITIZE_STRING_MAX,
  clearLog,
  flushLog,
  getLogFilter,
  ingestWorkerBatch,
  logSnapshot,
  logger,
  mirrorMatches,
  nowMs,
  sanitize,
  setLogFilter,
  setLogSink,
  subscribeLog,
  type LogEntry,
} from './log';

/** A worker-shaped entry, as it would arrive over Comlink. */
function workerEntry(seq: number, t: number, tag: string): LogEntry {
  return { seq, t, thread: 'worker', level: 'info', cat: 'device', tag };
}

describe('log ring', () => {
  beforeEach(() => {
    setLogSink(null);
    setLogFilter('', 'error'); // console mirroring off; capture is unaffected
    clearLog();
  });

  it('captures every level regardless of the console filter', () => {
    const log = logger('proto');
    log.debug('rx', 'frame', { id: 7 });
    log.info('tx');
    log.warn('retry');
    log.error('nack', 'bad crc');

    const { entries } = logSnapshot();
    expect(entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(mirrorMatches('proto', 'debug')).toBe(false); // filter is off …
    expect(entries[0].data).toEqual({ id: 7 }); // … but the ring still has it
  });

  it('stamps thread, monotonic seq, and a wall-clock time base', () => {
    const before = nowMs();
    logger('app').info('boot');
    logger('app').info('ready');
    const { entries, startedAt } = logSnapshot();

    expect(entries[0].thread).toBe('main');
    expect(entries[1].seq).toBe(entries[0].seq + 1);
    expect(entries[0].t).toBeGreaterThanOrEqual(before);
    // Wall clock, not performance.now(): comparable with Date.now().
    expect(entries[0].t).toBeGreaterThan(Date.now() - 60_000);
    expect(startedAt).toBeLessThanOrEqual(entries[0].t);
  });

  it('omits empty msg and absent data rather than storing undefined keys', () => {
    logger('app').info('bare');
    logger('app').info('empty', '');
    const { entries } = logSnapshot();
    expect('msg' in entries[0]).toBe(false);
    expect('data' in entries[0]).toBe(false);
    expect('msg' in entries[1]).toBe(false);
  });

  it('bounds the ring, evicting oldest and counting the drops', () => {
    const overflow = 1000;
    const log = logger('perf');
    for (let i = 0; i < LOG_CAPACITY + overflow; i++) log.debug('tick', String(i));

    const { entries, dropped } = logSnapshot();
    expect(entries).toHaveLength(LOG_CAPACITY);
    expect(dropped).toBe(overflow);
    expect(entries[0].msg).toBe(String(overflow)); // oldest survivor
    expect(entries[entries.length - 1].msg).toBe(String(LOG_CAPACITY + overflow - 1));
  });

  it('counts per cat:tag, and the counters outlive eviction', () => {
    const dev = logger('device');
    const proto = logger('proto');
    dev.error('nack');
    dev.error('nack');
    proto.warn('nack'); // same tag, different category → separate counter
    dev.info('connect');

    expect(logSnapshot().counters).toMatchObject({
      'device:nack': 2,
      'proto:nack': 1,
      'device:connect': 1,
    });

    for (let i = 0; i < LOG_CAPACITY; i++) dev.debug('flood');
    const after = logSnapshot();
    expect(after.entries.some((e) => e.tag === 'nack')).toBe(false); // evicted …
    expect(after.counters['device:nack']).toBe(2); // … but still counted
  });

  it('notifies subscribers and stops after the returned remover runs', () => {
    const seen: string[] = [];
    const off = subscribeLog((e) => seen.push(e.tag));
    logger('ui').info('route');
    off();
    logger('ui').info('click');
    expect(seen).toEqual(['route']);
  });

  it('survives a subscriber that throws', () => {
    const off = subscribeLog(() => {
      throw new Error('bad tail');
    });
    expect(() => logger('ui').info('route')).not.toThrow();
    off();
    expect(logSnapshot().counters['app:log-subscriber-error']).toBe(1);
  });

  it('clearLog resets entries, counters and drops but keeps seq unique', () => {
    logger('app').info('one');
    const firstSeq = logSnapshot().entries[0].seq;
    clearLog();
    logger('app').info('two');
    const snap = logSnapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.dropped).toBe(0);
    expect(Object.keys(snap.counters)).toEqual(['app:two']);
    expect(snap.entries[0].seq).toBeGreaterThan(firstSeq);
  });
});

describe('console filter', () => {
  beforeEach(() => {
    setLogSink(null);
    clearLog();
  });
  afterEach(() => setLogFilter('', 'error'));

  it('parses a wildcard, an explicit list, and off', () => {
    setLogFilter('*', 'debug');
    expect(getLogFilter()).toEqual({ cats: '*', level: 'debug' });
    expect(mirrorMatches('wasm', 'debug')).toBe(true);

    setLogFilter('device, proto', 'info');
    expect(mirrorMatches('device', 'info')).toBe(true);
    expect(mirrorMatches('proto', 'error')).toBe(true);
    expect(mirrorMatches('ui', 'error')).toBe(false); // not in the list

    setLogFilter('');
    expect(mirrorMatches('device', 'error')).toBe(false);
  });

  it('applies the level threshold', () => {
    setLogFilter('*', 'warn');
    expect(mirrorMatches('app', 'debug')).toBe(false);
    expect(mirrorMatches('app', 'info')).toBe(false);
    expect(mirrorMatches('app', 'warn')).toBe(true);
    expect(mirrorMatches('app', 'error')).toBe(true);
  });

  it('keeps the current level when setLogFilter omits it', () => {
    setLogFilter('*', 'warn');
    setLogFilter('device');
    expect(getLogFilter()).toEqual({ cats: 'device', level: 'warn' });
  });

  it('treats a list of only separators as off', () => {
    setLogFilter(' , , ', 'debug');
    expect(mirrorMatches('device', 'error')).toBe(false);
  });
});

describe('sanitize', () => {
  it('passes scalars through and normalises JSON-hostile numbers', () => {
    expect(sanitize({ a: 1, b: true, c: null })).toEqual({ a: 1, b: true, c: null });
    expect(sanitize({ n: NaN, i: Infinity })).toEqual({ n: 'NaN', i: 'Infinity' });
    expect(sanitize({ big: 10n })).toEqual({ big: '10n' });
    expect(sanitize({ u: undefined })).toEqual({ u: null });
    expect(sanitize(undefined)).toBeUndefined();
  });

  it('truncates long strings with a marker that reports the loss', () => {
    const s = 'x'.repeat(500);
    const out = sanitize({ s })!.s as string;
    expect(out.startsWith('x'.repeat(SANITIZE_STRING_MAX))).toBe(true);
    expect(out).toContain(`…(+${500 - SANITIZE_STRING_MAX} chars)`);
    expect(out.length).toBeLessThan(240);
  });

  it('redacts byte payloads to a length, never contents', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(sanitize({ bytes })).toEqual({ bytes: { bytes: 4 } });
    expect(sanitize({ buf: new ArrayBuffer(64) })).toEqual({ buf: { bytes: 64 } });
    expect(sanitize({ view: new DataView(new ArrayBuffer(8)) })).toEqual({ view: { bytes: 8 } });
    expect(JSON.stringify(sanitize({ bytes }))).not.toContain('"1"');
  });

  it('flattens nested objects at depth 1', () => {
    const small = sanitize({ o: { a: 1, b: 'two' } })!.o;
    expect(small).toBe('{"a":1,"b":"two"}'); // summarised, not walked

    const big = sanitize({ o: { blob: 'y'.repeat(400) } })!.o as string;
    expect(big.startsWith('Object ')).toBe(true);
    expect(big.length).toBeLessThan(260);

    class Widget {
      x = 1;
    }
    expect(sanitize({ w: new Widget() })).toEqual({ w: '{"x":1}' });
    expect(sanitize({ a: [1, 2, 3] })).toEqual({ a: '[1,2,3]' });
    expect(sanitize({ m: new Map([['k', 1]]), s: new Set([1, 2]) })).toEqual({
      m: 'Map(1)',
      s: 'Set(2)',
    });
  });

  it('degrades circular structures to a type name instead of throwing', () => {
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;
    expect(sanitize({ c: circular })).toEqual({ c: 'Object' });
  });

  it('keeps Errors readable but bounded', () => {
    const err = new TypeError('kaboom');
    err.stack = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const out = sanitize({ err })!.err as { name: string; message: string; stack: string };
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe('kaboom');
    expect(out.stack.split('\n')).toHaveLength(5);
  });

  it('drops functions and symbols', () => {
    const out = sanitize({ fn: () => 0, sym: Symbol('s'), keep: 1 })!;
    expect(Object.keys(out)).toEqual(['keep']);
  });

  it('reduces filesystem paths to a basename', () => {
    expect(sanitize({ path: '/Users/someone/Secret Project/data' })).toEqual({ path: 'data' });
    expect(sanitize({ dataDir: 'C:\\Users\\me\\MaD\\runs' })).toEqual({ dataDir: 'runs' });
    expect(sanitize({ fileName: 'run-1.csv' })).toEqual({ fileName: 'run-1.csv' });
    expect(sanitize({ where: '/Users/someone/data/run.csv' })).toEqual({ where: 'run.csv' });
    // URLs are not filesystem paths.
    expect(sanitize({ url: 'https://example.com/a/b' })).toEqual({ url: 'https://example.com/a/b' });
    // File System Access handles: identity only.
    expect(sanitize({ h: { kind: 'directory', name: 'MaD Data' } })).toEqual({
      h: 'directory:MaD Data',
    });
  });

  it('caps key count and never throws on hostile input', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) wide[`k${i}`] = i;
    const out = sanitize(wide)!;
    expect(Object.keys(out)).toHaveLength(33); // 32 kept + _keysDropped
    expect(out._keysDropped).toBe(18);

    const hostile = {
      get boom(): never {
        throw new Error('getter');
      },
    };
    expect(sanitize(hostile)).toEqual({ boom: '<unreadable>' });
  });
});

describe('cross-thread merge', () => {
  beforeEach(() => {
    setLogSink(null);
    setLogFilter('', 'error');
    clearLog();
  });

  it('folds worker batches into the same ring, sorted by wall-clock t', () => {
    logger('app').info('main-a');
    const mainA = logSnapshot().entries[0];
    logger('app').info('main-b');
    const mainB = logSnapshot().entries[1];

    // A batch that was produced BETWEEN the two main entries but arrived late.
    ingestWorkerBatch([
      workerEntry(1, mainA.t + (mainB.t - mainA.t) / 2, 'worker-mid'),
      workerEntry(2, mainB.t + 1000, 'worker-late'),
    ]);

    const { entries } = logSnapshot();
    expect(entries.map((e) => e.tag)).toEqual(['main-a', 'worker-mid', 'main-b', 'worker-late']);
    expect(entries.map((e) => e.thread)).toEqual(['main', 'worker', 'main', 'worker']);
    expect(entries.every((e, i) => i === 0 || entries[i - 1].t <= e.t)).toBe(true);
  });

  it('labels ingested entries as worker even if the batch says otherwise', () => {
    ingestWorkerBatch([{ ...workerEntry(1, nowMs(), 'mislabelled'), thread: 'main' }]);
    expect(logSnapshot().entries[0].thread).toBe('worker');
  });

  it('counts ingested entries into the shared counters', () => {
    ingestWorkerBatch([workerEntry(1, nowMs(), 'nack'), workerEntry(2, nowMs(), 'nack')]);
    expect(logSnapshot().counters['device:nack']).toBe(2);
  });

  it('sorts stably: seq order within a thread, arrival order across threads', () => {
    const t = nowMs();
    // Same-thread ties resolve by seq even when handed to sort out of order.
    ingestWorkerBatch([workerEntry(9, t, 'w-second'), workerEntry(8, t, 'w-first')]);
    const tags = logSnapshot().entries.map((e) => e.tag);
    expect(tags).toEqual(['w-first', 'w-second']);

    clearLog();
    logger('app').info('main-first');
    const mainT = logSnapshot().entries[0].t;
    ingestWorkerBatch([workerEntry(1, mainT, 'worker-same-t')]);
    // Cross-thread tie: insertion order is preserved rather than invented.
    expect(logSnapshot().entries.map((e) => e.tag)).toEqual(['main-first', 'worker-same-t']);
  });
});

describe('worker → main batching', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setLogFilter('', 'error');
    clearLog();
  });

  afterEach(() => {
    setLogSink(null);
    vi.useRealTimers();
  });

  it('flushes on the interval, not per entry', () => {
    const batches: LogEntry[][] = [];
    setLogSink((entries) => void batches.push(entries));

    logger('device').info('a');
    logger('device').info('b');
    expect(batches).toHaveLength(0); // nothing per-entry

    vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((e) => e.tag)).toEqual(['a', 'b']);

    logger('device').info('c');
    vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
  });

  it('flushes early once the entry threshold is hit', () => {
    const batches: LogEntry[][] = [];
    setLogSink((entries) => void batches.push(entries));

    for (let i = 0; i < LOG_FLUSH_MAX_ENTRIES; i++) logger('proto').debug('rx', String(i));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(LOG_FLUSH_MAX_ENTRIES);

    vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS);
    expect(batches).toHaveLength(1); // the timer was cancelled, no empty batch
  });

  it('flushes on demand (worker shutdown path) and when the sink is removed', () => {
    const batches: LogEntry[][] = [];
    setLogSink((entries) => void batches.push(entries));

    logger('device').warn('closing');
    flushLog();
    expect(batches[0].map((e) => e.tag)).toEqual(['closing']);

    logger('device').warn('last-gasp');
    setLogSink(null); // teardown must not swallow buffered entries
    expect(batches[1].map((e) => e.tag)).toEqual(['last-gasp']);
  });

  it('keeps logging when the sink is dead', () => {
    setLogSink(() => {
      throw new Error('proxy released');
    });
    logger('device').info('orphan');
    expect(() => flushLog()).not.toThrow();
    expect(logSnapshot().counters['app:log-flush-failed']).toBe(1);
    // The entry is still in the local ring even though transport failed.
    expect(logSnapshot().entries.some((e) => e.tag === 'orphan')).toBe(true);
  });

  it('buffers nothing when no sink is installed', () => {
    setLogSink(null);
    logger('app').info('local-only');
    const batches: LogEntry[][] = [];
    setLogSink((entries) => void batches.push(entries));
    flushLog();
    expect(batches).toHaveLength(0);
  });
});

describe('debug hook', () => {
  it('exposes snapshot/clear/setFilter on globalThis for e2e', () => {
    expect(globalThis.__madLog).toBeDefined();
    globalThis.__madLog!.clear();
    logger('app').info('hooked');
    expect(globalThis.__madLog!.snapshot().entries.map((e) => e.tag)).toContain('hooked');
  });
});
