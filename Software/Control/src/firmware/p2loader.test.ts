import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
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
  behaviour(
    {
      id: 'flash.reset-pulses-assert-release-assert',
      covers: 'src/firmware/p2loader.ts#hardwareReset',
      given: 'a load that begins by resetting the Propeller 2',
      then: 'resetting the chip pulses DTR assert, then release, then assert',
      why: 'adapters couple DTR to the reset pin differently; this sequence resets both an edge-triggered Prop Plug and a level-driven adapter',
    },
    async () => {
      const rom = new FakeRom();
      await hardwareReset(rom);
      expect(rom.dtrTransitions).toEqual([true, false, true]);
    },
  );
});

describe('detectP2', () => {
  behaviour(
    {
      id: 'flash.detect-reports-rom-version',
      covers: 'src/firmware/p2loader.ts#detectP2',
      given: 'a shipping Propeller 2 answering the autobaud probe as version G',
      then: 'detecting a shipping Propeller 2 reports the boot ROM version letter the chip sent',
    },
    async () => {
      const rom = new FakeRom();
      expect(await detectP2(rom)).toBe('G');
    },
  );

  behaviour(
    {
      id: 'flash.detect-silent-is-no-response',
      covers: 'src/firmware/p2loader.ts#detectP2',
      given: 'a serial port whose chip never answers the autobaud probe',
      then: 'a serial port whose chip never answers the autobaud probe is reported as no response from the boot ROM',
      why: 'silence means the adapter is not wired to reset, or something else already holds the serial port',
    },
    async () => {
      const rom = new FakeRom({ respondToChk: false });
      await expect(detectP2(rom, 2)).rejects.toMatchObject({
        name: 'P2LoaderError',
        code: 'no-response',
      });
    },
  );

  behaviour(
    {
      id: 'flash.detect-fpga-is-unsupported',
      covers: 'src/firmware/p2loader.ts#detectP2',
      given: 'a Propeller 2 FPGA development image answering the autobaud probe',
      then: 'a Propeller 2 FPGA development image is refused as an unsupported chip',
      why: 'the FPGA image speaks a different load protocol',
    },
    async () => {
      const rom = new FakeRom();
      rom.romVersion = 'B';
      await expect(detectP2(rom)).rejects.toMatchObject({ code: 'unsupported-chip' });
    },
  );
});

describe('loadImage', () => {
  behaviour(
    {
      id: 'flash.load-delivers-every-image-byte',
      covers: 'src/firmware/p2loader.ts#loadImage',
      given: 'a 300-byte image that spans more than one download line and does not fill the last line',
      then: 'loading a 300-byte image delivers every byte of that image to the chip, in order',
    },
    async () => {
      const rom = new FakeRom();
      // Deliberately spans several 128-byte chunks and is not chunk-aligned.
      const image = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
      await detectP2(rom);
      await loadImage(rom, image);
      expect(rom.imageWithoutChecksum(image.byteLength)).toEqual(image);
    },
  );

  behaviour(
    {
      id: 'flash.load-checksum-accepted-by-rom',
      covers: 'src/firmware/p2loader.ts#loadImage',
      given: 'a 128-byte image loaded with checksum verification',
      then: 'loading an image with checksum verification is accepted by the boot ROM',
      why: 'the loader sends a complement so the ROM running sum lands on the value it expects',
    },
    async () => {
      const rom = new FakeRom();
      const image = Uint8Array.from({ length: 128 }, (_, i) => i);
      await detectP2(rom);
      await expect(loadImage(rom, image)).resolves.toBeUndefined();
    },
  );

  behaviour(
    {
      id: 'flash.load-dropped-bytes-rejected',
      covers: 'src/firmware/p2loader.ts#loadImage',
      given: 'a load during which some image bytes are lost on the serial port',
      then: 'a load that loses bytes in transit is rejected by the boot ROM',
      why: 'a truncated image accepted as good would leave the chip unbootable',
    },
    async () => {
      const rom = new FakeRom();
      rom.corruptAtByte = 64;
      const image = Uint8Array.from({ length: 256 }, (_, i) => i);
      await detectP2(rom);
      await expect(loadImage(rom, image)).rejects.toMatchObject({ code: 'rejected' });
    },
  );

  behaviour(
    {
      id: 'flash.load-without-checksum-delivers',
      covers: 'src/firmware/p2loader.ts#loadImage',
      given: 'a 64-byte image loaded with checksum verification turned off, as a flash load does',
      then: 'a load with checksum verification off delivers the image and ends the download',
      why: 'the flash-boot stub carries its own header checksum, which the ROM running-sum handshake would disturb',
    },
    async () => {
      const rom = new FakeRom();
      const image = Uint8Array.from({ length: 64 }, (_, i) => i);
      await detectP2(rom);
      await loadImage(rom, image, { verifyChecksum: false });
      expect(rom.imageWithoutChecksum(image.byteLength)).toEqual(image);
    },
  );

  behaviour(
    {
      id: 'flash.load-progress-finishes-at-image-size',
      covers: 'src/firmware/p2loader.ts#loadImage',
      given: 'a 300-byte image being loaded with progress reported',
      then: 'load progress reports a non-decreasing byte count that finishes at the image size',
    },
    async () => {
      const rom = new FakeRom();
      const image = new Uint8Array(300);
      const seen: number[] = [];
      await detectP2(rom);
      await loadImage(rom, image, { onProgress: (sent) => seen.push(sent) });
      expect(seen[seen.length - 1]).toBe(300);
      expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    },
  );

  behaviour(
    {
      id: 'flash.load-rejects-length-not-multiple-of-four',
      covers: 'src/firmware/p2loader.ts#loadImage',
      given: 'an image whose length is not a multiple of four bytes',
      then: 'loading an image whose length is not a multiple of four bytes is refused',
      why: 'the boot ROM downloads in 32-bit units',
    },
    async () => {
      const rom = new FakeRom();
      await expect(loadImage(rom, new Uint8Array(7))).rejects.toBeInstanceOf(P2LoaderError);
    },
  );

  behaviour(
    {
      id: 'flash.load-stops-when-cancelled',
      covers: 'src/firmware/p2loader.ts#loadImage',
      given: 'a load that is cancelled after the first 256 bytes have been sent',
      then: 'cancelling a load after the first 256 bytes have been sent stops the load',
    },
    async () => {
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
    },
  );
});

describe('image assembly', () => {
  behaviour(
    {
      id: 'flash.ram-image-padded-to-four-bytes',
      covers: 'src/firmware/image.ts#buildRamImage',
      given: 'a firmware file whose length is six bytes, and one whose length is already eight',
      then: 'a RAM image whose length is not a multiple of four bytes is padded up to the next multiple of four, and an already-aligned image is left at that length',
      why: 'the boot ROM downloads in 32-bit units',
    },
    () => {
      expect(buildRamImage(new Uint8Array(6)).byteLength).toBe(8);
      expect(buildRamImage(new Uint8Array(8)).byteLength).toBe(8);
    },
  );

  behaviour(
    {
      id: 'flash.empty-firmware-refused',
      covers: 'src/firmware/image.ts#buildRamImage',
      given: 'an empty firmware file',
      then: 'building a RAM image or a flash image from an empty file is refused',
    },
    () => {
      expect(() => buildRamImage(new Uint8Array(0))).toThrow(/empty/i);
      expect(() => buildFlashImage(new Uint8Array(0))).toThrow(/empty/i);
    },
  );

  behaviour(
    {
      id: 'flash.stub-is-496-bytes',
      covers: 'src/firmware/image.ts#flashLoaderStub',
      given: 'the flash-boot stub that is prepended for a flash load',
      then: 'the flash-boot stub is 496 bytes',
      why: 'the stub is vendored in the app so a flash load works with no network',
    },
    () => {
      expect(flashLoaderStub().byteLength).toBe(496);
    },
  );

  behaviour(
    {
      id: 'flash.flash-image-is-stub-then-firmware',
      covers: 'src/firmware/image.ts#buildFlashImage',
      given: 'a 64-byte firmware file built as a flash image',
      then: 'a flash image is the 496-byte flash-boot stub followed by the original firmware bytes',
    },
    () => {
      const fw = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
      const img = buildFlashImage(fw);
      expect(img.byteLength).toBe(496 + 64);
      expect(img.slice(496)).toEqual(fw);
    },
  );

  behaviour(
    {
      id: 'flash.flash-image-words-sum-to-zero',
      covers: 'src/firmware/image.ts#buildFlashImage',
      given: 'a firmware file built as a flash image',
      then: 'a flash image is patched so its 32-bit words sum to zero and the header debug flag is cleared',
      why: 'the boot ROM will only start an image whose loaded words sum to zero',
    },
    () => {
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
    },
  );
});

describe('estimateSeconds', () => {
  behaviour(
    {
      id: 'flash.estimate-accounts-for-hex-on-the-wire',
      covers: 'src/firmware/image.ts#estimateSeconds',
      given: 'a 100-kilobyte image loaded at two megabaud',
      then: 'a 100-kilobyte image at two megabaud is estimated to take about one and a half seconds',
      why: 'each image byte is sent as ASCII hex — three bytes on the wire — over an 8N1 link',
    },
    () => {
      // 100 KiB image ≈ 300 KB on the wire ≈ 3 Mbit ≈ 1.5 s at 2 Mbaud.
      const s = estimateSeconds(100 * 1024, 2_000_000);
      expect(s).toBeGreaterThan(1.4);
      expect(s).toBeLessThan(1.8);
    },
  );
});

describe('programTransport', () => {
  behaviour(
    {
      id: 'flash.ram-load-resets-then-finishes',
      covers: 'src/firmware/program.ts#programTransport',
      given: 'a 512-byte firmware file loaded into RAM',
      then: 'a RAM load reports the boot ROM version, delivers the firmware bytes, and its progress starts at resetting and ends at done',
    },
    async () => {
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
    },
  );

  behaviour(
    {
      id: 'flash.flash-load-sends-stub-then-firmware',
      covers: 'src/firmware/program.ts#programTransport',
      given: 'a 256-byte firmware file loaded to flash',
      then: 'a flash load sends the 496-byte flash-boot stub followed by the firmware bytes',
    },
    async () => {
      const rom = new FakeRom();
      const fw = Uint8Array.from({ length: 256 }, (_, i) => (i * 3) & 0xff);
      const result = await programTransport(rom, fw, { mode: 'flash' });
      expect(result.imageBytes).toBe(496 + 256);
      expect(rom.imageWithoutChecksum(496 + 256).slice(496)).toEqual(fw);
    },
  );
});
