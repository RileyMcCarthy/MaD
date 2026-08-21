/**
 * DeviceClient worker lifecycle contracts:
 *  - worker crash fanout (error + disconnected with reason)
 *  - fresh worker on recreate (poisoned-WASM recovery class)
 *
 * The module constructs a singleton DeviceClient on import, so Worker must be
 * stubbed before the dynamic import.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
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
  it('emits error + disconnected with reason (strings, never objects)', () => {
    const events = workerCrashEvents('wasm panic');
    expect(events).toEqual([
      { kind: 'error', message: 'worker: wasm panic' },
      { kind: 'disconnected', reason: 'worker crashed: wasm panic' },
    ]);
    for (const e of events) {
      if (e.kind === 'error') expect(typeof e.message).toBe('string');
      if (e.kind === 'disconnected') expect(typeof e.reason).toBe('string');
    }
  });
});

describe('DeviceClient worker recovery', () => {
  it('constructs an initial worker', () => {
    const client = new DeviceClient({ workerFactory: () => new FakeWorker() as unknown as Worker });
    expect(client.workerCreateCount).toBe(1);
  });

  it('simulateWorkerCrash fans out error + disconnected to subscribers', () => {
    const client = new DeviceClient({ workerFactory: () => new FakeWorker() as unknown as Worker });
    const seen: DeviceEvent[][] = [];
    client.subscribe((batch) => seen.push(batch));
    client.simulateWorkerCrash('trap');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(workerCrashEvents('trap'));
    expect(client.isConnected()).toBe(false);
  });

  it('forceRecreateWorker builds a fresh worker (connect recovery class)', () => {
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
  });
});
