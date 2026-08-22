/**
 * Dev-only CLI that drives the browser loader's protocol code over Node's
 * `serialport`, against real P2 hardware.
 *
 * The point is to validate `src/firmware/` headlessly — same reset pulse, same
 * ROM handshake, same hex framing the PWA uses — so a failure here is a
 * protocol or wiring problem, and a failure only in the browser is a Web Serial
 * problem. Run it before trusting the UI on a new board or adapter.
 *
 *   npm run hw:flash -- --detect                       # handshake only, no write
 *   npm run hw:flash -- --ram   path/to/program        # load into RAM, volatile
 *   npm run hw:flash -- --flash path/to/program        # write to SPI flash
 *
 * Port defaults to $MAD_SERIAL. On MaD hardware this must be the adapter
 * plugged into header J1 (P62/P63/RESn/GND) — the RPi link through the
 * isolators has no reset line and cannot be used for programming.
 */
import { readFile } from 'node:fs/promises';
import { SerialPort } from 'serialport';
import type { P2Transport } from '../src/firmware/p2loader';
import { detectP2 } from '../src/firmware/p2loader';
import { programTransport } from '../src/firmware/program';
import { estimateSeconds } from '../src/firmware/image';

const LOADER_BAUD = Number(process.env.MAD_LOADER_BAUD || 2_000_000);

class NodeSerialTransport implements P2Transport {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly port: SerialPort) {
    port.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
    });
  }

  static open(path: string, baudRate: number): Promise<NodeSerialTransport> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate, autoOpen: true }, (err) =>
        err ? reject(err) : resolve(new NodeSerialTransport(port)),
      );
    });
  }

  write(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
    });
  }

  drain(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.drain((err) => (err ? reject(err) : resolve()));
    });
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < maxBytes && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2));
    }
    const take = Math.min(maxBytes, this.buf.length);
    const out = Uint8Array.from(this.buf.subarray(0, take));
    this.buf = this.buf.subarray(take);
    return out;
  }

  async flushInput(): Promise<void> {
    this.buf = Buffer.alloc(0);
  }

  setDtr(asserted: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.set({ dtr: asserted }, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.port.close(() => resolve()));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--flash') ? 'flash' : args.includes('--ram') ? 'ram' : 'detect';
  const file = args.find((a) => !a.startsWith('--'));
  const path = process.env.MAD_SERIAL;

  if (!path) {
    console.error('Set MAD_SERIAL to the serial device (the adapter on header J1).');
    process.exit(2);
  }
  if (mode !== 'detect' && !file) {
    console.error(`Pass a firmware image, e.g. --${mode} ../../Firmware/MaDCore/.pio/build/propeller2/program`);
    process.exit(2);
  }

  console.log(`[hw-p2load] ${path} @ ${LOADER_BAUD} baud, mode=${mode}`);
  const transport = await NodeSerialTransport.open(path, LOADER_BAUD);
  try {
    if (mode === 'detect') {
      const version = await detectP2(transport);
      console.log(`[hw-p2load] boot ROM responded: Prop_Ver ${version}`);
      console.log('[hw-p2load] OK — DTR reset and autobaud both work on this port.');
      return;
    }

    const firmware = new Uint8Array(await readFile(file!));
    console.log(
      `[hw-p2load] ${file} is ${firmware.byteLength} bytes; ` +
        `~${estimateSeconds(firmware.byteLength, LOADER_BAUD).toFixed(1)}s to send`,
    );

    let lastPct = -1;
    const result = await programTransport(transport, firmware, {
      mode,
      onProgress: (p) => {
        if (p.phase !== 'uploading' || !p.total) {
          console.log(`[hw-p2load] ${p.phase}`);
          return;
        }
        const pct = Math.floor(((p.sent ?? 0) / p.total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          console.log(`[hw-p2load] uploading ${pct}%`);
          lastPct = pct;
        }
      },
    });
    console.log(
      `[hw-p2load] done — ROM ${result.romVersion}, ${result.imageBytes} bytes sent` +
        (mode === 'flash' ? ' (board reboots from flash)' : ' (running from RAM until reset)'),
    );
  } finally {
    await transport.close();
  }
}

main().catch((err) => {
  console.error(`[hw-p2load] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
