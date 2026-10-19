/**
 * The device worker's event callback, wired the way the app wires it: the main
 * thread registers `Comlink.proxy(fanout)` with the real DeviceSession, through
 * the real Comlink over a real MessageChannel (session.ts `ensureSink`).
 *
 * A bundler may compile the worker's own `this.sink?.(events)` into a method
 * call, `(n = this.sink) == null || n.call(this, events)`; esbuild does for
 * targets older than Chrome 91. The unit suite runs uncompiled source, so the
 * test makes that call itself, on whatever the session stored.
 */
import { afterEach, expect, vi } from 'vitest';
import * as Comlink from 'comlink';
import { behaviour } from '@vibes/behaviour';
import { DeviceSession, type DeviceSessionApi } from './DeviceSession.worker';
import type { DeviceEvent } from './events';
import { logSnapshot } from '@/diagnostics/log';

// The worker module imports the protocol core's WebAssembly glue, which exists
// only after `npm run build:wasm`. The Behaviour ledger job runs this suite
// without that build, and a file that fails to load reports nothing. This test
// never connects, so the core is never used: stand-ins keep the file loadable
// either way, and one that is used by mistake throws.
vi.mock('@/wasm/protoemb_runtime.js', () => ({
  default: () => Promise.reject(new Error('the protocol core is not loaded in this test')),
  WasmClient: function WasmClient() {
    throw new Error('the protocol core is not loaded in this test');
  },
}));
vi.mock('@/wasm/protoemb_runtime_bg.wasm?url', () => ({ default: 'protoemb_runtime_bg.wasm' }));

/** The session's private field: the callback it calls for every batch. */
interface HeldSink {
  sink: ((events: DeviceEvent[]) => unknown) | null;
}

const BATCH: DeviceEvent[] = [
  { kind: 'connected' },
  { kind: 'ack', command: 7, success: true },
  { kind: 'disconnected', reason: 'unplugged' },
];

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

behaviour(
  {
    id: 'worker-boundary.session-delivers-through-method-call',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.setEventSink',
    given:
      "the device worker holding the event callback the main thread registered with it, invoked as a method of the worker object",
    expect: {
      'batch-delivered': 'the main thread receives the batch of events intact and in order',
    },
    why: {
      'batch-delivered':
        "a bundler may compile the worker's call to its event callback into a method call, and every sample, machine state and disconnect reaches the screen through that callback",
    },
  },
  async () => {
    const { port1, port2 } = new MessageChannel();
    const session = new DeviceSession();
    Comlink.expose(session, port1);
    const remote = Comlink.wrap<DeviceSessionApi>(port2);
    cleanups.push(() => {
      remote[Comlink.releaseProxy]();
      port1.close();
      port2.close();
    });

    const seen: DeviceEvent[][] = [];
    await remote.setEventSink(
      Comlink.proxy((events: DeviceEvent[]) => {
        seen.push(events);
      }),
    );

    const held = (session as unknown as HeldSink).sink;
    if (held === null) throw new Error('the session kept no event callback');
    await held.call(session, BATCH);

    expect(seen).toEqual([BATCH]);
  },
);

/** The session's private stream handles, set directly so no connect is needed. */
interface HeldStreams {
  running: boolean;
  reader: { cancel(): Promise<void>; releaseLock(): void } | null;
  writer: { close(): Promise<void>; releaseLock(): void } | null;
}

behaviour(
  {
    id: 'worker-boundary.stalled-teardown-names-step',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.shutdown',
    given: 'a disconnect whose serial output never finishes closing',
    expect: {
      'disconnect-completes': 'the disconnect still completes and reports the session disconnected',
      'stall-logged': 'the diagnostic log records that the teardown ran out of time while closing the output',
    },
    why: {
      'stall-logged':
        'a stream still closing keeps the serial port locked, so the browser cannot release it; the log is how a report says which step held it',
    },
  },
  async () => {
    const session = new DeviceSession();
    const held = session as unknown as HeldStreams;
    held.running = true;
    held.reader = { cancel: async () => undefined, releaseLock: () => undefined };
    held.writer = { close: () => new Promise<void>(() => undefined), releaseLock: () => undefined };
    const seen: DeviceEvent[] = [];
    await session.setEventSink((events: DeviceEvent[]) => {
      seen.push(...events);
    });

    await session.disconnect();

    expect(seen).toContainEqual({ kind: 'disconnected', reason: undefined });
    const stall = logSnapshot().entries.find((e) => e.tag === 'teardown-timeout');
    expect(stall?.data).toEqual({ step: 'writer-close' });
  },
);
