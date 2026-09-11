import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { WebSerialTransport, LOADER_BAUD_RATE } from './webSerialTransport';

/**
 * A SerialPort whose reply arrives only after `latencyMs`, so a read issued
 * before the data exists must still deliver it.
 */
function slowPort(reply: string, latencyMs: number) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const written: number[] = [];
  const port = {
    async open() {},
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(...chunk);
        setTimeout(() => {
          controller?.enqueue(Uint8Array.from(reply, (c) => c.charCodeAt(0)));
        }, latencyMs);
      },
    }),
    async setSignals() {},
    async close() {},
  } as unknown as SerialPort;
  return { port, written };
}

describe('WebSerialTransport reads', () => {
  behaviour(
    {
      id: 'flash.read-after-timeout-still-delivers',
      covers: 'src/firmware/webSerialTransport.ts#WebSerialTransport.read',
      given: 'a boot ROM reply that arrives after the first read has already timed out',
      then: 'bytes that arrive after a timed-out serial-port read are delivered to the next read',
      why: 'the boot ROM\'s version reply is often slower than the first read\'s budget; those bytes must be readable',
    },
    async () => {
      // The regression this guards: racing reader.read() against a timer and
      // abandoning the read leaves it pending on the stream, so the next chunk
      // resolves the orphan and is dropped. On hardware that ate the boot ROM's
      // Prop_Ver reply, because flushInput() always times out first.
      const { port } = slowPort('\r\nProp_Ver G', 60);
      const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);

      await t.write(Uint8Array.from('probe', (c) => c.charCodeAt(0)));

      // First read gives up before the reply lands.
      const early = await t.read(20, 10);
      expect(early.byteLength).toBe(0);

      // A later read must still see it.
      const later = await t.read(20, 500);
      expect(new TextDecoder('latin1').decode(later)).toBe('\r\nProp_Ver G');
    },
  );

  behaviour(
    {
      id: 'flash.flush-then-read-still-delivers',
      covers: 'src/firmware/webSerialTransport.ts#WebSerialTransport.flushInput',
      given: 'draining leftover input times out, then a probe is written and the boot ROM replies',
      then: 'a boot ROM reply that arrives after a timed-out drain of leftover input is read',
      why: 'draining leftover input uses a short budget and often times out; the reply to the write that follows must be readable',
    },
    async () => {
      // flushInput() drains with a 5 ms budget and normally times out; that must
      // not consume the response to the write that follows it.
      const { port } = slowPort('\r\nProp_Ver G', 40);
      const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);

      await t.flushInput();
      await t.write(Uint8Array.from('probe', (c) => c.charCodeAt(0)));
      const reply = await t.read(20, 500);

      expect(new TextDecoder('latin1').decode(reply)).toBe('\r\nProp_Ver G');
    },
  );

  behaviour(
    {
      id: 'flash.read-returns-what-arrived',
      covers: 'src/firmware/webSerialTransport.ts#WebSerialTransport.read',
      given: 'a two-byte reply when twenty bytes were requested',
      then: 'a serial-port read returns the bytes that arrived without waiting for the requested length',
    },
    async () => {
      const { port } = slowPort('ab', 5);
      const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);
      await t.write(Uint8Array.from([0x21]));
      const got = await t.read(20, 200); // asks for 20, only 2 will ever arrive
      expect(new TextDecoder('latin1').decode(got)).toBe('ab');
    },
  );

  behaviour(
    {
      id: 'flash.read-hands-remainder-to-next-call',
      covers: 'src/firmware/webSerialTransport.ts#WebSerialTransport.read',
      given: 'a six-byte reply read first as two bytes then as four',
      then: 'bytes left over from a short serial-port read are delivered to the next read',
    },
    async () => {
      const { port } = slowPort('abcdef', 5);
      const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);
      await t.write(Uint8Array.from([0x21]));
      expect(new TextDecoder('latin1').decode(await t.read(2, 200))).toBe('ab');
      expect(new TextDecoder('latin1').decode(await t.read(4, 200))).toBe('cdef');
    },
  );

  behaviour(
    {
      id: 'flash.dtr-forwarded-to-serial-port',
      covers: 'src/firmware/webSerialTransport.ts#WebSerialTransport.setDtr',
      given: 'the loader asserting then releasing the serial-port reset line',
      then: 'asserting and releasing reset is forwarded to the serial port as DTR',
    },
    async () => {
      const seen: boolean[] = [];
      const port = {
        async open() {},
        readable: new ReadableStream<Uint8Array>({ start() {} }),
        writable: new WritableStream<Uint8Array>({ write() {} }),
        async setSignals({ dataTerminalReady }: { dataTerminalReady?: boolean }) {
          seen.push(!!dataTerminalReady);
        },
        async close() {},
      } as unknown as SerialPort;

      const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);
      await t.setDtr(true);
      await t.setDtr(false);
      expect(seen).toEqual([true, false]);
    },
  );
});
