/**
 * The compatibility handshake as the device worker runs it: one read of the
 * firmware's device info, answered with the protocol version it speaks, or
 * refused by firmware from before the handshake existed.
 *
 * The protocol core here is a stand-in that replays scripted poll results, one
 * batch per tick, and records the reads the session hands it to send.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { MSG_READ_DEVICE_INFO, NACK_REASON } from '@/protocol/generated/protoemb';
import { clearLog, logSnapshot } from '@/diagnostics/log';
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

/** Ask for the device info and answer the read with `reply` once it is sent. */
async function askDeviceInfo(
  reply: unknown,
  session?: DeviceSession,
): Promise<{ protocolVersion: number } | null> {
  const s = session ?? (await connectedSession());
  const sent = core.reads.length;
  const info = s.readDeviceInfo();
  await vi.waitFor(() => expect(core.reads.slice(sent)).toEqual([MSG_READ_DEVICE_INFO]));
  core.polls.push([reply]);
  return info;
}

behaviour(
  {
    id: 'session.device-info-reports-protocol',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.readDeviceInfo',
    given: 'the app asks the connected board which protocol it speaks, and the board answers protocol 2',
    expect: { 'protocol-returned': 'the app is told the board speaks protocol 2' },
  },
  async () => {
    const info = await askDeviceInfo({ event: 'data', command: MSG_READ_DEVICE_INFO, payload: [2, 0, 0, 0] });
    expect(info).toEqual({ protocolVersion: 2 });
  },
);

behaviour(
  {
    id: 'session.device-info-refused',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.readDeviceInfo',
    given: 'the app asks the connected board which protocol it speaks, and the board refuses the question',
    expect: {
      'no-protocol': 'the app is told, as soon as the refusal arrives, that the board reports no protocol',
    },
    why: {
      'no-protocol':
        'firmware from before the question existed refuses any command it does not know, so a refusal is a definite answer and is never retried',
    },
  },
  async () => {
    // A refusal is a NACK; the worker reports NACKs as unsuccessful acknowledgements.
    const info = await askDeviceInfo({ event: 'nack', command: MSG_READ_DEVICE_INFO });
    expect(info).toBeNull();
  },
);

behaviour(
  {
    id: 'session.device-info-reply-length',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.mapData',
    given: 'a device-info reply whose length differs from the one this app was built for',
    expect: {
      'short-zero-filled':
        'a shorter reply, as firmware from before a field was appended would send, reads the missing bytes as zero and keeps the bytes it sent',
      'long-kept':
        'a longer reply, from firmware with fields appended after this app, keeps the fields this app knows',
    },
    why: {
      'short-zero-filled':
        'the device-info message only ever grows at its end, so every app can read every firmware that answers it',
    },
  },
  async () => {
    const session = await connectedSession();
    expect(
      await askDeviceInfo({ event: 'data', command: MSG_READ_DEVICE_INFO, payload: new Uint8Array([3, 1]) }, session),
    ).toEqual({ protocolVersion: 0x0103 });
    expect(
      await askDeviceInfo({ event: 'data', command: MSG_READ_DEVICE_INFO, payload: [3, 0, 0, 0, 9, 9, 9, 9] }, session),
    ).toEqual({ protocolVersion: 3 });
  },
);

behaviour(
  {
    id: 'session.refusal-reason-logged',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.logRawEvent',
    given: 'the board refuses a request, giving the reason that the request named a command it does not have',
    expect: {
      'reason-logged': 'the refusal in the session log names that reason',
    },
    why: {
      'reason-logged': 'a bug report is built from the session log, and the reason is what tells a developer where to look',
    },
  },
  async () => {
    clearLog();
    const info = await askDeviceInfo({
      event: 'nack',
      command: MSG_READ_DEVICE_INFO,
      reason: NACK_REASON.UNKNOWN_COMMAND,
    });
    expect(info).toBeNull();
    const nack = logSnapshot().entries.find((e) => e.cat === 'proto' && e.tag === 'nack');
    expect(nack?.data?.reason).toBe('UNKNOWN_COMMAND');
  },
);
