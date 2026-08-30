/**
 * Raw serial byte tail (worker side).
 *
 * The single highest-value artifact for protocol debugging is what was actually
 * on the wire: framing, CRC, baud and partial-frame bugs are all invisible in a
 * decoded event log but obvious in the bytes. This keeps a fixed-size circular
 * window of the most recent RX + TX traffic, plus per-chunk metadata so chunk
 * boundaries and inter-chunk timing survive instead of collapsing into a flat
 * byte soup (a frame split across two reads looks very different from one that
 * arrived whole, and that difference is usually the bug).
 *
 * `push()` sits directly in the ~100 Hz read path, so it is one `set()` memcpy
 * plus a handful of typed-array stores: no allocation, no GC pressure, and a
 * hard memory ceiling that never moves. All the expensive work (base64, object
 * construction) happens in `snapshot()`, which is only called at export time.
 *
 * Residency is tracked with ABSOLUTE byte offsets rather than ring indices.
 * That is what lets `snapshot()` tell "this chunk's bytes are still here" from
 * "these bytes were overwritten three wraps ago", and lets a chunk that was
 * only partially overwritten be reported clipped rather than silently corrupt.
 */

import { nowMs } from './log';

export type ByteDir = 'rx' | 'tx';

export interface ByteChunk {
  /** Wall-clock ms (same time base as LogEntry.t), so chunks interleave with the log. */
  at: number;
  dir: ByteDir;
  /** Bytes still resident for this chunk (≤ the length originally pushed). */
  len: number;
  /** Payload, base64 — 4/3 expansion vs hex's 2×, which matters before gzip. */
  b64: string;
  /** Present when the front of the chunk was overwritten: bytes lost. */
  clipped?: number;
}

export interface ByteRingSnapshot {
  /** Oldest → newest, resident chunks only. */
  chunks: ByteChunk[];
  /** Chunks pushed but no longer representable (metadata or bytes evicted). */
  droppedChunks: number;
  /** Lifetime totals, unaffected by eviction. */
  totalRxBytes: number;
  totalTxBytes: number;
  capacityBytes: number;
}

/** 64 KiB ≈ several seconds of 2 Mbaud traffic, or minutes of idle polling. */
export const BYTE_RING_CAPACITY = 64 * 1024;
/** Chunk-metadata slots. At ~100 Hz this is ~40 s of read/write boundaries. */
export const CHUNK_META_CAPACITY = 4096;

const DIR_RX = 0;
const DIR_TX = 1;

/** Base64 conversion is done in slices — `apply` on a 64 K array can blow the
 *  argument-count limit on some engines. */
const B64_SLICE = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_SLICE));
  }
  return btoa(binary);
}

export class ByteRing {
  private readonly buf: Uint8Array;

  /** Next write index into `buf`. */
  private head = 0;

  /** Total bytes ever written. Absolute offsets are relative to this. */
  private written = 0;

  // Chunk metadata as parallel typed arrays: a struct-of-arrays layout keeps
  // `push` allocation-free (an object per chunk at 100 Hz would not be).
  /** Absolute offset of each chunk's first byte. Float64 holds ints to 2^53. */
  private readonly metaAbs: Float64Array;

  private readonly metaLen: Int32Array;

  private readonly metaAt: Float64Array;

  private readonly metaDir: Uint8Array;

  private metaHead = 0;

  private metaCount = 0;

  private chunksPushed = 0;

  private rxBytes = 0;

  private txBytes = 0;

  constructor(
    readonly capacity: number = BYTE_RING_CAPACITY,
    readonly metaCapacity: number = CHUNK_META_CAPACITY,
  ) {
    this.buf = new Uint8Array(capacity);
    this.metaAbs = new Float64Array(metaCapacity);
    this.metaLen = new Int32Array(metaCapacity);
    this.metaAt = new Float64Array(metaCapacity);
    this.metaDir = new Uint8Array(metaCapacity);
  }

  /**
   * Record a chunk of traffic. Hot path — keep it boring.
   *
   * The non-wrapping case (overwhelmingly the common one) is a single
   * `Uint8Array.set`. Wrapping costs two `set`s and the two `subarray` views
   * they need; that happens once per full lap of the ring, not per chunk.
   */
  push(dir: ByteDir, bytes: Uint8Array): void {
    const n = bytes.length;
    if (n === 0) return;

    this.chunksPushed += 1;
    if (dir === 'rx') this.rxBytes += n;
    else this.txBytes += n;

    // A chunk bigger than the whole ring can only be represented by its tail.
    const src = n > this.capacity ? bytes.subarray(n - this.capacity) : bytes;
    const len = src.length;
    const start = this.head;
    const firstRun = this.capacity - start;

    if (len <= firstRun) {
      this.buf.set(src, start);
    } else {
      this.buf.set(src.subarray(0, firstRun), start);
      this.buf.set(src.subarray(firstRun), 0);
    }

    const i = this.metaHead;
    this.metaAbs[i] = this.written;
    this.metaLen[i] = len;
    this.metaAt[i] = nowMs();
    this.metaDir[i] = dir === 'rx' ? DIR_RX : DIR_TX;
    this.metaHead = (i + 1) % this.metaCapacity;
    if (this.metaCount < this.metaCapacity) this.metaCount += 1;

    this.head = (start + len) % this.capacity;
    this.written += len;
  }

  /**
   * Walk the metadata oldest → newest and materialise the resident window.
   * Allocates freely — only called when building a diagnostics bundle.
   */
  snapshot(): ByteRingSnapshot {
    const chunks: ByteChunk[] = [];
    // Bytes below this absolute offset have been overwritten by later writes.
    const oldestResident = Math.max(0, this.written - this.capacity);
    const first = (this.metaHead - this.metaCount + this.metaCapacity) % this.metaCapacity;

    for (let k = 0; k < this.metaCount; k++) {
      const i = (first + k) % this.metaCapacity;
      const abs = this.metaAbs[i];
      const len = this.metaLen[i];
      const end = abs + len;
      if (end <= oldestResident) continue; // fully overwritten

      const from = Math.max(abs, oldestResident);
      const residentLen = end - from;
      const chunk: ByteChunk = {
        at: this.metaAt[i],
        dir: this.metaDir[i] === DIR_RX ? 'rx' : 'tx',
        len: residentLen,
        b64: toBase64(this.read(from, residentLen)),
      };
      if (from > abs) chunk.clipped = from - abs;
      chunks.push(chunk);
    }

    return {
      chunks,
      droppedChunks: this.chunksPushed - chunks.length,
      totalRxBytes: this.rxBytes,
      totalTxBytes: this.txBytes,
      capacityBytes: this.capacity,
    };
  }

  /** Copy `len` bytes starting at absolute offset `from`, un-wrapping as needed. */
  private read(from: number, len: number): Uint8Array {
    const start = from % this.capacity;
    const firstRun = this.capacity - start;
    if (len <= firstRun) return this.buf.subarray(start, start + len);
    const out = new Uint8Array(len);
    out.set(this.buf.subarray(start, this.capacity), 0);
    out.set(this.buf.subarray(0, len - firstRun), firstRun);
    return out;
  }

  /**
   * Hex of the most recent `n` resident bytes, oldest → newest.
   *
   * For attaching to a decode failure: when the protocol core rejects a frame,
   * the bytes that caused it are the whole story, and by export time they may
   * be long gone. Small and bounded, so it is safe to inline in a log entry —
   * unlike `snapshot()`, which materialises the entire window.
   */
  tailHex(n = 64): string {
    const len = Math.min(n, this.written, this.capacity);
    if (len <= 0) return '';
    const bytes = this.read(this.written - len, len);
    let out = '';
    for (let i = 0; i < len; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
      if (i + 1 < len) out += ' ';
    }
    return out;
  }

  /** Cheap counters for the bundle header — no allocation of payload data. */
  stats(): {
    chunksPushed: number;
    chunksResident: number;
    rxBytes: number;
    txBytes: number;
    bytesResident: number;
  } {
    return {
      chunksPushed: this.chunksPushed,
      chunksResident: this.metaCount,
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      bytesResident: Math.min(this.written, this.capacity),
    };
  }

  /**
   * Total heap held by this ring. Fixed at construction and asserted in tests —
   * the whole point of the preallocated design is that it cannot creep.
   */
  footprintBytes(): number {
    return (
      this.buf.byteLength +
      this.metaAbs.byteLength +
      this.metaLen.byteLength +
      this.metaAt.byteLength +
      this.metaDir.byteLength
    );
  }

  reset(): void {
    this.head = 0;
    this.written = 0;
    this.metaHead = 0;
    this.metaCount = 0;
    this.chunksPushed = 0;
    this.rxBytes = 0;
    this.txBytes = 0;
    // The backing arrays are intentionally NOT reallocated or zeroed: stale
    // bytes are unreachable (nothing references them) and zeroing 64 KB is
    // pointless work.
  }
}

/**
 * The worker's ring. Hook points are two lines in DeviceSession.worker.ts:
 * `byteRing.push('rx', value)` beside the `bytesIn` counter and
 * `byteRing.push('tx', out)` beside `bytesOut`.
 */
export const byteRing = new ByteRing();
