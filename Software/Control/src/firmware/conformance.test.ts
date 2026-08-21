/**
 * Differential conformance: our loader must transmit byte-for-byte what the
 * real `loadp2` transmits. See golden/README.md for how the captures are made.
 *
 * This is deliberately a whole-stream comparison rather than a set of
 * assertions about framing — an assertion can only check what we thought to
 * check, whereas a byte-exact diff against the reference implementation
 * catches anything we did not think of.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { P2Transport } from './p2loader';
import { programTransport } from './program';
import type { ProgramMode } from './program';

/** Same generator the golden images were built with. */
function testImage(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 7) & 0xff);
}

/** Minimal ROM stand-in: records everything sent, answers the two prompts. */
class CapturingRom implements P2Transport {
  sent: number[] = [];
  private outbox: number[] = [];

  async write(data: Uint8Array) {
    this.sent.push(...data);
    const text = String.fromCharCode(...data);
    if (text.includes('Prop_Chk')) this.reply('\r\nProp_Ver G');
    if (text.endsWith('?')) this.reply('.');
  }
  async read(maxBytes: number) {
    return Uint8Array.from(this.outbox.splice(0, maxBytes));
  }
  async setDtr() {}
  async flushInput() {}
  async drain() {}
  private reply(s: string) {
    for (const c of s) this.outbox.push(c.charCodeAt(0));
  }
}

const CASES: Array<{ name: string; size: number }> = [
  { name: 'tiny4', size: 4 },
  { name: 'chunk128', size: 128 },
  { name: 'partial300', size: 300 },
  { name: 'exact1024', size: 1024 },
];

const golden = (name: string, mode: ProgramMode) =>
  readFileSync(join(__dirname, 'golden', `${name}.${mode}.hex`), 'utf8').trim();

describe('loadp2 conformance', () => {
  for (const { name, size } of CASES) {
    for (const mode of ['ram', 'flash'] as const) {
      it(`matches loadp2 byte-for-byte: ${name} (${size} B), ${mode}`, async () => {
        const rom = new CapturingRom();
        await programTransport(rom, testImage(size), { mode });
        const ours = Buffer.from(rom.sent).toString('hex');
        const theirs = golden(name, mode);

        // Compare lengths first: a length mismatch produces a far more legible
        // failure than a 9 KB hex diff.
        expect(ours.length / 2).toBe(theirs.length / 2);
        expect(ours).toBe(theirs);
      });
    }
  }

  it('golden captures start with the ROM autobaud probe', () => {
    // Guards against a regenerated golden that silently lost its prefix.
    const head = Buffer.from(golden('tiny4', 'ram'), 'hex').toString('latin1');
    expect(head.startsWith('> Prop_Chk 0 0 0 0  > Prop_Hex 0 0 0 0')).toBe(true);
  });

  it('RAM captures end with a checksum request, flash captures with ~', () => {
    const ram = Buffer.from(golden('partial300', 'ram'), 'hex').toString('latin1');
    const flash = Buffer.from(golden('partial300', 'flash'), 'hex').toString('latin1');
    expect(ram.endsWith('?')).toBe(true);
    expect(flash.endsWith('~')).toBe(true);
  });
});
