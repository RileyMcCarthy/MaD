/**
 * Binary renderer: says what changed about the bytes and refuses to invent a
 * view of the content.
 *
 * WHY no hex dump by default: a 40 KB PNG is 2500 hex lines of pure noise
 * against a 96 KB markdown budget, and it crowds out the findings that a human
 * can act on. A bounded head dump is offered only when the file is small enough
 * that the dump is genuinely readable.
 */

import { createHash } from 'node:crypto';
import type { RenderBlock } from '../blocks.js';
import type { RenderContext, RenderInput, RendererModule } from '../registry.js';
import { looksBinary } from '../textDiff.js';

/** Above this, a hex dump is noise rather than evidence. */
export const HEX_DUMP_MAX_BYTES = 512;

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function hexDump(buf: Buffer, maxBytes = HEX_DUMP_MAX_BYTES): string {
  const slice = buf.subarray(0, maxBytes);
  const lines: string[] = [];
  for (let off = 0; off < slice.length; off += 16) {
    const row = slice.subarray(off, off + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (buf.length > maxBytes) lines.push(`… ${buf.length - maxBytes} more bytes`);
  return lines.join('\n');
}

/** Byte offset of the first difference, or -1. Cheap and genuinely useful. */
export function firstDifferingOffset(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export function renderBinary(input: RenderInput, ctx: RenderContext): RenderBlock[] {
  const { baseline, received } = input;
  const entries: [string, string][] = [];
  entries.push(['baseline bytes', baseline === null ? 'absent' : String(baseline.length)]);
  entries.push(['produced bytes', received === null ? 'absent' : String(received.length)]);
  if (baseline) entries.push(['baseline sha256', sha256(baseline).slice(0, 16)]);
  if (received) entries.push(['produced sha256', sha256(received).slice(0, 16)]);
  if (baseline && received) {
    const off = firstDifferingOffset(baseline, received);
    entries.push(['first differing byte', off < 0 ? 'none' : `0x${off.toString(16)}`]);
  }

  const blocks: RenderBlock[] = [
    {
      kind: 'note',
      level: 'info',
      text: 'Binary content is not rendered. The report can tell you these bytes moved; it cannot tell you what about them moved.',
    },
    { kind: 'kv', entries },
  ];

  const small = received ?? baseline;
  if (small && small.length <= HEX_DUMP_MAX_BYTES) {
    blocks.push({ kind: 'code', text: hexDump(small), lang: 'text' });
  } else if (small) {
    ctx.log(`${input.ref.file}: binary, ${small.length} bytes, no dump emitted`);
  }
  return blocks;
}

export const binaryRenderer: RendererModule = {
  name: 'binary',
  canRender(input: RenderInput): boolean {
    return (
      (input.baseline !== null && looksBinary(input.baseline)) ||
      (input.received !== null && looksBinary(input.received))
    );
  },
  render: renderBinary,
};
