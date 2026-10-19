/**
 * How long a connected session waits for the board to answer each kind of
 * request. The waiting itself happens inside the protocol core (its own Rust
 * tests cover giving up and moving on); this pins what the session asks of it.
 */
import { afterEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { MSG_READ_SAMPLE, MSG_READ_STATE } from '@/protocol/generated/protoemb';
import { DeviceSession } from './DeviceSession.worker';

interface PeriodicRead {
  command: number;
  responseTimeoutMs?: number;
}

// What the session asked of the protocol core. vi.mock is hoisted above the
// imports, so the record it writes into has to be hoisted with it.
const core = vi.hoisted(() => ({
  clientTimeoutsMs: [] as number[],
  periodic: [] as PeriodicRead[],
}));

// The worker module imports the protocol core's WebAssembly glue, which exists
// only after `npm run build:wasm`; the Behaviour ledger job runs this suite
// without it. The stand-in records how the session sets the core up and
// otherwise answers nothing.
vi.mock('@/wasm/protoemb_runtime.js', () => ({
  default: () => Promise.resolve(),
  WasmClient: class {
    constructor(responseTimeoutMs: number) {
      core.clientTimeoutsMs.push(responseTimeoutMs);
    }
    register_periodic(command: number): void {
      core.periodic.push({ command });
    }
    register_periodic_with_timeout(
      command: number,
      _intervalMs: number,
      _storageCount: number,
      responseTimeoutMs: number,
    ): void {
      core.periodic.push({ command, responseTimeoutMs });
    }
    poll(): unknown[] {
      return [];
    }
    take_outgoing(): Uint8Array {
      return new Uint8Array(0);
    }
    feed_bytes(): void {}
    write(): void {}
    read(): void {}
    clear_queue(): void {}
    get_stored(): unknown[] {
      return [];
    }
  },
}));
vi.mock('@/wasm/protoemb_runtime_bg.wasm?url', () => ({ default: 'protoemb_runtime_bg.wasm' }));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function idleStreams(): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
  return { readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<Uint8Array>() };
}

behaviour(
  {
    id: 'session.unanswered-poll-gives-up-fast',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.connect',
    given: 'a session that has just connected to the board',
    expect: {
      'sample-poll': 'a live-sample request the board never answers is given up after a quarter of a second',
      'state-poll': 'a machine-state request the board never answers is given up after a quarter of a second',
      'other-requests': 'every other request waits two seconds for its answer',
    },
    why: {
      'sample-poll':
        'the link carries one request at a time, so an unanswered request holds up all live data until it is given up; the board answers within about 130 milliseconds at worst',
      'other-requests': 'the board can take up to two seconds to answer a request for part of a stored test file',
    },
  },
  async () => {
    const session = new DeviceSession();
    cleanups.push(() => session.disconnect());
    await session.connect(idleStreams());

    expect(core.periodic).toContainEqual({ command: MSG_READ_SAMPLE, responseTimeoutMs: 250 });
    expect(core.periodic).toContainEqual({ command: MSG_READ_STATE, responseTimeoutMs: 250 });
    expect(core.clientTimeoutsMs).toEqual([2000]);
  },
);
