import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { programPort, type ProgramPhase } from './program';
import { flashWriteMs } from './image';

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
  const times = { lastWrite: 0, closed: 0 };
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
      times.lastWrite = performance.now();
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
      times.closed = performance.now();
      log.push('close');
    },
  } as unknown as SerialPort;

  return { port, log, times };
}

const firmware = Uint8Array.from({ length: 64 }, (_, i) => i);

describe('programPort', () => {
  behaviour(
    {
      id: 'flash.port-opened-and-closed',
      covers: 'src/firmware/program.ts#programPort',
      given: 'a successful RAM load through a serial port',
      expect: {
        'port-opened-and-closed': 'the port is opened for the load and closed when it finishes',
        'rom-version-reported': 'the load reports the boot ROM version it found',
      },
    },
    async () => {
      const { port, log } = romPort();
      const result = await programPort(port, firmware, { mode: 'ram' });
      expect(result.romVersion).toBe('G');
      expect(log).toEqual(['open', 'close']);
    },
  );

  behaviour(
    {
      id: 'flash.port-closed-after-failed-load',
      covers: 'src/firmware/program.ts#programPort',
      given: 'a RAM load on a serial port whose chip never answers',
      expect: {
        'no-response-reported': 'the load reports no response from the boot ROM',
        'port-closed': 'the serial port is closed',
      },
      why: { 'port-closed': 'a serial port left open after a failed load cannot be opened again' },
    },
    async () => {
      // A silent ROM makes detectP2 give up; the port must still be released or
      // the next attempt fails with "port already open" and the user is stuck.
      const { port, log } = romPort({ silent: true });
      await expect(programPort(port, firmware, { mode: 'ram' })).rejects.toMatchObject({
        code: 'no-response',
      });
      expect(log).toEqual(['open', 'close']);
    },
  );

  behaviour(
    {
      id: 'flash.port-open-failure-skips-close',
      covers: 'src/firmware/program.ts#programPort',
      given: 'a serial port that fails to open because it is already open',
      expect: {
        'open-error-reported': 'the open error is reported',
        'no-close-attempted': 'no close is attempted',
      },
      why: { 'no-close-attempted': 'closing a port that never opened would hide the original open error' },
    },
    async () => {
      const { port, log } = romPort({ failOpen: true });
      await expect(programPort(port, firmware, { mode: 'ram' })).rejects.toThrow(/already open/);
      expect(log).toEqual(['open']);
    },
  );

  behaviour(
    {
      id: 'flash.rom-reply-split-across-chunks',
      covers: 'src/firmware/program.ts#programPort',
      given: 'a boot ROM version reply that arrives in two pieces',
      expect: { 'version-reported': 'the load reports the boot ROM version' },
      why: { 'version-reported': 'real serial adapters deliver replies in arbitrary pieces' },
    },
    async () => {
      const { port } = romPort({ splitWrites: true });
      const result = await programPort(port, firmware, { mode: 'ram' });
      expect(result.romVersion).toBe('G');
    },
  );

  behaviour(
    {
      id: 'flash.flash-load-size-includes-stub',
      covers: 'src/firmware/program.ts#programPort',
      given: 'a 64-byte firmware file loaded to flash through a serial port',
      expect: {
        'size-includes-stub': 'the reported image size includes the 496-byte flash-boot stub ahead of the firmware',
      },
    },
    async () => {
      const { port } = romPort();
      const result = await programPort(port, firmware, { mode: 'flash', wait: async () => {} });
      expect(result.imageBytes).toBe(496 + firmware.byteLength);
    },
  );

  behaviour(
    {
      id: 'flash.port-held-while-flash-writes',
      covers: 'src/firmware/program.ts#programTransport',
      given: 'a firmware file loaded to flash through a serial port',
      expect: {
        'held-for-write-time': 'after the upload the port stays open for the estimated flash write time of the whole image, and only then closes',
        'writing-shown': 'progress reports a flash-writing phase, with its duration, between the upload and completion',
      },
      why: {
        'held-for-write-time':
          'the chip erases and programs flash only after the whole image has arrived; a reset from re-opening the port before then leaves a partial image that does not boot',
      },
    },
    async () => {
      // The real wait, so the port's close is timed against the last byte sent.
      const { port, times } = romPort();
      const phases: ProgramPhase[] = [];
      let writeMs: number | undefined;
      await programPort(port, firmware, {
        mode: 'flash',
        onProgress: (p) => {
          if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
          if (p.phase === 'writing') writeMs = p.writeMs;
        },
      });
      const expectedMs = flashWriteMs(496 + firmware.byteLength);
      // Timers may fire a hair early; a millisecond of slack is not a write.
      expect(times.closed - times.lastWrite).toBeGreaterThanOrEqual(expectedMs - 1);
      expect(phases).toEqual(['resetting', 'uploading', 'writing', 'verifying', 'done']);
      expect(writeMs).toBe(expectedMs);
    },
  );

  behaviour(
    {
      id: 'flash.ram-load-does-not-wait',
      covers: 'src/firmware/program.ts#programTransport',
      given: 'a firmware file loaded to RAM through a serial port',
      expect: { 'no-write-wait': 'the port closes as soon as the upload is verified, with no flash-writing phase' },
    },
    async () => {
      const { port, log } = romPort();
      const phases: ProgramPhase[] = [];
      await programPort(port, firmware, {
        mode: 'ram',
        onProgress: (p) => phases.push(p.phase),
        wait: async (ms) => {
          log.push(`wait ${ms}`);
        },
      });
      expect(log).toEqual(['open', 'close']);
      expect(phases).not.toContain('writing');
    },
  );
});
