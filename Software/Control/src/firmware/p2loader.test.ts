import { describe, it, expect } from 'vitest';
import { detectP2, loadImage, hardwareReset, P2LoaderError, type P2Transport } from './p2loader';
import { buildFlashImage, buildRamImage, estimateSeconds, flashLoaderStub } from './image';
import { programTransport } from './program';

/**
 * A stand-in for the P2 boot ROM that independently re-derives what the host
 * sent. It decodes the ASCII-hex stream back into bytes and accumulates the
 * same long-sum the real ROM does, so a passing round-trip means the framing
 * and checksum arithmetic agree with something other than themselves.
 */
class FakeRom implements P2Transport {
  dtrTransitions: boolean[] = [];
  /** Bytes the ROM reconstructed from the hex stream (image only, no checksum). */
  received: number[] = [];
  romVersion = 'G';
  /** Set to drop the Nth image byte, simulating a lossy link. */
  corruptAtByte: number | null = null;

  private outbox: number[] = [];
  private text = '';
  private inHexMode = false;
  private sum = 0;
  private longBuf: number[] = [];

  constructor(private readonly opts: { respondToChk?: boolean } = {}) {}

  async setDtr(asserted: boolean): Promise<void> {
    this.dtrTransitions.push(asserted);
  }

  async flushInput(): Promise<void> {
    this.outbox = [];
  }

  async drain(): Promise<void> {}

  async read(maxBytes: number, _timeoutMs: number): Promise<Uint8Array> {
    return Uint8Array.from(this.outbox.splice(0, maxBytes));
  }

  async write(data: Uint8Array): Promise<void> {
    this.text += String.fromCharCode(...data);

    if (!this.inHexMode) {
      if (this.text.includes('> Prop_Chk 0 0 0 0  ')) {
        this.text = '';
        if (this.opts.respondToChk !== false) {
          this.push(`\r\nProp_Ver ${this.romVersion}`);
        }
        return;
      }
      const hexAt = this.text.indexOf('> Prop_Hex 0 0 0 0');
      if (hexAt >= 0) {
        this.inHexMode = true;
        this.text = this.text.slice(hexAt + '> Prop_Hex 0 0 0 0'.length);
      } else {
        return;
      }
    }

    // Consume complete hex tokens; '>' is a continuation marker, '?' asks us to
    // confirm the checksum, '~' just ends the download.
    for (const tok of this.text.split(/\s+/)) {
      if (tok === '') continue;
      if (tok === '>') continue;
      if (tok === '~') {
        this.inHexMode = false;
        continue;
      }
      if (tok.startsWith('?')) {
        this.push(this.sum >>> 0 === 0x706f7250 ? '.' : '!');
        this.inHexMode = false;
        continue;
      }
      if (!/^[0-9a-f]{2}$/.test(tok)) throw new Error(`bad hex token ${JSON.stringify(tok)}`);
      const byte = parseInt(tok, 16);
      this.longBuf.push(byte);
      if (this.longBuf.length === 4) {
        const long =
          (this.longBuf[0] |
            (this.longBuf[1] << 8) |
            (this.longBuf[2] << 16) |
            (this.longBuf[3] << 24)) >>>
          0;
        this.sum = (this.sum + long) >>> 0;
        this.received.push(...this.longBuf);
        this.longBuf = [];
      }
    }
    this.text = '';
    if (this.corruptAtByte !== null && this.received.length > this.corruptAtByte) {
      this.sum = (this.sum + 1) >>> 0; // pretend a bit flipped in transit
      this.corruptAtByte = null;
    }
  }

  private push(s: string) {
    for (const c of s) this.outbox.push(c.charCodeAt(0));
  }

  /** The image the ROM believes it received, minus the trailing checksum long. */
  imageWithoutChecksum(sentBytes: number): Uint8Array {
    return Uint8Array.from(this.received.slice(0, sentBytes));
  }
}

describe('hardwareReset', () => {
  it('pulses DTR assert/release/assert like loadp2 hwreset()', async () => {
    const rom = new FakeRom();
    await hardwareReset(rom);
    expect(rom.dtrTransitions).toEqual([true, false, true]);
  });
});

describe('detectP2', () => {
  it('returns the ROM version character', async () => {
    const rom = new FakeRom();
    expect(await detectP2(rom)).toBe('G');
  });

  it('throws a no-response error when the ROM stays silent', async () => {
    const rom = new FakeRom({ respondToChk: false });
    await expect(detectP2(rom, 2)).rejects.toMatchObject({
      name: 'P2LoaderError',
      code: 'no-response',
    });
  });

  it('rejects the FPGA image, which speaks a different protocol', async () => {
    const rom = new FakeRom();
    rom.romVersion = 'B';
    await expect(detectP2(rom)).rejects.toMatchObject({ code: 'unsupported-chip' });
  });
});

describe('loadImage', () => {
  it('round-trips an image through the hex framing byte-for-byte', async () => {
    const rom = new FakeRom();
    // Deliberately spans several 128-byte chunks and is not chunk-aligned.
    const image = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    await detectP2(rom);
    await loadImage(rom, image);
    expect(rom.imageWithoutChecksum(image.byteLength)).toEqual(image);
  });

  it('sends a complement that makes the ROM checksum land on the magic value', async () => {
    const rom = new FakeRom();
    const image = Uint8Array.from({ length: 128 }, (_, i) => i);
    await detectP2(rom);
    await expect(loadImage(rom, image)).resolves.toBeUndefined();
  });

  it('surfaces a rejection when bytes are lost in transit', async () => {
    const rom = new FakeRom();
    rom.corruptAtByte = 64;
    const image = Uint8Array.from({ length: 256 }, (_, i) => i);
    await detectP2(rom);
    await expect(loadImage(rom, image)).rejects.toMatchObject({ code: 'rejected' });
  });

  it('ends with ~ and no verification when the checksum is disabled', async () => {
    const rom = new FakeRom();
    const image = Uint8Array.from({ length: 64 }, (_, i) => i);
    await detectP2(rom);
    await loadImage(rom, image, { verifyChecksum: false });
    expect(rom.imageWithoutChecksum(image.byteLength)).toEqual(image);
  });

  it('reports monotonic progress ending at the image size', async () => {
    const rom = new FakeRom();
    const image = new Uint8Array(300);
    const seen: number[] = [];
    await detectP2(rom);
    await loadImage(rom, image, { onProgress: (sent) => seen.push(sent) });
    expect(seen[seen.length - 1]).toBe(300);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('refuses an image that is not a whole number of longs', async () => {
    const rom = new FakeRom();
    await expect(loadImage(rom, new Uint8Array(7))).rejects.toBeInstanceOf(P2LoaderError);
  });

  it('honours an abort signal mid-upload', async () => {
    const rom = new FakeRom();
    const ctrl = new AbortController();
    await detectP2(rom);
    const p = loadImage(rom, new Uint8Array(4096), {
      onProgress: (sent) => {
        if (sent >= 256) ctrl.abort();
      },
      signal: ctrl.signal,
    });
    await expect(p).rejects.toThrow();
  });
});

describe('image assembly', () => {
  it('pads a RAM image up to a long boundary', () => {
    expect(buildRamImage(new Uint8Array(6)).byteLength).toBe(8);
    expect(buildRamImage(new Uint8Array(8)).byteLength).toBe(8);
  });

  it('rejects an empty firmware file', () => {
    expect(() => buildRamImage(new Uint8Array(0))).toThrow(/empty/i);
    expect(() => buildFlashImage(new Uint8Array(0))).toThrow(/empty/i);
  });

  it('vendors the 496-byte loadp2 flash stub', () => {
    expect(flashLoaderStub().byteLength).toBe(496);
  });

  it('prepends the stub and preserves the payload', () => {
    const fw = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
    const img = buildFlashImage(fw);
    expect(img.byteLength).toBe(496 + 64);
    expect(img.slice(496)).toEqual(fw);
  });

  it('patches a header checksum that makes the image sum to zero', () => {
    const fw = Uint8Array.from({ length: 200 }, (_, i) => (i * 13) & 0xff);
    const img = buildFlashImage(fw);
    const view = new DataView(img.buffer, img.byteOffset, img.byteLength);
    let sum = 0;
    for (let off = 0; off < img.byteLength; off += 4) {
      sum = (sum + view.getUint32(off, true)) >>> 0;
    }
    expect(sum).toBe(0);
    // The DEBUG flag long must be cleared, per loadp2's patchBinaryFileForFlash.
    expect(view.getUint32(8, true)).toBe(0);
  });
});

describe('estimateSeconds', () => {
  it('scales with the 3x hex expansion at 8N1', () => {
    // 100 KiB image ≈ 300 KB on the wire ≈ 3 Mbit ≈ 1.5 s at 2 Mbaud.
    const s = estimateSeconds(100 * 1024, 2_000_000);
    expect(s).toBeGreaterThan(1.4);
    expect(s).toBeLessThan(1.8);
  });
});

describe('programTransport', () => {
  it('drives reset → upload → done for a RAM load', async () => {
    const rom = new FakeRom();
    const phases: string[] = [];
    const fw = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
    const result = await programTransport(rom, fw, {
      mode: 'ram',
      onProgress: (p) => phases.push(p.phase),
    });
    expect(result.romVersion).toBe('G');
    expect(result.imageBytes).toBe(512);
    expect(phases[0]).toBe('resetting');
    expect(phases[phases.length - 1]).toBe('done');
    expect(rom.imageWithoutChecksum(512)).toEqual(fw);
  });

  it('sends the stub ahead of the payload in flash mode', async () => {
    const rom = new FakeRom();
    const fw = Uint8Array.from({ length: 256 }, (_, i) => (i * 3) & 0xff);
    const result = await programTransport(rom, fw, { mode: 'flash' });
    expect(result.imageBytes).toBe(496 + 256);
    expect(rom.imageWithoutChecksum(496 + 256).slice(496)).toEqual(fw);
  });
});
