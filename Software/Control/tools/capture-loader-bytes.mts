/**
 * Emit exactly what our loader would transmit, as hex, for golden-file
 * comparison against the real loadp2. See src/firmware/golden/README.md.
 *
 *   vite-node tools/capture-loader-bytes.mts -- <image> <ram|flash>
 */
import { readFile } from 'node:fs/promises';
import type { P2Transport } from '../src/firmware/p2loader';
import { programTransport } from '../src/firmware/program';

class CapturingRom implements P2Transport {
  sent: number[] = [];
  private outbox: number[] = [];

  async write(data: Uint8Array) {
    this.sent.push(...data);
    const text = String.fromCharCode(...data);
    if (text.includes('Prop_Chk')) this.push('\r\nProp_Ver G');
    if (text.endsWith('?')) this.push('.');
  }
  async read(maxBytes: number) {
    return Uint8Array.from(this.outbox.splice(0, maxBytes));
  }
  async setDtr() {}
  async flushInput() {}
  async drain() {}
  private push(s: string) {
    for (const c of s) this.outbox.push(c.charCodeAt(0));
  }
}

const [file, mode] = process.argv.slice(2).filter((a) => a !== '--');
const rom = new CapturingRom();
await programTransport(rom, new Uint8Array(await readFile(file)), {
  mode: mode === 'flash' ? 'flash' : 'ram',
});
process.stdout.write(Buffer.from(rom.sent).toString('hex'));
