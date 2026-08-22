import { describe, it, expect } from 'vitest';
import { programPort } from './program';

/**
 * A SerialPort that speaks enough of the boot ROM to complete a load, and
 * records its own lifecycle so we can assert the port is always handed back.
 *
 * Deliberately exercises the real WebSerialTransport rather than stubbing
 * P2Transport — the seam between this app and Web Serial is where the
 * orphaned-read bug lived, and stubbing it is what let that bug survive.
 */
function romPort(opts: { failOpen?: boolean; silent?: boolean; splitWrites?: boolean } = {}) {
  const log: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let text = '';

  const reply = (s: string) => controller?.enqueue(Uint8Array.from(s, (c) => c.charCodeAt(0)));

  // Built once and handed back by a stable getter, as the real API does.
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      text += String.fromCharCode(...chunk);
      if (opts.silent) return;
      if (text.includes('Prop_Chk 0 0 0 0')) {
        text = '';
        // Real UARTs deliver replies in arbitrary pieces.
        if (opts.splitWrites) {
          reply('\r\nProp_');
          setTimeout(() => reply('Ver G'), 5);
        } else {
          reply('\r\nProp_Ver G');
        }
      }
      if (text.endsWith('?')) reply('.');
    },
  });

  const port = {
    async open() {
      log.push('open');
      if (opts.failOpen) throw new Error('port already open');
    },
    readable,
    writable,
    async setSignals() {},
    async close() {
      log.push('close');
    },
  } as unknown as SerialPort;

  return { port, log };
}

const firmware = Uint8Array.from({ length: 64 }, (_, i) => i);

describe('programPort', () => {
  it('opens the port, programs, and closes it again', async () => {
    const { port, log } = romPort();
    const result = await programPort(port, firmware, { mode: 'ram' });
    expect(result.romVersion).toBe('G');
    expect(log).toEqual(['open', 'close']);
  });

  it('closes the port even when programming fails', async () => {
    // A silent ROM makes detectP2 give up; the port must still be released or
    // the next attempt fails with "port already open" and the user is stuck.
    const { port, log } = romPort({ silent: true });
    await expect(programPort(port, firmware, { mode: 'ram' })).rejects.toMatchObject({
      code: 'no-response',
    });
    expect(log).toEqual(['open', 'close']);
  });

  it('does not try to close a port that never opened', async () => {
    const { port, log } = romPort({ failOpen: true });
    await expect(programPort(port, firmware, { mode: 'ram' })).rejects.toThrow(/already open/);
    expect(log).toEqual(['open']);
  });

  it('tolerates a reply split across chunks, as a real UART would', async () => {
    const { port } = romPort({ splitWrites: true });
    const result = await programPort(port, firmware, { mode: 'ram' });
    expect(result.romVersion).toBe('G');
  });

  it('reports the flash image size including the prepended stub', async () => {
    const { port } = romPort();
    const result = await programPort(port, firmware, { mode: 'flash' });
    expect(result.imageBytes).toBe(496 + firmware.byteLength);
  });
});
