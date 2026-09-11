import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { WebSerialTransport, LOADER_BAUD_RATE } from './webSerialTransport';
import { programPort } from './program';

/** Resolves to 'timeout' if `p` has not settled within `ms`. */
const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => 'settled' as const).catch(() => 'settled' as const),
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);

describe('teardown must not lose the tail of an upload', () => {
  behaviour(
    {
      id: 'flash.close-delivers-queued-writes',
      covers: 'src/firmware/webSerialTransport.ts#WebSerialTransport.close',
      given: 'three writes still queued when the serial port is closed',
      then: 'closing the serial port delivers every queued write before the port is released',
      why: 'a flash load whose last bytes were dropped would leave an unbootable image',
    },
    async () => {
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
    },
  );
});

describe('teardown must not hang', () => {
  behaviour(
    {
      id: 'flash.close-completes-when-port-hangs',
      covers: 'src/firmware/webSerialTransport.ts#WebSerialTransport.close',
      given: 'a serial port whose close never finishes, during a load that already failed',
      then: 'a load whose serial port never finishes closing completes',
      why: 'a hung close would leave the operator stuck on Programming with no way back',
    },
    async () => {
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
    },
  );

  behaviour(
    {
      id: 'flash.close-completes-when-reader-hangs',
      covers: 'src/firmware/webSerialTransport.ts#WebSerialTransport.close',
      given: 'a serial-port reader whose cancel never finishes',
      then: 'closing a serial port whose reader never finishes cancelling completes',
    },
    async () => {
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
    },
  );
});

describe('flushInput must terminate', () => {
  behaviour(
    {
      id: 'flash.flush-completes-on-chatty-port',
      covers: 'src/firmware/webSerialTransport.ts#WebSerialTransport.flushInput',
      given: 'a serial port that keeps delivering bytes because the board is still running firmware',
      then: 'draining leftover input on a serial port that never goes quiet completes',
      why: 'a board still running firmware streams samples continuously, so waiting for silence would never finish',
    },
    async () => {
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
    },
  );
});

describe('detect must not leak bytes into the load', () => {
  behaviour(
    {
      id: 'flash.detect-leftovers-ignored-at-checksum',
      covers: 'src/firmware/program.ts#programPort',
      given: 'a chip that emits extra bytes after its version reply, then rejects the image checksum',
      then: 'a checksum rejection is reported even when leftover bytes from detecting the chip included an acknowledgement character',
      why: 'only the reply to the checksum request counts as the boot ROM\'s acknowledgement',
    },
    async () => {
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
    },
  );
});
