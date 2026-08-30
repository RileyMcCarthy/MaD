/**
 * Host side of the Parallax Propeller 2 boot-ROM serial loader.
 *
 * This is a TypeScript port of `loadp2`'s single-stage path (`-SINGLE`), which
 * talks directly to the P2 boot ROM rather than first uploading loadp2's
 * `MainLoader` blob and switching to its faster binary protocol. Single-stage
 * costs ~3 bytes on the wire per image byte (the ROM takes ASCII hex), which at
 * 2 Mbaud is a few seconds for a full image — an easy trade for not having to
 * port MainLoader and its flow control.
 *
 * Everything here is transport-agnostic on purpose: the browser drives it over
 * Web Serial, and `tools/hw-p2load.mjs` drives the exact same code over Node's
 * `serialport` so the protocol can be validated headlessly against real
 * hardware. Keep this file free of DOM and Node APIs.
 *
 * Reference: loadp2.c `checkp2_and_init()` / `loadfilesingle()`, osint_linux.c
 * `hwreset()` — https://github.com/totalspectrum/loadp2
 */

/** Bytes the ROM expects to see to enter its download loop. */
const CHK_COMMAND = '> Prop_Chk 0 0 0 0  ';
const HEX_COMMAND = '> Prop_Hex 0 0 0 0';
/** loadp2 hands the ROM 128 bytes per line, then a " > " continuation marker. */
const CHUNK_BYTES = 128;
/** "Prop" as a little-endian long; the ROM's checksum lands on this constant. */
const CHECKSUM_MAGIC = 0x706f7250;

export interface P2Transport {
  /** Write raw bytes; resolves once handed to the OS (not necessarily drained). */
  write(data: Uint8Array): Promise<void>;
  /**
   * Read up to `maxBytes`, returning early on timeout with whatever arrived.
   * Must never reject on timeout — return a short (possibly empty) array.
   */
  read(maxBytes: number, timeoutMs: number): Promise<Uint8Array>;
  /** Drive the DTR control line. On MaD hardware this is wired to P2 RESn. */
  setDtr(asserted: boolean): Promise<void>;
  /** Discard buffered input. */
  flushInput(): Promise<void>;
  /** Block until the transmit buffer has actually gone out on the wire. */
  drain(): Promise<void>;
}

/**
 * Progress/diagnostic events emitted during a load.
 *
 * A callback rather than a logger import: this module is deliberately
 * dependency-free so `tools/hw-p2load.mts` can drive the identical protocol
 * headlessly. The caller decides what (if anything) to do with these.
 */
export type LoaderEvent =
  | { kind: 'reset' }
  | { kind: 'detect-attempt'; attempt: number; retries: number }
  | { kind: 'detect-reply'; attempt: number; bytes: number; text: string }
  | { kind: 'detected'; version: string; attempt: number }
  | { kind: 'upload-begin'; bytes: number; chunks: number; verifyChecksum: boolean }
  | { kind: 'upload-progress'; sent: number; total: number }
  | { kind: 'verify'; ok: boolean; reply: string };

export type LoaderEventSink = (event: LoaderEvent) => void;

export class P2LoaderError extends Error {
  constructor(
    message: string,
    /** Machine-readable tag so the UI can offer a targeted remedy. */
    readonly code: 'no-response' | 'rejected' | 'unsupported-chip',
  ) {
    super(message);
    this.name = 'P2LoaderError';
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/**
 * Pulse the P2 reset line: assert / release / assert with 2 ms settle, matching
 * loadp2's `hwreset()`. Adapters differ in how DTR reaches RESn — a Prop Plug
 * AC-couples it (edge-triggered pulse) while a bare FTDI breakout drives it as
 * a level — and this sequence produces a reset either way.
 */
export async function hardwareReset(t: P2Transport): Promise<void> {
  await t.setDtr(true);
  await delay(2);
  await t.setDtr(false);
  await delay(2);
  await t.setDtr(true);
  await delay(2);
  await t.flushInput();
}

/**
 * Reset the chip and wait for the ROM to answer the autobaud probe.
 *
 * The leading "> " in {@link CHK_COMMAND} is the ROM's autobaud pattern, so the
 * transport's baud rate is what the ROM locks onto — open the port at the rate
 * you intend to download at (2 Mbaud is loadp2's default and what MaD uses).
 *
 * @returns the single-character ROM version ('G' on shipping silicon).
 */
export async function detectP2(
  t: P2Transport,
  retries = 5,
  onEvent?: LoaderEventSink,
): Promise<string> {
  onEvent?.({ kind: 'reset' });
  await hardwareReset(t);
  await delay(20); // let the ROM come up before probing

  for (let i = 0; i < retries; i++) {
    onEvent?.({ kind: 'detect-attempt', attempt: i + 1, retries });
    await t.flushInput();
    await t.write(ascii(CHK_COMMAND));
    await t.drain();
    const reply = await t.read(20, 200);
    const text = new TextDecoder('latin1').decode(reply);
    // What the ROM actually said is the whole diagnosis when it says the wrong
    // thing — silence means wiring, garbage means baud or a busy port.
    onEvent?.({ kind: 'detect-reply', attempt: i + 1, bytes: reply.length, text });
    const m = /^\r\nProp_Ver (.)/.exec(text);
    if (m) {
      const version = m[1];
      onEvent?.({ kind: 'detected', version, attempt: i + 1 });
      // 'B' is the old FPGA image; it speaks a different load protocol.
      if (version === 'B') {
        throw new P2LoaderError(
          'Detected a Propeller 2 FPGA image, which this loader does not support.',
          'unsupported-chip',
        );
      }
      return version;
    }
  }
  throw new P2LoaderError(
    'No response from the Propeller 2 boot ROM. Check that the adapter wires DTR to the ' +
      'reset pin (header J1 pin 3) and that nothing else has the port open.',
    'no-response',
  );
}

/** Sum of the image as little-endian 32-bit words, truncated to 32 bits. */
function sumLongs(image: Uint8Array): number {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  let sum = 0;
  for (let off = 0; off < image.byteLength; off += 4) {
    sum = (sum + view.getUint32(off, true)) >>> 0;
  }
  return sum >>> 0;
}

/** Lowercase " xx" per byte — the ROM's expected hex framing. */
function toHexLine(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += ' ' + b.toString(16).padStart(2, '0');
  return s;
}

export interface LoadOptions {
  /**
   * Ask the ROM to verify a running checksum at the end (loadp2 sends "?" and
   * expects "."). loadp2 disables this when the payload is a flash loader,
   * whose own header checksum the calculation would disturb.
   */
  verifyChecksum?: boolean;
  /** Called with bytes-sent / total so the UI can show progress. */
  onProgress?: (sent: number, total: number) => void;
  /** Diagnostic events for the session log; see {@link LoaderEvent}. */
  onEvent?: LoaderEventSink;
  signal?: AbortSignal;
}

/**
 * Stream `image` into hub RAM at address 0 and let the ROM start it.
 *
 * The caller is responsible for having already called {@link detectP2} — the
 * ROM is only listening for this command immediately after the autobaud probe.
 */
export async function loadImage(
  t: P2Transport,
  image: Uint8Array,
  { verifyChecksum = true, onProgress, onEvent, signal }: LoadOptions = {},
): Promise<void> {
  if (image.byteLength % 4 !== 0) {
    throw new P2LoaderError('Image length must be a multiple of 4 bytes.', 'rejected');
  }

  onEvent?.({
    kind: 'upload-begin',
    bytes: image.byteLength,
    chunks: Math.ceil(image.byteLength / CHUNK_BYTES),
    verifyChecksum,
  });
  await t.write(ascii(HEX_COMMAND));

  let checksum = 0;
  for (let off = 0; off < image.byteLength; off += CHUNK_BYTES) {
    signal?.throwIfAborted();
    const chunk = image.subarray(off, Math.min(off + CHUNK_BYTES, image.byteLength));
    if (verifyChecksum) checksum = (checksum + sumLongs(chunk)) >>> 0;
    await t.write(ascii(toHexLine(chunk) + ' > '));
    onProgress?.(off + chunk.byteLength, image.byteLength);
    onEvent?.({ kind: 'upload-progress', sent: off + chunk.byteLength, total: image.byteLength });
  }

  if (!verifyChecksum) {
    await t.write(ascii('~')); // plain end-of-download
    await t.drain();
    return;
  }

  // The ROM accumulates the same sum; sending its complement makes the total
  // land on CHECKSUM_MAGIC, which is what "?" asks it to confirm.
  const final = (CHECKSUM_MAGIC - checksum) >>> 0;
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, final, true);
  await t.write(ascii(toHexLine(tail)));
  await t.write(ascii('?'));
  await t.drain();

  const reply = new TextDecoder('latin1').decode(await t.read(1, 300));
  onEvent?.({ kind: 'verify', ok: reply === '.', reply });
  if (reply !== '.') {
    throw new P2LoaderError(
      `The Propeller 2 rejected the image (expected ".", got ${JSON.stringify(reply)}). ` +
        'This usually means bytes were dropped in transit.',
      'rejected',
    );
  }
}
