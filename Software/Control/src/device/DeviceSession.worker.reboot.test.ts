/**
 * The reboot request: the control port has no reset line, so the app asks the
 * firmware to restart itself. The protocol core here is a stand-in that replays
 * scripted poll results, one batch per tick, and records what it is asked to send.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { MSG_WRITE_REBOOT } from '@/protocol/generated/protoemb';
import { DeviceSession } from './DeviceSession.worker';

const core = vi.hoisted(() => ({
  /** Poll results still to come, one batch per tick. */
  polls: [] as unknown[][],
  /** Commands the session handed the core to write. */
  writes: [] as number[],
}));

vi.mock('@/wasm/protoemb_runtime.js', () => ({
  default: () => Promise.resolve(),
  WasmClient: class {
    register_periodic(): void {}
    register_periodic_with_timeout(): void {}
    poll(): unknown[] {
      return core.polls.shift() ?? [];
    }
    take_outgoing(): Uint8Array {
      return new Uint8Array(0);
    }
    feed_bytes(): void {}
    write(command: number): void {
      core.writes.push(command);
    }
    read(): void {}
    clear_queue(): void {}
    get_stored(): unknown[] {
      return [];
    }
  },
}));
vi.mock('@/wasm/protoemb_runtime_bg.wasm?url', () => ({ default: 'protoemb_runtime_bg.wasm' }));

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  core.polls.length = 0;
  core.writes.length = 0;
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function connectedSession(): Promise<DeviceSession> {
  const session = new DeviceSession();
  cleanups.push(() => session.disconnect());
  await session.connect({
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
  });
  return session;
}

behaviour(
  {
    id: 'session.reboot-request-acknowledged',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.reboot',
    given: 'the app asks the machine to reboot',
    expect: {
      'reboot-sent': 'one reboot request goes to the machine',
      'acknowledged-true': "the request reports success when the machine acknowledges it",
      'refused-false': 'the request reports failure when the machine refuses it, as it does during a test',
    },
  },
  async () => {
    const session = await connectedSession();

    const acked = session.reboot();
    await vi.waitFor(() => expect(core.writes).toEqual([MSG_WRITE_REBOOT]));
    core.polls.push([{ event: 'ack', command: MSG_WRITE_REBOOT }]);
    expect(await acked).toBe(true);

    const refused = session.reboot();
    await vi.waitFor(() => expect(core.writes).toEqual([MSG_WRITE_REBOOT, MSG_WRITE_REBOOT]));
    core.polls.push([{ event: 'nack', command: MSG_WRITE_REBOOT }]);
    expect(await refused).toBe(false);
  },
);
