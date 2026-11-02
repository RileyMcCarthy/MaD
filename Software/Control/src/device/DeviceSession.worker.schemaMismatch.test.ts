/**
 * What the device worker does with a reply it cannot decode: a board running
 * firmware built against an older (or newer) protocol schema, or a frame the
 * codec throws on. The session drops that reply, says why, and keeps the link.
 *
 * The bench case: firmware 0.14 sends a 72-byte machine configuration and a
 * 16-byte sample, where this app's schema has 84 and 19.
 *
 * The protocol core here is a stand-in that replays scripted poll results, one
 * batch per tick, and records the reads the session asks it to send.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { subscribeLog, type LogEntry } from '@/diagnostics/log';
import {
  MACHINECONFIGURATION_WIRE_SIZE,
  MSG_READ_MACHINE_CONFIGURATION,
  MSG_READ_SAMPLE,
  MSG_READ_SAMPLE_PROFILE,
  SAMPLE_WIRE_SIZE,
  SAMPLEPROFILE_WIRE_SIZE,
} from '@/protocol/generated/protoemb';
import { DeviceSession } from './DeviceSession.worker';
import type { DeviceEvent } from './events';

const core = vi.hoisted(() => ({
  /** Poll results still to come, one batch per tick. */
  polls: [] as unknown[][],
  /** Commands the session asked the core to read. */
  reads: [] as number[],
  /** Make the sample-profile mapping throw, as a codec reading past its buffer does. */
  profileThrows: false,
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
vi.mock('@/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domain')>();
  return {
    ...actual,
    sampleProfileToShared: (...args: Parameters<typeof actual.sampleProfileToShared>) => {
      if (core.profileThrows) throw new RangeError('Offset is outside the bounds of the DataView');
      return actual.sampleProfileToShared(...args);
    },
  };
});

const OLD_CONFIG_BYTES = 72;
const OLD_SAMPLE_BYTES = 16;

const data = (command: number, bytes: number) => ({
  event: 'data',
  command,
  payload: new Uint8Array(bytes),
});

let logged: LogEntry[] = [];
let unsubscribe: () => void = () => undefined;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  core.polls.length = 0;
  core.reads.length = 0;
  core.profileThrows = false;
  logged = [];
  unsubscribe = subscribeLog((e) => logged.push(e));
});

afterEach(async () => {
  unsubscribe();
  for (const fn of cleanups.splice(0)) await fn();
});

async function connectedSession(): Promise<{ session: DeviceSession; seen: DeviceEvent[] }> {
  const session = new DeviceSession();
  const seen: DeviceEvent[] = [];
  session.setEventSink((events: DeviceEvent[]) => {
    seen.push(...events);
  });
  cleanups.push(() => session.disconnect());
  await session.connect({
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
  });
  return { session, seen };
}

behaviour(
  {
    id: 'session.older-firmware-replies-dropped',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.mapData',
    given:
      'a board whose firmware answers the connect-time configuration read with 72 bytes and sends three 16-byte samples, where this app expects 84 and 19',
    expect: {
      'link-kept': 'the session stays connected and delivers the next sample of the expected size',
      'short-samples-dropped': 'no sample reaches the screen from a reply of the wrong size',
      'config-read-fails': 'the configuration read fails at once, saying the firmware uses an older protocol',
      'reported-once': 'the screen is told once per kind of reply, with the expected and received sizes',
      'all-counted': 'the diagnostics count every dropped reply',
      'logged-with-sizes': 'the session log records each kind of mismatched reply with its expected and received sizes',
    },
    why: {
      'link-kept':
        'a board one release behind must stay connected so it can be updated from the app',
      'short-samples-dropped': 'the missing bytes of a short sample would be read as zero and plotted as data',
      'config-read-fails': 'the connect-time read would otherwise wait out its timeout and retries',
    },
  },
  async () => {
    const { session, seen } = await connectedSession();

    const config = session.readMachineConfiguration();
    await vi.waitFor(() => expect(core.reads).toContain(MSG_READ_MACHINE_CONFIGURATION));
    core.polls.push(
      [data(MSG_READ_SAMPLE, OLD_SAMPLE_BYTES)],
      [data(MSG_READ_MACHINE_CONFIGURATION, OLD_CONFIG_BYTES)],
      [data(MSG_READ_SAMPLE, OLD_SAMPLE_BYTES), data(MSG_READ_SAMPLE, OLD_SAMPLE_BYTES)],
      [data(MSG_READ_SAMPLE, SAMPLE_WIRE_SIZE)],
    );

    await expect(config).rejects.toThrow(/older protocol/);
    await vi.waitFor(() => expect(seen.some((e) => e.kind === 'sample')).toBe(true));

    expect(seen.filter((e) => e.kind === 'disconnected')).toEqual([]);
    expect(seen.filter((e) => e.kind === 'sample')).toHaveLength(1);
    expect(seen.filter((e) => e.kind === 'schemaMismatch')).toEqual([
      {
        kind: 'schemaMismatch',
        mismatch: { command: MSG_READ_SAMPLE, name: 'sample', expected: SAMPLE_WIRE_SIZE, actual: OLD_SAMPLE_BYTES },
      },
      {
        kind: 'schemaMismatch',
        mismatch: {
          command: MSG_READ_MACHINE_CONFIGURATION,
          name: 'machine configuration',
          expected: MACHINECONFIGURATION_WIRE_SIZE,
          actual: OLD_CONFIG_BYTES,
        },
      },
    ]);
    expect(session.getDiagnostics().decodeFailures).toBe(4);
    expect(
      logged.filter((e) => e.tag === 'payload-size-mismatch').map((e) => [e.msg, e.data?.expected, e.data?.actual]),
    ).toEqual([
      ['READ_SAMPLE(0)', SAMPLE_WIRE_SIZE, OLD_SAMPLE_BYTES],
      ['READ_MACHINE_CONFIGURATION(2)', MACHINECONFIGURATION_WIRE_SIZE, OLD_CONFIG_BYTES],
    ]);
  },
);

behaviour(
  {
    id: 'session.undecodable-reply-dropped',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.tick',
    given: 'a sample-profile reply of the expected size that the decoder throws on',
    expect: {
      'link-kept': 'the session stays connected and delivers the next sample',
      'counted': 'the diagnostics count the dropped reply',
      'logged': "the session log records the decoder's error with the reply's command and size",
    },
  },
  async () => {
    const { session, seen } = await connectedSession();
    core.profileThrows = true;

    core.polls.push([data(MSG_READ_SAMPLE_PROFILE, SAMPLEPROFILE_WIRE_SIZE)], [data(MSG_READ_SAMPLE, SAMPLE_WIRE_SIZE)]);

    await vi.waitFor(() => expect(seen.some((e) => e.kind === 'sample')).toBe(true));
    expect(seen.filter((e) => e.kind === 'disconnected')).toEqual([]);
    expect(session.getDiagnostics().decodeFailures).toBe(1);
    const failed = logged.find((e) => e.tag === 'decode-failed');
    expect(failed?.msg).toMatch(/RangeError/);
    expect(failed?.data).toMatchObject({
      command: 'READ_SAMPLE_PROFILE(4)',
      expected: SAMPLEPROFILE_WIRE_SIZE,
      actual: SAMPLEPROFILE_WIRE_SIZE,
    });
  },
);
