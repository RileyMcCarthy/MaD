import { describe, it, expect } from 'vitest';
import { WebSerialTransport, LOADER_BAUD_RATE } from './webSerialTransport';
import { programPort } from './program';

/** Resolves to 'timeout' if `p` has not settled within `ms`. */
const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => 'settled' as const).catch(() => 'settled' as const),
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);

describe('teardown must not lose the tail of an upload', () => {
  it('flushes queued writes before closing the port', async () => {
    // The sink accepts bytes slowly, so the last write is still queued when
    // close() runs. Releasing the writer lock without closing it drops that
    // data — on a flash write that means a truncated, unbootable image.
    const delivered: number[] = [];
    const port = {
      async open() {},
      readable: new ReadableStream<Uint8Array>({ start() {} }),
      writable: new WritableStream<Uint8Array>(
        {
          async write(chunk) {
            await new Promise((r) => setTimeout(r, 20));
            delivered.push(...chunk);
          },
        },
        new CountQueuingStrategy({ highWaterMark: 8 }),
      ),
      async setSignals() {},
      async close() {},
    } as unknown as SerialPort;

    const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);
    // Don't await: queue them the way a real upload does.
    void t.write(Uint8Array.from([1, 2, 3]));
    void t.write(Uint8Array.from([4, 5, 6]));
    const tail = t.write(Uint8Array.from([7, 8, 9]));
    await t.drain();
    await t.close();
    await tail.catch(() => {});

    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('teardown must not hang', () => {
  it('gives up on a port whose close() never settles', async () => {
    // A half-dead USB stream can make close() hang. programPort awaits
    // transport.close() in a finally, so a hang there swallows the real error
    // and the UI sits on "Programming…" forever with no way back.
    const port = {
      async open() {},
      readable: new ReadableStream<Uint8Array>({ start() {} }),
      writable: new WritableStream<Uint8Array>({
        write() {
          throw new Error('The device has been lost.');
        },
      }),
      async setSignals() {},
      close: () => new Promise<void>(() => {}), // never settles
    } as unknown as SerialPort;

    const run = programPort(port, Uint8Array.from([1, 2, 3, 4]), { mode: 'ram' });
    expect(await within(run, 4000)).toBe('settled');
  }, 10000);

  it('gives up on a reader whose cancel() never settles', async () => {
    const port = {
      async open() {},
      readable: new ReadableStream<Uint8Array>({
        start() {},
        cancel: () => new Promise<void>(() => {}), // never settles
      }),
      writable: new WritableStream<Uint8Array>({ write() {} }),
      async setSignals() {},
      async close() {},
    } as unknown as SerialPort;

    const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);
    expect(await within(t.close(), 4000)).toBe('settled');
  }, 10000);
});

describe('flushInput must terminate', () => {
  it('stops on a port that never goes quiet', async () => {
    // A board still running firmware streams samples continuously. flushInput
    // loops while chunks keep arriving, so a chatty port wedges it forever.
    let stop = false;
    const port = {
      async open() {},
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          const pump = () => {
            if (stop) return;
            c.enqueue(Uint8Array.from([0x55]));
            setTimeout(pump, 1);
          };
          pump();
        },
      }),
      writable: new WritableStream<Uint8Array>({ write() {} }),
      async setSignals() {},
      async close() {},
    } as unknown as SerialPort;

    const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);
    try {
      expect(await within(t.flushInput(), 3000)).toBe('settled');
    } finally {
      stop = true;
    }
  }, 10000);
});

describe('detect must not leak bytes into the load', () => {
  it('does not feed stale banner bytes to the checksum reply', async () => {
    // Real boards emit more than the bare Prop_Ver reply after a reset. Anything
    // left in the buffer must not be mistaken for the ROM's "." acknowledgement.
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let text = '';
    const emit = (s: string) => controller?.enqueue(Uint8Array.from(s, (c) => c.charCodeAt(0)));
    const port = {
      async open() {},
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          text += String.fromCharCode(...chunk);
          if (text.includes('Prop_Chk 0 0 0 0')) {
            text = '';
            emit('\r\nProp_Ver G'); // reply, plus trailing line noise
            emit('.');
          }
          if (text.endsWith('?')) emit('!'); // the REAL answer: rejected
        },
      }),
      async setSignals() {},
      async close() {},
    } as unknown as SerialPort;

    // The stray '.' must not be consumed as the checksum ack; the genuine '!'
    // must surface as a rejection.
    await expect(
      programPort(port, Uint8Array.from([1, 2, 3, 4]), { mode: 'ram' }),
    ).rejects.toMatchObject({ code: 'rejected' });
  }, 10000);
});
