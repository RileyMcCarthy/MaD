/**
 * Assembly of the hub-RAM image the P2 boot ROM downloads.
 *
 * Two shapes, matching the two things a user wants to do:
 *  - RAM: run this firmware right now, lose it on the next power cycle.
 *  - Flash: prepend loadp2's flash-boot stub, which copies the image that
 *    follows it into SPI flash and reboots into it.
 *
 * Pure functions over byte arrays — no I/O, so the interesting arithmetic is
 * unit-testable without hardware.
 */

/**
 * loadp2's `flash_loader.bin` (496 bytes), base64-encoded.
 *
 * This is the stub the boot ROM runs out of hub RAM; it programs the SPI flash
 * with whatever follows it and then reboots. Vendored rather than fetched so
 * the PWA stays offline-capable. Source of truth:
 * https://github.com/totalspectrum/loadp2 `flash_loader.h` (MIT).
 */
const FLASH_LOADER_BASE64 =
  'MQJk/QAAAAAA+Az8NABg/Sj+Zf0AAGj8AgBE8AAAfPwABNj8EgJg/QHwCPGcAZBd4AHA/nwAhPEA' +
  'BAD2YQFk/GEBZPzwAXz8AATY/BICYP0B8oDxYfNk/GABfPwABdz8EgJg/QH0gPFh9WT8JAAE8T8A' +
  'BPEGAETwBAAE81l6ZP1QeGT9PJQM/DwCHPxYeGT9WHZk/R3sYP1gAXz8QAAc8iBWtOkParzpFwxM' +
  '+xuwTfuEALD9FAxM+xgETPv2r6D8PKgk/CQ2YP1sALD9BABk+wHwBPH/8Mz32P+fXbz/n/08AAz8' +
  '8PEH9gDyB/YJBETwKf5n/WEBBPsp/mf94QFk/PsFfPsAAOz8WXpk/Vh6ZP32q6D8PCAs/CQ2YA14' +
  '7Cv5bOz/+Vl6ZP1YemT99q2g/DyALPwkNmAN8wtM+zwgLPwfJmT9QHR0/ez/n80tAGT9ABAAAAgA' +
  '90AgAPdAAAj3gCi2Zf0ASGT83ECc8QAA7Ow8lAz8UHhk/TwCHPxYeGT9HTxg/QEAAP9wAYz8CkbM' +
  '+SBGIPMjQIDxBUZk8CM+IPkBRmTwPEYk/B8GZP0APqT8JDZg/fVBnPs8AAz8AAB8/CEE2PwSRmD9' +
  'I0QI8VB2ZV0ABGRdAADs/AAAAEAAAPXAAAAAAAAAAAAAAAAAsI2Qjw==';

/** Offset (in longs) of the flash stub's checksum slot. */
const CHECKSUM_LONG = 1;
/** Offset (in longs) of the stub's DEBUG flag, which must be cleared. */
const DEBUG_FLAG_LONG = 2;

let cachedLoader: Uint8Array | null = null;

/** The flash-boot stub as raw bytes. */
export function flashLoaderStub(): Uint8Array {
  if (!cachedLoader) {
    const bin = atob(FLASH_LOADER_BASE64);
    cachedLoader = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  return cachedLoader;
}

/** Pad to a whole number of longs; the ROM downloads in 32-bit units. */
function padToLong(data: Uint8Array): Uint8Array {
  const size = (data.byteLength + 3) & ~3;
  if (size === data.byteLength) return data;
  const out = new Uint8Array(size);
  out.set(data);
  return out;
}

/** Image that the ROM will load into hub RAM and run directly. */
export function buildRamImage(firmware: Uint8Array): Uint8Array {
  if (firmware.byteLength === 0) throw new Error('Firmware image is empty.');
  return padToLong(firmware);
}

/**
 * Image that flashes `firmware` to SPI flash: the stub, then the payload,
 * with the stub's header patched so the P2 boot ROM will accept the result as
 * bootable (the ROM requires the loaded longs to sum to zero).
 *
 * Mirrors loadp2's `patchBinaryFileForFlash()`: clear the DEBUG flag first so
 * it's covered by the sum, then store the two's complement of the total.
 */
export function buildFlashImage(firmware: Uint8Array): Uint8Array {
  if (firmware.byteLength === 0) throw new Error('Firmware image is empty.');
  const stub = flashLoaderStub();
  const image = padToLong(
    (() => {
      const joined = new Uint8Array(stub.byteLength + firmware.byteLength);
      joined.set(stub, 0);
      joined.set(firmware, stub.byteLength);
      return joined;
    })(),
  );

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  view.setUint32(DEBUG_FLAG_LONG * 4, 0, true);
  view.setUint32(CHECKSUM_LONG * 4, 0, true);

  let sum = 0;
  for (let off = 0; off < image.byteLength; off += 4) {
    sum = (sum + view.getUint32(off, true)) >>> 0;
  }
  view.setUint32(CHECKSUM_LONG * 4, (-sum >>> 0) >>> 0, true);
  return image;
}

/**
 * Seconds the download will roughly take. The ROM is fed ASCII hex — three
 * bytes on the wire per image byte, plus ~3 bytes of framing per 128 — over an
 * 8N1 link, so ten bits per wire byte.
 */
export function estimateSeconds(imageBytes: number, baudRate: number): number {
  const framing = Math.ceil(imageBytes / 128) * 3;
  return ((imageBytes * 3 + framing) * 10) / baudRate;
}
