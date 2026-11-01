/**
 * What the device worker does when the protocol core gives up waiting for a
 * reply: it rejects the JS waiter for that same request, and only that one.
 *
 * Reads and writes share command ids — READ_STATE and WRITE_MOTION_ENABLE are
 * both 1 — so the timed-out frame's read/write type byte is what tells a lost
 * state poll from a lost motion-enable write.
 *
 * The protocol core here is a stand-in that replays scripted poll results, one
 * batch per tick, and records what the session hands it to send.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { subscribeLog, type LogEntry } from '@/diagnostics/log';
import { MSG_READ_STATE, MSG_WRITE_MOTION_ENABLE } from '@/protocol/generated/protoemb';
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

/** Host→device request frames, as the framing layer lays them out
 *  (Protocol/ProtoEmb/framing): sync, read/write type, command. */
const readRequest = (command: number): number[] => [0x55, 0x00, command];
const writeRequest = (command: number): number[] => [0x55, 0x01, command, 1, 0, 1, 0];

let logged: LogEntry[] = [];
let unsubscribe: () => void = () => undefined;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  core.polls.length = 0;
  core.writes.length = 0;
  logged = [];
  unsubscribe = subscribeLog((e) => logged.push(e));
});

afterEach(async () => {
  unsubscribe();
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
    id: 'session.lost-state-poll-spares-motion-write',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.tick',
    given:
      'a motion-enable write waiting for its acknowledgement while the board leaves one state read unanswered',
    expect: {
      'write-succeeds': 'the motion-enable write succeeds when its acknowledgement arrives',
      'state-read-named': 'the session log names the state read as the request that went unanswered',
    },
    why: {
      'write-succeeds':
        'the state read and the motion-enable write share a command number, and the board drops about one request in a thousand; a lost state read costs one machine-state update',
      'state-read-named': 'a bug report reads this entry to tell a dropped state read from a dropped command',
    },
  },
  async () => {
    const session = await connectedSession();

    const enabled = session.setMotionEnabled(true);
    await vi.waitFor(() => expect(core.writes).toEqual([MSG_WRITE_MOTION_ENABLE]));
    core.polls.push(
      [{ event: 'timeout', frame: readRequest(MSG_READ_STATE) }],
      [{ event: 'ack', command: MSG_WRITE_MOTION_ENABLE }],
    );

    expect(await enabled).toBe(true);
    const lost = logged.filter((e) => e.tag === 'timeout');
    expect(lost.map((e) => e.data?.command)).toEqual(['READ_STATE(1)']);
  },
);

behaviour(
  {
    id: 'session.lost-motion-write-fails-command',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.tick',
    given: 'a motion-enable write that the board never answers',
    expect: {
      'fails-with-link':
        "the write fails as soon as the link stops waiting for the reply, with the link's response timeout logged as the reason",
    },
    why: {
      'fails-with-link': 'a late reply to the lost write must not complete the next motion-enable write',
    },
  },
  async () => {
    const session = await connectedSession();

    const enabled = session.setMotionEnabled(true);
    await vi.waitFor(() => expect(core.writes).toEqual([MSG_WRITE_MOTION_ENABLE]));
    core.polls.push([{ event: 'timeout', frame: writeRequest(MSG_WRITE_MOTION_ENABLE) }]);

    expect(await enabled).toBe(false);
    const failed = logged.filter((e) => e.tag === 'tx-failed');
    expect(failed.map((e) => e.data?.reason)).toEqual(['response timeout']);
  },
);
