import { describe, it, expect } from 'vitest';
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
  it('does not lose bytes that arrive after an earlier read timed out', async () => {
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
  });

  it('survives a flush that times out, then still reads the reply', async () => {
    // flushInput() drains with a 5 ms budget and normally times out; that must
    // not consume the response to the write that follows it.
    const { port } = slowPort('\r\nProp_Ver G', 40);
    const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);

    await t.flushInput();
    await t.write(Uint8Array.from('probe', (c) => c.charCodeAt(0)));
    const reply = await t.read(20, 500);

    expect(new TextDecoder('latin1').decode(reply)).toBe('\r\nProp_Ver G');
  });

  it('returns a short read rather than hanging for the full request', async () => {
    const { port } = slowPort('ab', 5);
    const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);
    await t.write(Uint8Array.from([0x21]));
    const got = await t.read(20, 200); // asks for 20, only 2 will ever arrive
    expect(new TextDecoder('latin1').decode(got)).toBe('ab');
  });

  it('hands leftover bytes to the next read', async () => {
    const { port } = slowPort('abcdef', 5);
    const t = await WebSerialTransport.open(port, LOADER_BAUD_RATE);
    await t.write(Uint8Array.from([0x21]));
    expect(new TextDecoder('latin1').decode(await t.read(2, 200))).toBe('ab');
    expect(new TextDecoder('latin1').decode(await t.read(4, 200))).toBe('cdef');
  });

  it('pulses DTR through to the port', async () => {
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
  });
});
