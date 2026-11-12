/**
 * A test-program upload the board refuses, as the device worker reports it:
 * the refusal's reason has to survive from the protocol core's event all the
 * way to the message the run fails with, which is what a bug report quotes.
 *
 * The protocol core is a stand-in that acknowledges every write except the
 * waveform, which it refuses with a reason, and records what it was sent.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { MSG_WRITE_TEST_WAVEFORM, NACK_REASON } from '@/protocol/generated/protoemb';
import { DeviceSession } from './DeviceSession.worker';

const core = vi.hoisted(() => ({
  /** Replies still to come, one batch per tick. */
  polls: [] as unknown[][],
  /** Commands the session asked the core to write, in order. */
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
      core.polls.push([
        command === MSG_WRITE_TEST_WAVEFORM
          ? { event: 'nack', command, reason: NACK_REASON.BAD_SIZE }
          : { event: 'ack', command },
      ]);
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  vi.useRealTimers();
});

behaviour(
  {
    id: 'session.upload-refusal-names-reason',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.runTest',
    given: 'a test program with a waveform, uploaded to a board that refuses the waveform because its size is wrong',
    expect: {
      'run-fails-with-reason': "the test does not start, and its failure names the reason and what it means",
      'refused-waveform-retried': 'the waveform is offered three times before the upload gives up',
    },
    why: {
      'run-fails-with-reason':
        'that failure message is the line a bug report quotes, so the reason has to reach it from the board unchanged',
    },
  },
  async () => {
    const session = new DeviceSession();
    cleanups.push(() => session.disconnect());
    await session.connect({
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>(),
    });

    const run = session.runTest({
      gcode: ['G90', 'G123 A3 F1 C2 W1', 'G122'],
      gcodeId: '000017',
      testDataId: 'td0017',
      gaugeLengthMm: 10,
    });
    // Upload retries wait a second between attempts.
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1100);
    const result = await run;

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      `device NACKed command ${MSG_WRITE_TEST_WAVEFORM}: BAD_SIZE: The payload is not the size this command takes.`,
    );
    expect(core.writes.filter((c) => c === MSG_WRITE_TEST_WAVEFORM)).toHaveLength(3);
  },
);
