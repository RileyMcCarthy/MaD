/**
 * Callbacks the main thread hands the device worker, carried over a real
 * MessageChannel by the real Comlink, the same way the app wires its event
 * sink (session.ts `setEventSink(Comlink.proxy(fanout))`).
 *
 * The call shape under test is the one the production bundle emits for the
 * worker's `this.sink?.(events)` when esbuild lowers optional chaining:
 * `(n = this.sink) == null || n.call(this, events)`.
 */
import { afterEach, describe, expect } from 'vitest';
import * as Comlink from 'comlink';
import { behaviour } from '@vibes/behaviour';
import { boundaryCallback } from './boundaryCallback';
import type { DeviceEvent, DeviceEventSink } from './events';

type Sink = (events: DeviceEvent[]) => unknown;

/** Stands in for the worker's session object. Like the real one, it holds
 *  something structured clone cannot copy (the real one holds stream readers,
 *  timers and pending promises). */
interface FakeSession {
  sink: Sink | null;
  opChain: Promise<void>;
}

/** esbuild's lowering of `this.sink?.(events)`, written out by hand. */
function compiledOptionalCall(self: FakeSession, events: DeviceEvent[]): unknown {
  const n = self.sink;
  return n == null ? undefined : n.call(self, events);
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

/**
 * Wire a main thread and a worker over a MessageChannel and register `onMain`
 * as the event sink, exactly as DeviceClient.ensureSink does. Resolves with the
 * callback as the worker received it: a Comlink proxy.
 */
async function sinkAsTheWorkerSeesIt(onMain: DeviceEventSink): Promise<Sink> {
  const { port1, port2 } = new MessageChannel();
  let received: Sink | null = null;
  Comlink.expose(
    {
      setEventSink(sink: Sink): void {
        received = sink;
      },
    },
    port1,
  );
  const remote = Comlink.wrap<{ setEventSink(sink: DeviceEventSink): void }>(port2);
  await remote.setEventSink(Comlink.proxy(onMain));
  if (received === null) throw new Error('the worker side never received the sink');
  const sink: Sink = received;
  cleanups.push(() => {
    (sink as unknown as Comlink.Remote<Sink>)[Comlink.releaseProxy]();
    remote[Comlink.releaseProxy]();
    port1.close();
    port2.close();
  });
  return sink;
}

describe('callbacks handed to the device worker', () => {
  behaviour(
    {
      id: 'worker-boundary.method-call-on-unwrapped-callback',
      covers: 'node_modules/comlink/dist/esm/comlink.mjs#createProxy',
      given:
        'a main-thread callback held by the worker as it arrived, invoked as a method call on the worker object the way the production bundle compiles it',
      expect: {
        'clone-rejected':
          'the call is rejected with a data-clone error before any event reaches the main thread',
      },
      why: {
        'clone-rejected':
          'the library that carries calls between threads treats every property of a forwarded callback as another remote call, so its call method sends the worker object itself, and that object cannot be copied between threads',
      },
    },
    async () => {
      const seen: DeviceEvent[][] = [];
      const raw = await sinkAsTheWorkerSeesIt((events) => {
        seen.push(events);
      });
      const session: FakeSession = { sink: raw, opChain: Promise.resolve() };

      await expect(compiledOptionalCall(session, BATCH)).rejects.toMatchObject({
        name: 'DataCloneError',
      });
      expect(seen).toEqual([]);
    },
  );

  behaviour(
    {
      id: 'worker-boundary.wrapped-callback-delivers',
      covers: 'src/device/boundaryCallback.ts#boundaryCallback',
      given:
        'a main-thread callback wrapped as soon as the worker receives it, invoked as a method call on the worker object the way the production bundle compiles it',
      expect: {
        'batch-delivered': 'the main thread receives the batch of events intact and in order',
        'settles-after-delivery': 'the worker side of the call settles only once the main thread has run the callback',
      },
      why: {
        'batch-delivered':
          'samples, machine state and disconnects all reach the screen through this one callback',
      },
    },
    async () => {
      const seen: DeviceEvent[][] = [];
      const raw = await sinkAsTheWorkerSeesIt((events) => {
        seen.push(events);
      });
      const session: FakeSession = { sink: boundaryCallback(raw), opChain: Promise.resolve() };

      const delivered = compiledOptionalCall(session, BATCH);
      expect(seen).toEqual([]);
      await delivered;
      expect(seen).toEqual([BATCH]);
    },
  );

  behaviour(
    {
      id: 'worker-boundary.failed-delivery-reaches-worker',
      covers: 'src/device/boundaryCallback.ts#boundaryCallback',
      given: 'a wrapped main-thread callback whose handler throws',
      expect: {
        'rejected-with-cause': "the worker's call is rejected with the main thread's error message",
      },
      why: {
        'rejected-with-cause':
          'the worker counts and logs a lost delivery, so a bug report shows events going missing',
      },
    },
    async () => {
      const raw = await sinkAsTheWorkerSeesIt(() => {
        throw new Error('handler failed on the main thread');
      });
      const deliver = boundaryCallback(raw);

      await expect(deliver(BATCH)).rejects.toThrow('handler failed on the main thread');
    },
  );
});
