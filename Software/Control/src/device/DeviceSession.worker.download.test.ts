/**
 * How a connected session asks the board for part of a stored test file. The
 * board answers a download request with the data (or a refusal), never with a
 * plain acknowledgement, and the protocol core only ends a plain write on an
 * acknowledgement or refusal (protoemb#30). So the request has to go to the
 * core as a query, which ends on the data.
 */
import { afterEach, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { MSG_WRITE_FILE_DOWNLOAD, STOREDSAMPLE_WIRE_SIZE } from '@/protocol/generated/protoemb';
import { DeviceSession } from './DeviceSession.worker';

interface Sent {
  command: number;
  data: Uint8Array;
}

// What the session handed the protocol core, and what the stand-in board will
// answer on the next poll. vi.mock is hoisted above the imports, so the record
// it writes into has to be hoisted with it.
const core = vi.hoisted(() => ({
  queries: [] as Sent[],
  writes: [] as Sent[],
  replies: [] as unknown[],
  // Bytes in the board's answer to each download request.
  answerBytes: 0,
}));

// The worker module imports the protocol core's WebAssembly glue, which exists
// only after `npm run build:wasm`; the Behaviour ledger job runs this suite
// without it. The stand-in answers each query with one DATA frame for the same
// command, and leaves a plain write unanswered, as the real core would after
// protoemb#30 for a write the board answers with data.
vi.mock('@/wasm/protoemb_runtime.js', () => ({
  default: () => Promise.resolve(),
  WasmClient: class {
    register_periodic(): void {}
    register_periodic_with_timeout(): void {}
    poll(): unknown[] {
      return core.replies.splice(0);
    }
    take_outgoing(): Uint8Array {
      return new Uint8Array(0);
    }
    feed_bytes(): void {}
    query(command: number, data: Uint8Array): void {
      core.queries.push({ command, data: Uint8Array.from(data) });
      core.replies.push({ event: 'data', command, payload: new Uint8Array(core.answerBytes) });
    }
    write(command: number, data: Uint8Array): void {
      core.writes.push({ command, data: Uint8Array.from(data) });
    }
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
    id: 'session.file-download-asks-as-query',
    covers: 'src/device/DeviceSession.worker.ts#DeviceSession.downloadTestFile',
    given: 'a connected session downloading a stored test whose last part the board sends at once',
    expect: {
      'asked-as-query':
        'each request for part of the test goes to the protocol core as a query, and none as a plain write',
      'download-completes': 'the download finishes with the samples the board sent',
    },
    why: {
      'asked-as-query':
        'the protocol core ends a plain write only on an acknowledgement or refusal, and the board answers a download request with data, so a plain write would wait out its timeout on every part',
    },
  },
  async () => {
    const session = new DeviceSession();
    cleanups.push(() => session.disconnect());
    await session.connect(idleStreams());
    core.answerBytes = 3 * STOREDSAMPLE_WIRE_SIZE;

    const result = await session.downloadTestFile('tensile-01');

    expect(core.queries.length).toBeGreaterThan(0);
    expect(core.queries.every((q) => q.command === MSG_WRITE_FILE_DOWNLOAD)).toBe(true);
    expect(core.writes.filter((w) => w.command === MSG_WRITE_FILE_DOWNLOAD)).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.sampleBytes).toBe(3 * STOREDSAMPLE_WIRE_SIZE);
  },
);
