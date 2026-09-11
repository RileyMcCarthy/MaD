import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
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
  behaviour(
    {
      id: 'diag.byte-ring-round-trips-chunk',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.snapshot',
      given: 'a received serial chunk of four bytes',
      then: 'the byte capture shows one received chunk with those four bytes intact',
    },
    () => {
      const ring = new ByteRing(256, 16);
      ring.push('rx', Uint8Array.of(1, 2, 3, 4));

      const snap = ring.snapshot();
      expect(snap.chunks).toHaveLength(1);
      expect(snap.chunks[0].dir).toBe('rx');
      expect(snap.chunks[0].len).toBe(4);
      expect(decode(snap.chunks[0].b64)).toEqual(Uint8Array.of(1, 2, 3, 4));
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-keeps-chunk-boundaries',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.snapshot',
      given: 'three serial chunks in a row: two sent, one received in between',
      then: 'the byte capture keeps each chunk\'s send-or-receive direction and length, so a frame split across two reads stays visible as two chunks',
      why: 'a frame that arrived in two reads looks different from one that arrived whole, and that difference is usually the bug',
    },
    () => {
      const ring = new ByteRing(256, 16);
      ring.push('tx', Uint8Array.of(0xaa, 0xbb));
      ring.push('rx', Uint8Array.of(0xcc));
      ring.push('tx', Uint8Array.of(0xdd, 0xee, 0xff));

      const snap = ring.snapshot();
      expect(snap.chunks.map((c) => c.dir)).toEqual(['tx', 'rx', 'tx']);
      expect(snap.chunks.map((c) => c.len)).toEqual([2, 1, 3]);
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-ignores-empty-chunks',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.push',
      given: 'an empty serial chunk is recorded',
      then: 'an empty serial chunk is dropped and does not count as traffic',
    },
    () => {
      const ring = new ByteRing(256, 16);
      ring.push('rx', new Uint8Array(0));
      expect(ring.snapshot().chunks).toHaveLength(0);
      expect(ring.stats().chunksPushed).toBe(0);
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-lifetime-byte-totals',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.snapshot',
      given: 'received and sent serial chunks totaling 16 received bytes and 4 sent bytes',
      then: 'lifetime received and sent byte totals match every byte that was recorded',
    },
    () => {
      const ring = new ByteRing(256, 16);
      ring.push('rx', seq(0, 10));
      ring.push('tx', seq(0, 4));
      ring.push('rx', seq(0, 6));

      const snap = ring.snapshot();
      expect(snap.totalRxBytes).toBe(16);
      expect(snap.totalTxBytes).toBe(4);
    },
  );
});

describe('ByteRing — wrap correctness', () => {
  behaviour(
    {
      id: 'diag.byte-ring-reconstructs-after-wrap',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.snapshot',
      given: 'more serial bytes than the capture window can hold, written in three chunks',
      then: 'after the capture window fills, the most recent bytes are reconstructed in the order they were written',
      why: 'protocol bugs show up in the raw bytes on the wire, so the window must stay the true sequence after it wraps',
    },
    () => {
      // Capacity 16, write 24 bytes in 3 chunks: the first 8 fall off the back.
      const ring = new ByteRing(16, 16);
      ring.push('rx', seq(0, 8));
      ring.push('rx', seq(8, 8));
      ring.push('rx', seq(16, 8));

      // Only the last 16 bytes (values 8..23) are still resident.
      expect(residentBytes(ring)).toEqual(seq(8, 16));
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-unwraps-straddling-chunk',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.snapshot',
      given: 'a serial chunk whose bytes wrap around the end of the capture window',
      then: 'a serial chunk that wraps around the end of the capture window comes back as one contiguous sequence in the original order',
    },
    () => {
      const ring = new ByteRing(16, 16);
      ring.push('rx', seq(0, 12)); // head → 12
      ring.push('rx', seq(100, 8)); // writes 4 bytes at 12..15, wraps 4 to 0..3

      const snap = ring.snapshot();
      const last = snap.chunks[snap.chunks.length - 1];
      // The straddling chunk must come back contiguous and in the right order.
      expect(decode(last.b64)).toEqual(seq(100, 8));
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-clips-partial-overwrite',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.snapshot',
      given: 'a later serial chunk overwrites the start of an earlier chunk still in the window',
      then: 'a partially overwritten serial chunk is reported as clipped, with only its remaining tail kept',
      why: 'a clipped chunk must be marked so leftover bytes are not treated as a complete frame',
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-drops-overwritten-chunks',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.snapshot',
      given: 'four serial chunks totaling more than the capture window',
      then: 'fully overwritten serial chunks disappear from the byte capture and are counted as dropped',
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-keeps-oversize-tail',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.push',
      given: 'a single serial chunk larger than the entire capture window',
      then: 'a serial chunk larger than the capture window keeps only its most recent bytes, while the lifetime total still counts every byte that arrived',
    },
    () => {
      const ring = new ByteRing(8, 16);
      ring.push('rx', seq(0, 20));

      const snap = ring.snapshot();
      expect(snap.chunks).toHaveLength(1);
      expect(snap.chunks[0].len).toBe(8);
      // The most recent 8 bytes are the ones worth keeping.
      expect(decode(snap.chunks[0].b64)).toEqual(seq(12, 8));
      expect(snap.totalRxBytes).toBe(20);
    },
  );
});

describe('ByteRing — metadata eviction', () => {
  behaviour(
    {
      id: 'diag.byte-ring-evicts-oldest-metadata',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.snapshot',
      given: 'more serial chunks than the capture can remember as separate pieces',
      then: 'the oldest chunk records are dropped once the capture can remember no more separate pieces, leaving only the most recent chunks',
    },
    () => {
      // Plenty of byte capacity, deliberately few metadata slots.
      const ring = new ByteRing(4096, 4);
      for (let i = 0; i < 10; i++) ring.push('rx', Uint8Array.of(i));

      const snap = ring.snapshot();
      expect(snap.chunks).toHaveLength(4);
      // The four most recent single-byte chunks survive.
      expect(snap.chunks.map((c) => decode(c.b64)[0])).toEqual([6, 7, 8, 9]);
      expect(snap.droppedChunks).toBe(6);
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-no-stale-bytes',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.snapshot',
      given: 'many tiny serial chunks that overflow the byte window while chunk records remain',
      then: 'the byte capture only contains bytes still in the window, never bytes whose records outlived the data',
      why: 'a capture that showed bytes the window has already overwritten would invent traffic that was not on the wire',
    },
    () => {
      // The classic failure: metadata surviving longer than the bytes it points at.
      const ring = new ByteRing(8, 64);
      for (let i = 0; i < 40; i++) ring.push('rx', Uint8Array.of(i));

      const snap = ring.snapshot();
      const resident = residentBytes(ring);
      // Whatever survives must be exactly the last `capacity` bytes written.
      expect(resident).toEqual(Uint8Array.from({ length: 8 }, (_, i) => 32 + i));
      expect(snap.chunks.every((c) => c.len > 0)).toBe(true);
    },
  );
});

describe('ByteRing — resource ceiling', () => {
  behaviour(
    {
      id: 'diag.byte-ring-fixed-footprint',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.footprintBytes',
      given: 'thousands of serial chunks written through a capture window',
      then: 'the byte capture\'s memory footprint stays fixed and does not grow with traffic',
      why: 'the capture sits on the serial read path and must not grow as traffic arrives',
    },
    () => {
      const ring = new ByteRing(1024, 32);
      const before = ring.footprintBytes();
      for (let i = 0; i < 5000; i++) ring.push(i % 2 ? 'tx' : 'rx', seq(i, 37));
      expect(ring.footprintBytes()).toBe(before);
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-default-footprint',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.footprintBytes',
      given: 'a byte capture created with default capacity',
      then: 'the default byte capture is sized to its documented 64 KiB payload plus 4096 chunk records',
    },
    () => {
      const ring = new ByteRing();
      // 64 KiB payload + 4096 slots × (8 abs + 4 len + 8 at + 1 dir) bytes.
      const expected = BYTE_RING_CAPACITY + CHUNK_META_CAPACITY * (8 + 4 + 8 + 1);
      expect(ring.footprintBytes()).toBe(expected);
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-resident-bytes-capped',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.stats',
      given: 'more serial bytes than the capture window can hold',
      then: 'the count of bytes still in the window is capped at the capture window\'s capacity',
    },
    () => {
      const ring = new ByteRing(64, 16);
      ring.push('rx', seq(0, 20));
      expect(ring.stats().bytesResident).toBe(20);
      ring.push('rx', seq(0, 100));
      expect(ring.stats().bytesResident).toBe(64);
    },
  );
});

describe('ByteRing — reset', () => {
  behaviour(
    {
      id: 'diag.byte-ring-reset-clears',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.reset',
      given: 'a byte capture that already holds serial traffic',
      then: 'clearing the byte capture drops captured chunks and counters while keeping the same memory footprint',
    },
    () => {
      const ring = new ByteRing(64, 16);
      const footprint = ring.footprintBytes();
      ring.push('rx', seq(0, 32));
      ring.reset();

      const snap = ring.snapshot();
      expect(snap.chunks).toHaveLength(0);
      expect(snap.droppedChunks).toBe(0);
      expect(snap.totalRxBytes).toBe(0);
      expect(ring.footprintBytes()).toBe(footprint);
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-captures-after-reset',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.reset',
      given: 'serial traffic is recorded, the capture is reset, then a new chunk is recorded',
      then: 'after a reset, new serial traffic is captured as the only bytes in the window',
    },
    () => {
      const ring = new ByteRing(64, 16);
      ring.push('rx', seq(0, 32));
      ring.reset();
      ring.push('tx', Uint8Array.of(9, 9, 9));

      expect(residentBytes(ring)).toEqual(Uint8Array.of(9, 9, 9));
    },
  );
});

describe('ByteRing.tailHex', () => {
  behaviour(
    {
      id: 'diag.byte-ring-tail-hex-order',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.tailHex',
      given: 'four received serial bytes',
      then: 'the hex tail of the byte capture is the most recent bytes, oldest first',
      why: 'when a frame fails to decode, the bytes that caused it are the whole story',
    },
    () => {
      const ring = new ByteRing(64, 8);
      ring.push('rx', Uint8Array.from([0x01, 0x02, 0x03, 0xff]));
      expect(ring.tailHex(4)).toBe('01 02 03 ff');
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-tail-hex-caps-count',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.tailHex',
      given: 'six received serial bytes and a request for the last two',
      then: 'the hex tail is limited to the requested number of most recent bytes',
    },
    () => {
      const ring = new ByteRing(64, 8);
      ring.push('rx', Uint8Array.from([1, 2, 3, 4, 5, 6]));
      expect(ring.tailHex(2)).toBe('05 06');
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-tail-hex-within-written',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.tailHex',
      given: 'one received serial byte and a request for 32 bytes of hex',
      then: 'the hex tail never pads with bytes that were never written',
    },
    () => {
      const ring = new ByteRing(64, 8);
      ring.push('rx', Uint8Array.from([0xaa]));
      expect(ring.tailHex(32)).toBe('aa');
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-tail-hex-empty-when-idle',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.tailHex',
      given: 'a byte capture with no serial traffic yet',
      then: 'the hex tail is empty before any serial traffic is recorded',
    },
    () => {
      expect(new ByteRing(64, 8).tailHex()).toBe('');
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-tail-hex-across-wrap',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.tailHex',
      given: 'serial traffic that has wrapped a four-byte capture window',
      then: 'the hex tail reads the most recent bytes in order even when they wrap around the capture window',
    },
    () => {
      // Capacity 4: the last four bytes span the seam in the backing buffer.
      const ring = new ByteRing(4, 8);
      ring.push('rx', Uint8Array.from([1, 2, 3]));
      ring.push('tx', Uint8Array.from([4, 5]));
      expect(ring.tailHex(4)).toBe('02 03 04 05');
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-tail-hex-within-capacity',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.tailHex',
      given: 'six serial bytes written into a four-byte capture window',
      then: 'the hex tail never returns more bytes than the capture window still holds',
    },
    () => {
      const ring = new ByteRing(4, 8);
      ring.push('rx', Uint8Array.from([1, 2, 3, 4, 5, 6]));
      expect(ring.tailHex(64)).toBe('03 04 05 06');
    },
  );

  behaviour(
    {
      id: 'diag.byte-ring-tail-hex-zero-pads',
      covers: 'src/diagnostics/byteRing.ts#ByteRing.tailHex',
      given: 'serial bytes whose hex would be one digit next to a two-digit byte',
      then: 'each byte in the hex tail is two digits, so columns stay aligned',
    },
    () => {
      const ring = new ByteRing(16, 4);
      ring.push('rx', Uint8Array.from([0x00, 0x0f, 0x10]));
      expect(ring.tailHex(3)).toBe('00 0f 10');
    },
  );
});
