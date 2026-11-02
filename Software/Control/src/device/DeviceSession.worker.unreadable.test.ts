/**
 * Replies the device worker cannot read: firmware generated from another
 * layout answers with payloads of other lengths. The session must survive
 * them, so the compatibility handshake can still say what is wrong.
 *
 * The protocol core here is a stand-in that replays scripted poll results, one
 * batch per tick, and records the reads the session hands it to send.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { subscribeLog, type LogEntry } from '@/diagnostics/log';
import {
  MACHINECONFIGURATION_WIRE_SIZE,
  MSG_READ_DEVICE_INFO,
  MSG_READ_MACHINE_CONFIGURATION,
  MSG_READ_SAMPLE,
  SAMPLE_WIRE_SIZE,
} from '@/protocol/generated/protoemb';
import type { DeviceEvent } from './events';
import { DeviceSession } from './DeviceSession.worker';

const core = vi.hoisted(() => ({
  /** Poll results still to come, one batch per tick. */
  polls: [] as unknown[][],
  /** Commands the session asked the core to read. */
  reads: [] as number[],
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
    write(): void {}
    read(command: number): void {
      core.reads.push(command);
    }
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
  core.reads.length = 0;
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
    id: 'session.unreadable-reply-fails-read',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.unreadableReply',
    given:
      'the board answers the machine-configuration read with a reply 12 bytes shorter than this app reads, as firmware from before fields were added to the configuration does',
    expect: {
      'read-fails-at-once': 'the read fails as soon as the reply arrives, naming both lengths',
      'session-survives': 'the session stays connected, and the next read is answered',
    },
    why: {
      'session-survives':
        'the protocol-version question comes after the opening reads, and it is what tells the operator to update; a session that ended here would never ask it',
    },
  },
  async () => {
    const session = await connectedSession();
    const config = session.readMachineConfiguration();
    await vi.waitFor(() => expect(core.reads).toEqual([MSG_READ_MACHINE_CONFIGURATION]));
    const short = MACHINECONFIGURATION_WIRE_SIZE - 12;
    core.polls.push([{ event: 'data', command: MSG_READ_MACHINE_CONFIGURATION, payload: new Uint8Array(short) }]);
    await expect(config).rejects.toThrow(`reply is ${short} bytes, this app reads ${MACHINECONFIGURATION_WIRE_SIZE}`);

    const info = session.readDeviceInfo();
    await vi.waitFor(() => expect(core.reads).toEqual([MSG_READ_MACHINE_CONFIGURATION, MSG_READ_DEVICE_INFO]));
    core.polls.push([{ event: 'nack', command: MSG_READ_DEVICE_INFO }]);
    expect(await info).toBeNull();
  },
);

behaviour(
  {
    id: 'session.unreadable-samples-dropped',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.unreadableReply',
    given: 'a stream of live samples each three bytes shorter than this app reads',
    expect: {
      'none-shown': 'no sample reaches the screen, so no misread force or position is shown',
      'reported-once': 'the screen is told once that the replies cannot be read, and the session log records it once',
    },
  },
  async () => {
    const logged: LogEntry[] = [];
    const unsubscribe = subscribeLog((e) => logged.push(e));
    cleanups.push(unsubscribe);
    const session = await connectedSession();
    const seen: DeviceEvent[] = [];
    session.setEventSink(async (events: DeviceEvent[]) => void seen.push(...events));
    const sample = { event: 'data', command: MSG_READ_SAMPLE, payload: new Uint8Array(SAMPLE_WIRE_SIZE - 3) };
    core.polls.push([sample, sample], [sample]);
    await vi.waitFor(() => expect(core.polls).toEqual([]));
    await vi.waitFor(() => expect(seen.some((e) => e.kind === 'error')).toBe(true));
    expect(seen.filter((e) => e.kind === 'sample')).toEqual([]);
    expect(seen.filter((e) => e.kind === 'error')).toHaveLength(1);
    expect(logged.filter((e) => e.tag === 'unreadable-reply')).toHaveLength(1);
  },
);
