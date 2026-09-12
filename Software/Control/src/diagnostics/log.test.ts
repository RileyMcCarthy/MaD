import { describe, expect, beforeEach, afterEach, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
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

  behaviour(
    {
      id: 'diag.log-captures-every-level',
      covers: 'src/diagnostics/log.ts#logger',
      given: 'the console filter is off and debug, info, warn, and error events are logged',
      then: 'the crash log captures every severity even when the console is quiet',
      why: 'a bug report must be full-detail even when the console was quiet',
    },
    () => {
      const log = logger('proto');
      log.debug('rx', 'frame', { id: 7 });
      log.info('tx');
      log.warn('retry');
      log.error('nack', 'bad crc');

      const { entries } = logSnapshot();
      expect(entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
      expect(mirrorMatches('proto', 'debug')).toBe(false); // filter is off …
      expect(entries[0].data).toEqual({ id: 7 }); // … but the ring still has it
    },
  );

  behaviour(
    {
      id: 'diag.log-stamps-thread-seq-wall-clock',
      covers: 'src/diagnostics/log.ts#logger',
      given: 'two events are logged on the main thread',
      then: 'each crash-log entry is stamped with the main thread, a rising sequence number, and a wall-clock time comparable with the clock',
      why: 'worker and main-thread clocks must share a wall-clock so a merged timeline can be read',
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.log-omits-empty-message-and-data',
      covers: 'src/diagnostics/log.ts#logger',
      given: 'a log event with no message and another with an empty message',
      then: 'a crash-log entry with no message or data omits those fields entirely',
    },
    () => {
      logger('app').info('bare');
      logger('app').info('empty', '');
      const { entries } = logSnapshot();
      expect('msg' in entries[0]).toBe(false);
      expect('data' in entries[0]).toBe(false);
      expect('msg' in entries[1]).toBe(false);
    },
  );

  behaviour(
    {
      id: 'diag.log-bounds-and-counts-drops',
      covers: 'src/diagnostics/log.ts#logSnapshot',
      given: 'more events than the crash log can retain',
      then: 'the crash log keeps only its capacity of newest events and counts how many older ones were dropped',
      why: 'a truncated log must say it is truncated so a maintainer does not treat it as the whole session',
    },
    () => {
      const overflow = 1000;
      const log = logger('perf');
      for (let i = 0; i < LOG_CAPACITY + overflow; i++) log.debug('tick', String(i));

      const { entries, dropped } = logSnapshot();
      expect(entries).toHaveLength(LOG_CAPACITY);
      expect(dropped).toBe(overflow);
      expect(entries[0].msg).toBe(String(overflow)); // oldest survivor
      expect(entries[entries.length - 1].msg).toBe(String(LOG_CAPACITY + overflow - 1));
    },
  );

  behaviour(
    {
      id: 'diag.log-counters-outlive-eviction',
      covers: 'src/diagnostics/log.ts#logSnapshot',
      given: 'matching events are counted, then the crash log is flooded until those events fall out',
      then: 'per-kind event counters survive after the events themselves have been dropped from the crash log',
      why: 'how many failures this session had must stay accurate after the log wraps',
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.log-subscriber-stops-after-remove',
      covers: 'src/diagnostics/log.ts#subscribeLog',
      given: 'a live-tail subscriber is attached, one event is logged, then the subscriber is removed',
      then: 'a crash-log subscriber sees events until it is removed, and nothing after',
    },
    () => {
      const seen: string[] = [];
      const off = subscribeLog((e) => seen.push(e.tag));
      logger('ui').info('route');
      off();
      logger('ui').info('click');
      expect(seen).toEqual(['route']);
    },
  );

  behaviour(
    {
      id: 'diag.log-survives-throwing-subscriber',
      covers: 'src/diagnostics/log.ts#subscribeLog',
      given: 'a live-tail subscriber throws when an event arrives',
      then: 'a throwing crash-log subscriber does not prevent the event from being logged, and the failure is counted',
      why: 'a broken live tail must never break logging',
    },
    () => {
      const off = subscribeLog(() => {
        throw new Error('bad tail');
      });
      expect(() => logger('ui').info('route')).not.toThrow();
      off();
      expect(logSnapshot().counters['app:log-subscriber-error']).toBe(1);
    },
  );

  behaviour(
    {
      id: 'diag.log-clear-keeps-seq-unique',
      covers: 'src/diagnostics/log.ts#clearLog',
      given: 'the crash log is cleared after recording an event, then a new event is logged',
      then: 'clearing the crash log drops retained events, counters, and drop counts, while new events keep a unique sequence number',
    },
    () => {
      logger('app').info('one');
      const firstSeq = logSnapshot().entries[0].seq;
      clearLog();
      logger('app').info('two');
      const snap = logSnapshot();
      expect(snap.entries).toHaveLength(1);
      expect(snap.dropped).toBe(0);
      expect(Object.keys(snap.counters)).toEqual(['app:two']);
      expect(snap.entries[0].seq).toBeGreaterThan(firstSeq);
    },
  );
});

describe('console filter', () => {
  beforeEach(() => {
    setLogSink(null);
    clearLog();
  });
  afterEach(() => setLogFilter('', 'error'));

  behaviour(
    {
      id: 'diag.log-filter-wildcard-list-off',
      covers: 'src/diagnostics/log.ts#setLogFilter',
      given: 'the console filter is set to all categories, then a named list, then empty',
      then: 'the console filter accepts all categories, a named list, or off',
    },
    () => {
      setLogFilter('*', 'debug');
      expect(getLogFilter()).toEqual({ cats: '*', level: 'debug' });
      expect(mirrorMatches('wasm', 'debug')).toBe(true);

      setLogFilter('device, proto', 'info');
      expect(mirrorMatches('device', 'info')).toBe(true);
      expect(mirrorMatches('proto', 'error')).toBe(true);
      expect(mirrorMatches('ui', 'error')).toBe(false); // not in the list

      setLogFilter('');
      expect(mirrorMatches('device', 'error')).toBe(false);
    },
  );

  behaviour(
    {
      id: 'diag.log-filter-level-threshold',
      covers: 'src/diagnostics/log.ts#mirrorMatches',
      given: 'the console filter is set to warn and above',
      then: 'the console filter hides debug and info and shows warn and error',
    },
    () => {
      setLogFilter('*', 'warn');
      expect(mirrorMatches('app', 'debug')).toBe(false);
      expect(mirrorMatches('app', 'info')).toBe(false);
      expect(mirrorMatches('app', 'warn')).toBe(true);
      expect(mirrorMatches('app', 'error')).toBe(true);
    },
  );

  behaviour(
    {
      id: 'diag.log-filter-keeps-level',
      covers: 'src/diagnostics/log.ts#setLogFilter',
      given: 'the console filter level is warn, then only the category list is changed',
      then: 'changing the console filter\'s categories leaves the severity threshold in place',
    },
    () => {
      setLogFilter('*', 'warn');
      setLogFilter('device');
      expect(getLogFilter()).toEqual({ cats: 'device', level: 'warn' });
    },
  );

  behaviour(
    {
      id: 'diag.log-filter-separators-only-off',
      covers: 'src/diagnostics/log.ts#setLogFilter',
      given: 'the console filter is set to a string of commas and spaces',
      then: 'a console filter made only of separators is treated as off',
    },
    () => {
      setLogFilter(' , , ', 'debug');
      expect(mirrorMatches('device', 'error')).toBe(false);
    },
  );
});

describe('sanitize', () => {
  behaviour(
    {
      id: 'diag.log-sanitize-scalars',
      covers: 'src/diagnostics/log.ts#sanitize',
      given: 'log data containing ordinary values, NaN, Infinity, a bigint, and undefined',
      then: 'preparing crash-log data for a public issue keeps ordinary values and records NaN, Infinity, bigint, and missing values as text the issue can carry',
    },
    () => {
      expect(sanitize({ a: 1, b: true, c: null })).toEqual({ a: 1, b: true, c: null });
      expect(sanitize({ n: NaN, i: Infinity })).toEqual({ n: 'NaN', i: 'Infinity' });
      expect(sanitize({ big: 10n })).toEqual({ big: '10n' });
      expect(sanitize({ u: undefined })).toEqual({ u: null });
      expect(sanitize(undefined)).toBeUndefined();
    },
  );

  behaviour(
    {
      id: 'diag.log-sanitize-truncates-strings',
      covers: 'src/diagnostics/log.ts#sanitize',
      given: 'a 500-character string in log data',
      then: 'a long string in crash-log data is truncated with a marker that says how many characters were dropped',
    },
    () => {
      const s = 'x'.repeat(500);
      const out = sanitize({ s })!.s as string;
      expect(out.startsWith('x'.repeat(SANITIZE_STRING_MAX))).toBe(true);
      expect(out).toContain(`…(+${500 - SANITIZE_STRING_MAX} chars)`);
      expect(out.length).toBeLessThan(240);
    },
  );

  behaviour(
    {
      id: 'diag.log-sanitize-redacts-bytes',
      covers: 'src/diagnostics/log.ts#sanitize',
      given: 'log data containing raw byte buffers of several kinds',
      then: 'byte payloads in crash-log data are recorded as a length, with none of the bytes themselves',
      why: 'raw bytes belong in the bounded serial capture, and inlining them would evict the whole crash log',
    },
    () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      expect(sanitize({ bytes })).toEqual({ bytes: { bytes: 4 } });
      expect(sanitize({ buf: new ArrayBuffer(64) })).toEqual({ buf: { bytes: 64 } });
      expect(sanitize({ view: new DataView(new ArrayBuffer(8)) })).toEqual({ view: { bytes: 8 } });
      expect(JSON.stringify(sanitize({ bytes }))).not.toContain('"1"');
    },
  );

  behaviour(
    {
      id: 'diag.log-sanitize-flattens-nested',
      covers: 'src/diagnostics/log.ts#sanitize',
      given: 'log data containing a small nested object, a large nested object, a class instance, an array, a Map, and a Set',
      then: 'nested objects in crash-log data are summarised as a single string, never walked further',
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.log-sanitize-circular',
      covers: 'src/diagnostics/log.ts#sanitize',
      given: 'log data containing an object that refers to itself',
      then: 'a circular structure in crash-log data is recorded as a type name and does not throw',
      why: 'logging must not be able to break the code it is observing',
    },
    () => {
      const circular: Record<string, unknown> = { self: null };
      circular.self = circular;
      expect(sanitize({ c: circular })).toEqual({ c: 'Object' });
    },
  );

  behaviour(
    {
      id: 'diag.log-sanitize-errors-bounded',
      covers: 'src/diagnostics/log.ts#sanitize',
      given: 'an error with a seven-line stack',
      then: 'an error in crash-log data keeps its name and message, with the stack limited to five lines',
    },
    () => {
      const err = new TypeError('kaboom');
      err.stack = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
      const out = sanitize({ err })!.err as { name: string; message: string; stack: string };
      expect(out.name).toBe('TypeError');
      expect(out.message).toBe('kaboom');
      expect(out.stack.split('\n')).toHaveLength(5);
    },
  );

  behaviour(
    {
      id: 'diag.log-sanitize-drops-functions',
      covers: 'src/diagnostics/log.ts#sanitize',
      given: 'log data containing a function, a symbol, and a number',
      then: 'functions and symbols in crash-log data are dropped, leaving only storeable values',
    },
    () => {
      const out = sanitize({ fn: () => 0, sym: Symbol('s'), keep: 1 })!;
      expect(Object.keys(out)).toEqual(['keep']);
    },
  );

  behaviour(
    {
      id: 'diag.log-sanitize-paths-to-basename',
      covers: 'src/diagnostics/log.ts#sanitize',
      given: 'log data containing Unix and Windows filesystem paths, a bare filename, a URL, and a directory handle',
      then: 'filesystem paths in crash-log data are reduced to a basename, while URLs are left intact',
      why: 'a crash log can end up in a public issue, so home-directory layout must not be published',
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.log-sanitize-caps-keys',
      covers: 'src/diagnostics/log.ts#sanitize',
      given: 'log data with fifty keys, and an object whose getter throws',
      then: 'preparing crash-log data for a public issue keeps a bounded number of keys and records an unreadable field without throwing',
      why: 'logging must not be able to break the code it is observing',
    },
    () => {
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
    },
  );
});

describe('cross-thread merge', () => {
  beforeEach(() => {
    setLogSink(null);
    setLogFilter('', 'error');
    clearLog();
  });

  behaviour(
    {
      id: 'diag.log-merges-worker-by-wall-clock',
      covers: 'src/diagnostics/log.ts#ingestWorkerBatch',
      given: 'two main-thread events with a late-arriving worker batch that was produced between them',
      then: 'worker crash-log events are merged into the same timeline, ordered by wall-clock time',
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.log-labels-ingested-as-worker',
      covers: 'src/diagnostics/log.ts#ingestWorkerBatch',
      given: 'a worker batch whose entries claim to be from the main thread',
      then: 'worker crash-log events are labelled as worker even when the batch claims otherwise',
    },
    () => {
      ingestWorkerBatch([{ ...workerEntry(1, nowMs(), 'mislabelled'), thread: 'main' }]);
      expect(logSnapshot().entries[0].thread).toBe('worker');
    },
  );

  behaviour(
    {
      id: 'diag.log-counts-ingested-entries',
      covers: 'src/diagnostics/log.ts#ingestWorkerBatch',
      given: 'a worker batch of two nack events',
      then: 'worker crash-log events increment the same per-kind counters as main-thread events',
    },
    () => {
      ingestWorkerBatch([workerEntry(1, nowMs(), 'nack'), workerEntry(2, nowMs(), 'nack')]);
      expect(logSnapshot().counters['device:nack']).toBe(2);
    },
  );

  behaviour(
    {
      id: 'diag.log-sorts-ties-stably',
      covers: 'src/diagnostics/log.ts#logSnapshot',
      given: 'two worker events with the same timestamp out of sequence, then a main-thread event tied with a worker event',
      then: 'crash-log events with the same timestamp keep sequence order within a thread and arrival order across threads',
    },
    () => {
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
    },
  );
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

  behaviour(
    {
      id: 'diag.log-flushes-on-interval',
      covers: 'src/diagnostics/log.ts#setLogSink',
      given: 'two events are logged while worker logs are being forwarded to the main thread, then the flush interval elapses',
      then: 'worker crash-log events wait for the flush interval and leave as one batch',
      why: 'nothing high-rate should cross from the worker per event',
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.log-flushes-at-threshold',
      covers: 'src/diagnostics/log.ts#flushLog',
      given: 'enough events to hit the batch size threshold while worker logs are being forwarded',
      then: 'worker crash-log events flush as soon as the batch size threshold is hit, and the timer does not send an empty follow-up',
    },
    () => {
      const batches: LogEntry[][] = [];
      setLogSink((entries) => void batches.push(entries));

      for (let i = 0; i < LOG_FLUSH_MAX_ENTRIES; i++) logger('proto').debug('rx', String(i));
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(LOG_FLUSH_MAX_ENTRIES);

      vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS);
      expect(batches).toHaveLength(1); // the timer was cancelled, no empty batch
    },
  );

  behaviour(
    {
      id: 'diag.log-flushes-on-demand',
      covers: 'src/diagnostics/log.ts#flushLog',
      given: 'a buffered worker log event, a demand flush, then another event followed by disconnecting the forwarder',
      then: 'a demand flush and disconnecting the worker log forwarder both send any buffered crash-log events',
      why: 'the last events before a crash or disconnect must still reach the merged timeline',
    },
    () => {
      const batches: LogEntry[][] = [];
      setLogSink((entries) => void batches.push(entries));

      logger('device').warn('closing');
      flushLog();
      expect(batches[0].map((e) => e.tag)).toEqual(['closing']);

      logger('device').warn('last-gasp');
      setLogSink(null); // teardown must not swallow buffered entries
      expect(batches[1].map((e) => e.tag)).toEqual(['last-gasp']);
    },
  );

  behaviour(
    {
      id: 'diag.log-keeps-logging-when-sink-dead',
      covers: 'src/diagnostics/log.ts#flushLog',
      given: 'the worker log forwarder throws, then an event is logged and flushed',
      then: 'a dead worker log forwarder is counted as a flush failure and the crash-log event stays in the local crash log',
      why: 'a released worker connection must not take logging down with it',
    },
    () => {
      setLogSink(() => {
        throw new Error('proxy released');
      });
      logger('device').info('orphan');
      expect(() => flushLog()).not.toThrow();
      expect(logSnapshot().counters['app:log-flush-failed']).toBe(1);
      // The entry is still in the local ring even though transport failed.
      expect(logSnapshot().entries.some((e) => e.tag === 'orphan')).toBe(true);
    },
  );

  behaviour(
    {
      id: 'diag.log-buffers-nothing-without-sink',
      covers: 'src/diagnostics/log.ts#setLogSink',
      given: 'an event is logged with no worker log forwarder, then a forwarder is installed and flushed',
      then: 'crash-log events recorded with no worker log forwarder are not sent when a forwarder is later installed',
    },
    () => {
      setLogSink(null);
      logger('app').info('local-only');
      const batches: LogEntry[][] = [];
      setLogSink((entries) => void batches.push(entries));
      flushLog();
      expect(batches).toHaveLength(0);
    },
  );
});

describe('debug hook', () => {
  behaviour(
    {
      id: 'diag.log-debug-hook',
      covers: 'src/diagnostics/log.ts#logSnapshot',
      given: 'the page\'s debug crash-log hook',
      then: 'a tester can clear and dump the crash log from the page',
    },
    () => {
      expect(globalThis.__madLog).toBeDefined();
      globalThis.__madLog!.clear();
      logger('app').info('hooked');
      expect(globalThis.__madLog!.snapshot().entries.map((e) => e.tag)).toContain('hooked');
    },
  );
});
