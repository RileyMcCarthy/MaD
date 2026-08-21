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

/** The raw bytes real loadp2 put on the wire for this case. */
const golden = (name: string, mode: ProgramMode): Buffer =>
  readFileSync(join(__dirname, 'golden', `${name}.${mode}.bin`));

/**
 * Where two streams first disagree, rendered with a little context either side.
 * A raw 9 KB buffer diff is unreadable; this points at the byte that matters.
 */
function describeMismatch(ours: Buffer, theirs: Buffer): string {
  const at = ours.findIndex((b, i) => theirs[i] !== b);
  if (at < 0) return `identical for ${Math.min(ours.length, theirs.length)} bytes, then lengths differ`;
  const from = Math.max(0, at - 24);
  const show = (b: Buffer) => JSON.stringify(b.subarray(from, at + 24).toString('latin1'));
  return `first differs at byte ${at}\n  ours  : ${show(ours)}\n  loadp2: ${show(theirs)}`;
}

describe('loadp2 conformance', () => {
  for (const { name, size } of CASES) {
    for (const mode of ['ram', 'flash'] as const) {
      it(`matches loadp2 byte-for-byte: ${name} (${size} B), ${mode}`, async () => {
        const rom = new CapturingRom();
        await programTransport(rom, testImage(size), { mode });
        const ours = Buffer.from(rom.sent);
        const theirs = golden(name, mode);

        expect(ours.length, describeMismatch(ours, theirs)).toBe(theirs.length);
        expect(ours.equals(theirs), describeMismatch(ours, theirs)).toBe(true);
      });
    }
  }

  it('golden captures start with the ROM autobaud probe', () => {
    // Guards against a regenerated golden that silently lost its prefix.
    const head = golden('tiny4', 'ram').toString('latin1');
    expect(head.startsWith('> Prop_Chk 0 0 0 0  > Prop_Hex 0 0 0 0')).toBe(true);
  });

  it('RAM captures end with a checksum request, flash captures with ~', () => {
    const ram = golden('partial300', 'ram').toString('latin1');
    const flash = golden('partial300', 'flash').toString('latin1');
    expect(ram.endsWith('?')).toBe(true);
    expect(flash.endsWith('~')).toBe(true);
  });
});
