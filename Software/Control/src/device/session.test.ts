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

Object.defineProperty(globalThis, 'navigator', {
  value: { serial: { addEventListener: () => undefined } },
  configurable: true,
  writable: true,
});

vi.mock('comlink', () => ({
  wrap: () => ({
    setEventSink: async () => undefined,
    connect: async () => undefined,
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
