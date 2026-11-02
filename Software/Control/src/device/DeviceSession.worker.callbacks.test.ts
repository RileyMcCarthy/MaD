/**
 * What the device worker does when a callback the main thread handed it fails:
 * the event callback (counted in the diagnostics, logged once per session) and
 * a download's progress callback (logged once, the download carries on).
 *
 * The callbacks here are plain functions that reject, the way a Comlink proxy
 * rejects when the main thread could not run them.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { subscribeLog, type LogEntry } from '@/diagnostics/log';
import { STOREDSAMPLE_WIRE_SIZE } from '@/protocol/generated/protoemb';
import { DeviceSession } from './DeviceSession.worker';
import type { DeviceEvent, FileDownloadProgress } from './events';

// The worker module imports the protocol core's WebAssembly glue, which exists
// only after `npm run build:wasm`; the Behaviour ledger job runs this suite
// without it. The stand-in core loads at once and answers nothing: no events,
// no bytes to send. Enough for a session to connect over idle streams.
vi.mock('@/wasm/protoemb_runtime.js', () => ({
  default: () => Promise.resolve(),
  WasmClient: class {
    register_periodic(): void {}
    register_periodic_with_timeout(): void {}
    poll(): unknown[] {
      return [];
    }
    take_outgoing(): Uint8Array {
      return new Uint8Array(0);
    }
    feed_bytes(): void {}
    write(): void {}
    query(): void {}
    read(): void {}
    clear_queue(): void {}
    get_stored(): unknown[] {
      return [];
    }
  },
}));
vi.mock('@/wasm/protoemb_runtime_bg.wasm?url', () => ({ default: 'protoemb_runtime_bg.wasm' }));

/** The session's private members these tests drive directly. */
interface SessionInternals {
  emit(events: DeviceEvent[]): void;
  requestDownloadChunk(
    request: Uint8Array,
    timeoutMs: number,
  ): Promise<{ kind: 'data'; chunk: Uint8Array } | { kind: 'nack' }>;
}

const SAMPLES_PER_REQUEST = 100;

let logged: LogEntry[] = [];
let unsubscribe: () => void = () => undefined;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  logged = [];
  unsubscribe = subscribeLog((e) => logged.push(e));
});

afterEach(async () => {
  unsubscribe();
  for (const fn of cleanups.splice(0)) await fn();
});

/** Let every pending promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function tagged(tag: string): LogEntry[] {
  return logged.filter((e) => e.tag === tag);
}

/** An event callback whose every delivery fails on the main thread. */
function failingSink(): () => Promise<never> {
  return () => Promise.reject(new TypeError('the main thread could not take the batch'));
}

function idleStreams(): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
  return { readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<Uint8Array>() };
}

behaviour(
  {
    id: 'worker-boundary.failed-event-delivery-counted',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.emit',
    given:
      'a session whose main thread fails to receive every batch of device events, after five batches',
    expect: {
      'every-failure-counted':
        "the session's diagnostics count five failed deliveries, one for each batch",
      'logged-once':
        "the session log carries exactly one failed-delivery entry, naming the main thread's error and its message",
    },
    why: {
      'every-failure-counted':
        'a bug report reads this count to show how many batches of samples, machine states and disconnects never reached the screen',
      'logged-once':
        'a broken event handler fails on every poll of the link, and one entry per failure would flood the log that reports the problem',
    },
  },
  async () => {
    const session = new DeviceSession();
    session.setEventSink(failingSink());
    const internals = session as unknown as SessionInternals;

    for (let i = 0; i < 5; i++) internals.emit([{ kind: 'ack', command: 7, success: true }]);
    await settle();

    expect(session.getDiagnostics().eventDeliveryFailures).toBe(5);
    const entries = tagged('event-delivery-failed');
    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('TypeError: the main thread could not take the batch');
  },
);

behaviour(
  {
    id: 'worker-boundary.failed-event-delivery-new-session',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.connect',
    given:
      'a session that has already failed to deliver three batches of device events, then connects again with the main thread still failing to receive',
    expect: {
      'count-restarts':
        "the session's diagnostics count only the failed deliveries since the new connection",
      'logged-again':
        'the new session logs its first failed delivery, so the log carries one failed-delivery entry per session',
    },
    why: {
      'count-restarts': 'the diagnostics describe the current connection',
    },
  },
  async () => {
    const session = new DeviceSession();
    cleanups.push(() => session.disconnect());
    session.setEventSink(failingSink());
    const internals = session as unknown as SessionInternals;

    for (let i = 0; i < 3; i++) internals.emit([{ kind: 'ack', command: 7, success: true }]);
    await settle();
    expect(session.getDiagnostics().eventDeliveryFailures).toBe(3);

    // Connecting delivers one batch of its own: the "connected" event.
    await session.connect(idleStreams());
    await settle();

    expect(session.getDiagnostics().eventDeliveryFailures).toBe(1);
    expect(tagged('event-delivery-failed')).toHaveLength(2);
  },
);

behaviour(
  {
    id: 'worker-boundary.failed-download-progress',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.downloadTestFile',
    given:
      "a download of a stored test from the SD card, in two parts, while the main thread fails every progress update",
    expect: {
      'logged-once':
        'the session log carries exactly one failed-progress entry, naming the test',
      'download-completes':
        'the download asks the board for every part and returns the test data',
    },
    why: {
      'download-completes':
        'progress only moves a bar on the screen, and the test data it reports on is the result of the whole test',
    },
  },
  async () => {
    const session = new DeviceSession();
    const internals = session as unknown as SessionInternals;

    // The board answers with one full part, then a short last one.
    const parts = [
      new Uint8Array(SAMPLES_PER_REQUEST * STOREDSAMPLE_WIRE_SIZE),
      new Uint8Array(3 * STOREDSAMPLE_WIRE_SIZE),
    ];
    const requested = vi
      .spyOn(internals, 'requestDownloadChunk')
      .mockImplementation(() => {
        const chunk = parts.shift();
        if (chunk === undefined) throw new Error('asked for a part past the end');
        return Promise.resolve({ kind: 'data', chunk });
      });

    const progress = vi.fn(
      (_p: FileDownloadProgress): Promise<never> =>
        Promise.reject(new Error('the main thread could not show progress')),
    );

    const result = await session.downloadTestFile('tensile-01', progress);
    await settle();

    const entries = tagged('download-progress-failed');
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toMatchObject({ testName: 'tensile-01' });
    expect(requested).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls.length).toBeGreaterThan(1);
    expect(result.success).toBe(true);
    expect(result.sampleBytes).toBe((SAMPLES_PER_REQUEST + 3) * STOREDSAMPLE_WIRE_SIZE);
    expect(typeof result.csv).toBe('string');
  },
);
