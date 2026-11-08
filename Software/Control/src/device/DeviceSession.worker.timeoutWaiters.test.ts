/**
 * What the device worker does when the protocol core gives up waiting for a
 * reply: it rejects the JS waiter for that same request, and only that one.
 *
 * Reads and writes share command ids — READ_STATE and WRITE_MOTION_ENABLE are
 * both 1 — so the timed-out frame's read/write type byte is what tells a lost
 * state poll from a lost motion-enable write.
 *
 * Also what the session log keeps about a write the board refused or never
 * answered: the bytes that write carried.
 *
 * The protocol core here is a stand-in that replays scripted poll results, one
 * batch per tick, and records what the session hands it to send.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { subscribeLog, type LogEntry } from '@/diagnostics/log';
import {
  MSG_READ_STATE,
  MSG_WRITE_MANUAL_MOVE,
  MSG_WRITE_MOTION_ENABLE,
  MSG_WRITE_TEST_MOVE,
} from '@/protocol/generated/protoemb';
import { DeviceSession } from './DeviceSession.worker';

const core = vi.hoisted(() => ({
  /** Poll results still to come, one batch per tick. */
  polls: [] as unknown[][],
  /** Commands the session handed the core to write. */
  writes: [] as number[],
  /** The bytes of each write, in the same order as `writes`. */
  payloads: [] as Uint8Array[],
  /** A command the board refuses (NACKs) every time it is written. */
  refused: null as number | null,
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
    write(command: number, data: Uint8Array): void {
      core.writes.push(command);
      core.payloads.push(data.slice());
      if (command === core.refused) core.polls.push([{ event: 'nack', command }]);
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

/** Two-digit lowercase hex per byte, space-separated: how a report prints bytes. */
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

let logged: LogEntry[] = [];
let unsubscribe: () => void = () => undefined;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  core.polls.length = 0;
  core.writes.length = 0;
  core.payloads.length = 0;
  core.refused = null;
  logged = [];
  unsubscribe = subscribeLog((e) => logged.push(e));
});

afterEach(async () => {
  vi.useRealTimers();
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

behaviour(
  {
    id: 'session.refused-upload-logs-its-bytes',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.uploadWithRetry',
    given: 'a G-code program whose upload the board refuses on every retry',
    expect: {
      'bytes-logged': 'the upload failure in the session log lists every byte of the refused upload as hex',
      'length-logged': 'the upload failure in the session log states how many bytes the refused upload carried',
    },
    why: {
      'bytes-logged':
        'the raw serial capture covers only the last few minutes of a session, and a report can be filed any time after the failure',
    },
  },
  async () => {
    vi.useFakeTimers();
    core.refused = MSG_WRITE_TEST_MOVE;
    const session = await connectedSession();

    const streamed = session.streamGcode('G1 X5 F100\nG1 X0 F100');
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await streamed).success).toBe(false);
    const sent = core.payloads.filter((_, i) => core.writes[i] === MSG_WRITE_TEST_MOVE);
    expect(sent.length).toBeGreaterThan(1);
    const failed = logged.filter((e) => e.tag === 'upload-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data?.payloadHex).toBe(hex(sent[sent.length - 1]));
    expect(failed[0].data?.bytes).toBe(sent[sent.length - 1].length);
  },
);

behaviour(
  {
    id: 'session.unanswered-write-logs-its-bytes',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.writeAndAck',
    given: 'a manual jog whose first move the board never answers',
    expect: {
      'bytes-logged': 'the failed send in the session log lists every byte of the unanswered move as hex',
      'length-logged': 'the failed send in the session log states how many bytes the unanswered move carried',
    },
  },
  async () => {
    const session = await connectedSession();

    const moved = session.manualMove(5, 100);
    await vi.waitFor(() => expect(core.writes).toEqual([MSG_WRITE_MANUAL_MOVE]));
    core.polls.push([{ event: 'timeout', frame: writeRequest(MSG_WRITE_MANUAL_MOVE) }]);

    expect(await moved).toBe(false);
    const failed = logged.filter((e) => e.tag === 'tx-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data?.payloadHex).toBe(hex(core.payloads[0]));
    expect(failed[0].data?.bytes).toBe(core.payloads[0].length);
  },
);
