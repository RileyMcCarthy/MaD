import { describe, it, expect } from 'vitest';
import { ByteRing, BYTE_RING_CAPACITY, CHUNK_META_CAPACITY } from './byteRing';

/** Decode a snapshot chunk's base64 payload back to bytes. */
function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Concatenate every resident chunk, oldest → newest. */
function residentBytes(ring: ByteRing): Uint8Array {
  const chunks = ring.snapshot().chunks.map((c) => decode(c.b64));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const seq = (from: number, len: number) =>
  Uint8Array.from({ length: len }, (_, i) => (from + i) & 0xff);

describe('ByteRing — basic capture', () => {
  it('round-trips a single chunk', () => {
    const ring = new ByteRing(256, 16);
    ring.push('rx', Uint8Array.of(1, 2, 3, 4));

    const snap = ring.snapshot();
    expect(snap.chunks).toHaveLength(1);
    expect(snap.chunks[0].dir).toBe('rx');
    expect(snap.chunks[0].len).toBe(4);
    expect(decode(snap.chunks[0].b64)).toEqual(Uint8Array.of(1, 2, 3, 4));
  });

  it('preserves chunk boundaries and direction rather than flattening', () => {
    const ring = new ByteRing(256, 16);
    ring.push('tx', Uint8Array.of(0xaa, 0xbb));
    ring.push('rx', Uint8Array.of(0xcc));
    ring.push('tx', Uint8Array.of(0xdd, 0xee, 0xff));

    const snap = ring.snapshot();
    expect(snap.chunks.map((c) => c.dir)).toEqual(['tx', 'rx', 'tx']);
    expect(snap.chunks.map((c) => c.len)).toEqual([2, 1, 3]);
  });

  it('ignores empty pushes', () => {
    const ring = new ByteRing(256, 16);
    ring.push('rx', new Uint8Array(0));
    expect(ring.snapshot().chunks).toHaveLength(0);
    expect(ring.stats().chunksPushed).toBe(0);
  });

  it('tracks lifetime byte totals per direction', () => {
    const ring = new ByteRing(256, 16);
    ring.push('rx', seq(0, 10));
    ring.push('tx', seq(0, 4));
    ring.push('rx', seq(0, 6));

    const snap = ring.snapshot();
    expect(snap.totalRxBytes).toBe(16);
    expect(snap.totalTxBytes).toBe(4);
  });
});

describe('ByteRing — wrap correctness', () => {
  it('reconstructs the true byte sequence after wrapping the buffer', () => {
    // Capacity 16, write 24 bytes in 3 chunks: the first 8 fall off the back.
    const ring = new ByteRing(16, 16);
    ring.push('rx', seq(0, 8));
    ring.push('rx', seq(8, 8));
    ring.push('rx', seq(16, 8));

    // Only the last 16 bytes (values 8..23) are still resident.
    expect(residentBytes(ring)).toEqual(seq(8, 16));
  });

  it('un-wraps a single chunk that straddles the physical end of the buffer', () => {
    const ring = new ByteRing(16, 16);
    ring.push('rx', seq(0, 12)); // head → 12
    ring.push('rx', seq(100, 8)); // writes 4 bytes at 12..15, wraps 4 to 0..3

    const snap = ring.snapshot();
    const last = snap.chunks[snap.chunks.length - 1];
    // The straddling chunk must come back contiguous and in the right order.
    expect(decode(last.b64)).toEqual(seq(100, 8));
  });

  it('reports a partially overwritten chunk as clipped, not corrupt', () => {
    const ring = new ByteRing(16, 16);
    ring.push('rx', seq(0, 10));
    ring.push('rx', seq(50, 10)); // overwrites the first 4 bytes of chunk 1

    const snap = ring.snapshot();
    expect(snap.chunks).toHaveLength(2);
    // Chunk 1 lost its first 4 bytes; what remains is its tail, correctly placed.
    expect(snap.chunks[0].clipped).toBe(4);
    expect(snap.chunks[0].len).toBe(6);
    expect(decode(snap.chunks[0].b64)).toEqual(seq(4, 6));
    // Chunk 2 is intact and unclipped.
    expect(snap.chunks[1].clipped).toBeUndefined();
    expect(decode(snap.chunks[1].b64)).toEqual(seq(50, 10));
  });

  it('drops fully overwritten chunks from the snapshot', () => {
    const ring = new ByteRing(16, 32);
    ring.push('rx', seq(0, 8));
    ring.push('rx', seq(20, 8));
    ring.push('rx', seq(40, 8));
    ring.push('rx', seq(60, 8));

    const snap = ring.snapshot();
    // Capacity 16 holds only the last two chunks; the first two are gone.
    expect(snap.chunks).toHaveLength(2);
    expect(snap.droppedChunks).toBe(2);
    expect(residentBytes(ring)).toEqual(
      Uint8Array.of(...seq(40, 8), ...seq(60, 8)),
    );
  });

  it('keeps only the tail of a chunk larger than the whole ring', () => {
    const ring = new ByteRing(8, 16);
    ring.push('rx', seq(0, 20));

    const snap = ring.snapshot();
    expect(snap.chunks).toHaveLength(1);
    expect(snap.chunks[0].len).toBe(8);
    // The most recent 8 bytes are the ones worth keeping.
    expect(decode(snap.chunks[0].b64)).toEqual(seq(12, 8));
    expect(snap.totalRxBytes).toBe(20);
  });
});

describe('ByteRing — metadata eviction', () => {
  it('evicts oldest chunk metadata once the slot ring is full', () => {
    // Plenty of byte capacity, deliberately few metadata slots.
    const ring = new ByteRing(4096, 4);
    for (let i = 0; i < 10; i++) ring.push('rx', Uint8Array.of(i));

    const snap = ring.snapshot();
    expect(snap.chunks).toHaveLength(4);
    // The four most recent single-byte chunks survive.
    expect(snap.chunks.map((c) => decode(c.b64)[0])).toEqual([6, 7, 8, 9]);
    expect(snap.droppedChunks).toBe(6);
  });

  it('never reports bytes that metadata can no longer vouch for', () => {
    // The classic failure: metadata surviving longer than the bytes it points at.
    const ring = new ByteRing(8, 64);
    for (let i = 0; i < 40; i++) ring.push('rx', Uint8Array.of(i));

    const snap = ring.snapshot();
    const resident = residentBytes(ring);
    // Whatever survives must be exactly the last `capacity` bytes written.
    expect(resident).toEqual(Uint8Array.from({ length: 8 }, (_, i) => 32 + i));
    expect(snap.chunks.every((c) => c.len > 0)).toBe(true);
  });
});

describe('ByteRing — resource ceiling', () => {
  it('holds a fixed footprint that does not grow with traffic', () => {
    const ring = new ByteRing(1024, 32);
    const before = ring.footprintBytes();
    for (let i = 0; i < 5000; i++) ring.push(i % 2 ? 'tx' : 'rx', seq(i, 37));
    expect(ring.footprintBytes()).toBe(before);
  });

  it('sizes the default ring to its documented ceiling', () => {
    const ring = new ByteRing();
    // 64 KiB payload + 4096 slots × (8 abs + 4 len + 8 at + 1 dir) bytes.
    const expected = BYTE_RING_CAPACITY + CHUNK_META_CAPACITY * (8 + 4 + 8 + 1);
    expect(ring.footprintBytes()).toBe(expected);
  });

  it('reports resident bytes capped at capacity', () => {
    const ring = new ByteRing(64, 16);
    ring.push('rx', seq(0, 20));
    expect(ring.stats().bytesResident).toBe(20);
    ring.push('rx', seq(0, 100));
    expect(ring.stats().bytesResident).toBe(64);
  });
});

describe('ByteRing — reset', () => {
  it('clears residency and counters without reallocating', () => {
    const ring = new ByteRing(64, 16);
    const footprint = ring.footprintBytes();
    ring.push('rx', seq(0, 32));
    ring.reset();

    const snap = ring.snapshot();
    expect(snap.chunks).toHaveLength(0);
    expect(snap.droppedChunks).toBe(0);
    expect(snap.totalRxBytes).toBe(0);
    expect(ring.footprintBytes()).toBe(footprint);
  });

  it('captures cleanly after a reset', () => {
    const ring = new ByteRing(64, 16);
    ring.push('rx', seq(0, 32));
    ring.reset();
    ring.push('tx', Uint8Array.of(9, 9, 9));

    expect(residentBytes(ring)).toEqual(Uint8Array.of(9, 9, 9));
  });
});
