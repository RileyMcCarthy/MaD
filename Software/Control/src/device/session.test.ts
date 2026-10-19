/**
 * DeviceClient worker lifecycle contracts:
 *  - worker crash fanout (error + disconnected with reason)
 *  - fresh worker on recreate (poisoned-WASM recovery class)
 *
 * The module constructs a singleton DeviceClient on import, so Worker must be
 * stubbed before the dynamic import.
 */
import { describe, expect, vi, beforeAll } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { subscribeLog } from '@/diagnostics/log';
import type { DeviceEvent } from './events';

class FakeWorker {
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  postMessage(): void {}
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

vi.stubGlobal(
  'Worker',
  class {
    onerror: ((e: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage(): void {}
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  },
);

/** The `navigator.serial` `disconnect` handlers, one per DeviceClient. */
const serialDisconnectHandlers: Array<(event: Event) => void> = [];

Object.defineProperty(globalThis, 'navigator', {
  value: {
    serial: {
      addEventListener: (type: string, handler: (event: Event) => void) => {
        if (type === 'disconnect') serialDisconnectHandlers.push(handler);
      },
    },
  },
  configurable: true,
  writable: true,
});

/** What the worker's connect does; a test swaps it to fail the handshake. */
const remote = vi.hoisted(() => ({ connect: async (): Promise<void> => undefined }));

vi.mock('comlink', () => ({
  wrap: () => ({
    setEventSink: async () => undefined,
    setLogSink: async () => undefined,
    connect: () => remote.connect(),
    disconnect: async () => undefined,
  }),
  proxy: <T>(v: T) => v,
  transfer: <T>(v: T) => v,
}));

let DeviceClient: typeof import('./session').DeviceClient;
let workerCrashEvents: typeof import('./session').workerCrashEvents;

beforeAll(async () => {
  const mod = await import('./session');
  DeviceClient = mod.DeviceClient;
  workerCrashEvents = mod.workerCrashEvents;
});

describe('workerCrashEvents', () => {
  behaviour(
    {
      id: 'session.worker-crash-events-are-text',
      covers: 'src/device/session.ts#workerCrashEvents',
      given: 'the device worker crashing with a panic message',
      expect: {
        'error-then-disconnect': 'an error carrying the crash text and a disconnect naming it as the reason follow',
        'plain-text': 'both carry the crash text as plain text',
      },
      why: {
        'error-then-disconnect':
          'the UI must show the crash as a disconnect so the operator can reconnect with a fresh session',
      },
    },
    () => {
      const events = workerCrashEvents('wasm panic');
      expect(events).toEqual([
        { kind: 'error', message: 'worker: wasm panic' },
        { kind: 'disconnected', reason: 'worker crashed: wasm panic' },
      ]);
      for (const e of events) {
        if (e.kind === 'error') expect(typeof e.message).toBe('string');
        if (e.kind === 'disconnected') expect(typeof e.reason).toBe('string');
      }
    },
  );
});

describe('DeviceClient worker recovery', () => {
  behaviour(
    {
      id: 'session.client-starts-with-one-worker',
      covers: 'src/device/session.ts#DeviceClient',
      given: 'a new device client',
      expect: {
        'one-worker': 'exactly one worker is created',
      },
    },
    () => {
      const client = new DeviceClient({ workerFactory: () => new FakeWorker() as unknown as Worker });
      expect(client.workerCreateCount).toBe(1);
    },
  );

  behaviour(
    {
      id: 'session.worker-crash-reaches-subscribers',
      covers: 'src/device/session.ts#DeviceClient',
      given: 'a subscriber listening to a device client whose worker then crashes',
      expect: {
        'one-batch': 'the subscriber gets one batch carrying the crash error and the disconnect',
        'client-disconnected': 'the client reports itself disconnected',
      },
    },
    () => {
      const client = new DeviceClient({ workerFactory: () => new FakeWorker() as unknown as Worker });
      const seen: DeviceEvent[][] = [];
      client.subscribe((batch) => seen.push(batch));
      client.simulateWorkerCrash('trap');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(workerCrashEvents('trap'));
      expect(client.isConnected()).toBe(false);
    },
  );

  behaviour(
    {
      id: 'session.recreate-worker-is-fresh',
      covers: 'src/device/session.ts#DeviceClient',
      given: 'a device client whose worker is then recreated',
      expect: {
        'previous-shut-down': 'the previous worker is shut down',
        'fresh-worker-running': 'a second worker starts and stays running',
      },
      why: {
        'fresh-worker-running': 'a panic that poisons the protocol engine must not carry into the next connection',
      },
    },
    () => {
      const workers: FakeWorker[] = [];
      const client = new DeviceClient({
        workerFactory: () => {
          const w = new FakeWorker();
          workers.push(w);
          return w as unknown as Worker;
        },
      });
      expect(client.workerCreateCount).toBe(1);
      client.forceRecreateWorker();
      expect(client.workerCreateCount).toBe(2);
      expect(workers[0].terminated).toBe(true);
      expect(workers[1].terminated).toBe(false);
    },
  );
});

/**
 * A port that, like the browser's, refuses to open while it is open, and
 * refuses to close while its streams are locked (here: for the first
 * `refusals` attempts).
 */
function fakePort(refusals = 0) {
  const port = {
    isOpen: false,
    refusals,
    readable: null as object | null,
    writable: null as object | null,
    getInfo: () => ({}),
    async open() {
      if (port.isOpen) throw new DOMException('The port is already open.', 'InvalidStateError');
      port.isOpen = true;
      port.readable = {};
      port.writable = {};
    },
    async close() {
      if (port.refusals > 0) {
        port.refusals -= 1;
        throw new TypeError("Failed to execute 'close' on 'SerialPort': Cannot cancel a locked stream");
      }
      port.isOpen = false;
      port.readable = null;
      port.writable = null;
    },
  };
  return port;
}

describe('DeviceClient.connect', () => {
  behaviour(
    {
      id: 'session.connect-closes-held-port',
      covers: 'src/device/session.ts#connect',
      given: 'a session that still holds an open port, connecting to that same port again',
      expect: {
        'opens-again': 'the port opens for the new connection',
        'one-port-held': 'the session holds the port once, open',
      },
      why: { 'opens-again': 'the browser refuses to open a port that is already open' },
    },
    async () => {
      const client = new DeviceClient();
      const port = fakePort();
      await client.connect(port as unknown as SerialPort);
      await expect(client.connect(port as unknown as SerialPort)).resolves.toBeUndefined();
      expect(client.isConnected()).toBe(true);
      expect(port.isOpen).toBe(true);
    },
  );

  behaviour(
    {
      id: 'session.failed-handshake-closes-port',
      covers: 'src/device/session.ts#connect',
      given: 'a connection whose port opens but whose session fails to start',
      expect: {
        'port-closed': 'the port is closed again',
        'retry-opens': 'a second attempt opens the port',
      },
    },
    async () => {
      const client = new DeviceClient();
      const port = fakePort();
      remote.connect = async () => {
        throw new Error('handshake failed');
      };
      await expect(client.connect(port as unknown as SerialPort)).rejects.toThrow(/handshake failed/);
      expect(port.isOpen).toBe(false);
      remote.connect = async () => undefined;
      await client.connect(port as unknown as SerialPort);
      expect(port.isOpen).toBe(true);
    },
  );
});

describe('DeviceClient.disconnect', () => {
  behaviour(
    {
      id: 'session.disconnect-retries-locked-port',
      covers: 'src/device/session.ts#releasePort',
      given: 'a disconnect whose port the browser refuses to close twice while its streams are still being released',
      expect: {
        'port-closed': 'the port is closed in the end, so other programs can open it',
        'nothing-held': 'the session no longer holds a port',
      },
      why: {
        'port-closed':
          'the worker lets go of the serial streams a moment after its teardown finishes, and the browser refuses to close a port until it has',
      },
    },
    async () => {
      const client = new DeviceClient();
      const port = fakePort();
      await client.connect(port as unknown as SerialPort);
      port.refusals = 2;
      await expect(client.disconnect()).resolves.toBeUndefined();
      expect(port.isOpen).toBe(false);
      expect(client.isConnected()).toBe(false);
    },
  );

  behaviour(
    {
      id: 'session.disconnect-reports-held-port',
      covers: 'src/device/session.ts#releasePort',
      given: 'a disconnect whose port the browser keeps refusing to close',
      expect: {
        'reported': 'the disconnect fails with a message telling the operator the browser still holds the port and to close the tab',
        'still-held': 'the session still counts the port as held',
        'retried-later': 'a later connection to the port closes it first and then opens it again',
      },
      why: {
        'reported': 'a port the browser keeps open cannot be opened by any other program, and closing the tab is the only remedy left',
      },
    },
    async () => {
      const client = new DeviceClient();
      const port = fakePort();
      await client.connect(port as unknown as SerialPort);
      port.refusals = Number.POSITIVE_INFINITY;
      await expect(client.disconnect()).rejects.toThrow(/still holding the serial port.*Close this tab/);
      expect(client.isConnected()).toBe(true);
      expect(port.isOpen).toBe(true);

      port.refusals = 0;
      await expect(client.connect(port as unknown as SerialPort)).resolves.toBeUndefined();
      expect(port.isOpen).toBe(true);
    },
  );
});

/** Longer than releasePort()'s retry window, so a refused close gives up. */
const PAST_RETRY_WINDOW_MS = 2000;

/** Count the `device:port-close-failed` entries logged while `run` executes. */
async function closeFailuresLoggedDuring(run: () => Promise<void>): Promise<number> {
  let count = 0;
  const stop = subscribeLog((e) => {
    if (e.cat === 'device' && e.tag === 'port-close-failed') count += 1;
  });
  try {
    await run();
  } finally {
    stop();
  }
  return count;
}

/** Collect unhandled rejections raised while `run` executes on fake timers. */
async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  try {
    await run();
    await vi.advanceTimersByTimeAsync(PAST_RETRY_WINDOW_MS);
  } finally {
    vi.useRealTimers();
  }
  // Node reports an unhandled rejection only after the microtask queue drains.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  return seen;
}

describe('DeviceClient release failures stay contained', () => {
  behaviour(
    {
      id: 'session.worker-crash-close-refused-contained',
      covers: 'src/device/session.ts#onWorkerCrash',
      given: 'a worker crash that leaves the serial streams locked, so the browser keeps refusing to close the port',
      expect: {
        'no-unhandled-rejection': 'no unhandled rejection is raised',
        'still-held': 'the session still counts the port as held',
        'close-failure-logged-once': 'the refused close is logged once',
      },
      why: {
        'no-unhandled-rejection':
          'the app reports every unhandled rejection as a crash, so an escaping close failure would log a second crash on top of the real one',
        'close-failure-logged-once': 'a crash releases the port once, so the log holds one entry per close that failed',
      },
    },
    async () => {
      const client = new DeviceClient();
      const port = fakePort();
      await client.connect(port as unknown as SerialPort);
      port.refusals = Number.POSITIVE_INFINITY;
      let unhandled: unknown[] = [];
      const closeFailures = await closeFailuresLoggedDuring(async () => {
        unhandled = await unhandledRejectionsDuring(async () => {
          client.simulateWorkerCrash('trap');
        });
      });
      expect(unhandled).toEqual([]);
      expect(client.isConnected()).toBe(true);
      expect(port.isOpen).toBe(true);
      expect(closeFailures).toBe(1);
    },
  );

  behaviour(
    {
      id: 'session.serial-disconnect-close-refused-contained',
      covers: 'src/device/session.ts#DeviceClient',
      given: 'the browser reporting the session\'s port disconnected while its streams stay locked, so it keeps refusing to close the port',
      expect: {
        'no-unhandled-rejection': 'no unhandled rejection is raised',
        'still-held': 'the session still counts the port as held',
      },
      why: {
        'no-unhandled-rejection':
          'the app reports every unhandled rejection as a crash, and nothing waits on this close to report the failure to',
      },
    },
    async () => {
      const client = new DeviceClient();
      const port = fakePort();
      await client.connect(port as unknown as SerialPort);
      port.refusals = Number.POSITIVE_INFINITY;
      const unhandled = await unhandledRejectionsDuring(async () => {
        for (const handler of serialDisconnectHandlers) handler({ target: port } as unknown as Event);
      });
      expect(unhandled).toEqual([]);
      expect(client.isConnected()).toBe(true);
      expect(port.isOpen).toBe(true);
    },
  );

  behaviour(
    {
      id: 'session.failed-handshake-error-kept',
      covers: 'src/device/session.ts#connect',
      given: 'a connection whose session fails to start and whose port the browser then refuses to close',
      expect: {
        'handshake-error-thrown': 'the connect fails with the handshake error, not the port-release error',
      },
      why: {
        'handshake-error-thrown': 'the handshake error says why the connection failed; the close failure is already in the log',
      },
    },
    async () => {
      const client = new DeviceClient();
      const port = fakePort();
      port.refusals = Number.POSITIVE_INFINITY;
      remote.connect = async () => {
        throw new Error('handshake failed');
      };
      let attempt: Promise<void> | undefined;
      try {
        const unhandled = await unhandledRejectionsDuring(async () => {
          attempt = client.connect(port as unknown as SerialPort);
          attempt.catch(() => undefined);
        });
        expect(unhandled).toEqual([]);
        const err = await attempt!.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('handshake failed');
        expect((err as Error).name).not.toBe('PortReleaseError');
      } finally {
        remote.connect = async () => undefined;
      }
    },
  );

  behaviour(
    {
      id: 'session.unplugged-port-counts-released',
      covers: 'src/device/session.ts#releasePort',
      given: 'a disconnect after the device was unplugged, so closing the port fails and it has no streams left',
      expect: {
        'disconnect-succeeds': 'the disconnect succeeds, with no message about the browser holding the port',
        'nothing-held': 'the session no longer holds a port',
      },
      why: {
        'disconnect-succeeds': 'an unplugged port has nothing left to release, and telling the operator to close the tab would be wrong',
      },
    },
    async () => {
      const client = new DeviceClient();
      const port = fakePort();
      await client.connect(port as unknown as SerialPort);
      port.refusals = Number.POSITIVE_INFINITY;
      port.readable = null;
      port.writable = null;
      await expect(client.disconnect()).resolves.toBeUndefined();
      expect(client.isConnected()).toBe(false);
    },
  );
});
