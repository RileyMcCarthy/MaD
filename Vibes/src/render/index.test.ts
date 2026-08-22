import { describe, expect, it } from 'vitest';
import type { Verdict } from '../types.js';
import type { RenderBlock } from './blocks.js';
import { capBlocks, countBlocks, validateBlocks } from './blocks.js';
import { BUILTIN_RENDERERS } from './builtins/index.js';
import { DEFAULT_RENDER_LIMITS, defaultRegistry, renderSnapshot } from './index.js';
import type { RenderInput, RendererModule, SnapshotFileRef } from './registry.js';
import { RendererRegistry } from './registry.js';

function input(baseline = 'a\nb\n', received = 'a\nB\n'): RenderInput {
  const verdict: Verdict = { kind: 'different', mode: 'exact' };
  const ref: SnapshotFileRef = {
    component: 'control',
    producer: 'domain',
    file: 'a.txt',
    repoPath: 'snapshots/a.txt',
    state: 'changed',
    verdict,
    bytes: 4,
  };
  return { ref, baseline: Buffer.from(baseline), received: Buffer.from(received) };
}

function registryWith(mod: RendererModule): RendererRegistry {
  return new RendererRegistry(
    { ...BUILTIN_RENDERERS, custom: mod },
    { bindings: [{ pattern: 'snapshots/**', renderer: 'custom' }] },
  );
}

describe('renderSnapshot guards', () => {
  it('renders through the default when nothing is bound', async () => {
    const out = await renderSnapshot(input());
    expect(out.rendererId).toBe('text');
    expect(out.blocks.some((b) => b.kind === 'diff')).toBe(true);
    expect(out.errored).toBe(false);
  });

  it('falls back to the text diff when a renderer throws', async () => {
    const out = await renderSnapshot(input(), {
      registry: registryWith({
        render() {
          throw new Error('boom');
        },
      }),
    });
    expect(out.errored).toBe(true);
    expect(out.via).toBe('fallback');
    // Never an empty section: an empty section reads as "nothing changed".
    expect(out.blocks.some((b) => b.kind === 'diff')).toBe(true);
    expect(out.blocks.some((b) => b.kind === 'note' && b.level === 'error')).toBe(true);
    expect(out.notes.join(' ')).toMatch(/boom/);
  });

  it('falls back when a renderer returns nothing at all', async () => {
    const out = await renderSnapshot(input(), { registry: registryWith({ render: () => [] }) });
    expect(out.blocks.length).toBeGreaterThan(0);
  });

  it('falls back when a renderer returns invalid blocks, and says which were bad', async () => {
    const out = await renderSnapshot(input(), {
      registry: registryWith({ render: () => [{ kind: 'nope' } as unknown as RenderBlock] }),
    });
    expect(out.notes.join(' ')).toMatch(/invalid block/);
    expect(out.blocks.some((b) => b.kind === 'diff')).toBe(true);
  });

  it('times out an async renderer instead of hanging the run', async () => {
    const out = await renderSnapshot(input(), {
      registry: registryWith({
        render: () => new Promise<RenderBlock[]>(() => {}),
      }),
      limits: { ...DEFAULT_RENDER_LIMITS, rendererTimeoutMs: 25 },
    });
    expect(out.errored).toBe(true);
    expect(out.notes.join(' ')).toMatch(/exceeded 25ms/);
  });

  it('caps block count and records the drop', async () => {
    const many: RenderBlock[] = Array.from({ length: 50 }, (_, i) => ({
      kind: 'text',
      text: `block ${i}`,
    }));
    const out = await renderSnapshot(input(), {
      registry: registryWith({ render: () => many }),
      limits: { ...DEFAULT_RENDER_LIMITS, maxBlocksPerFile: 10 },
    });
    expect(countBlocks(out.blocks)).toBeLessThanOrEqual(10);
    expect(out.notes.join(' ')).toMatch(/blocks dropped/);
  });

  it('caps per-file bytes and says it did', async () => {
    const big: RenderBlock[] = Array.from({ length: 20 }, () => ({
      kind: 'text',
      text: 'x'.repeat(2_000),
    }));
    const out = await renderSnapshot(input(), {
      registry: registryWith({ render: () => big }),
      limits: { ...DEFAULT_RENDER_LIMITS, maxBytesPerFile: 5_000 },
    });
    expect(out.notes.join(' ')).toMatch(/byte budget|exceeded/);
    expect(out.blocks.some((b) => b.kind === 'note' && b.level === 'warn')).toBe(true);
  });

  it('reports bindings that matched but lost', async () => {
    const registry = new RendererRegistry(BUILTIN_RENDERERS, {
      bindings: [
        { pattern: '**/*', renderer: 'binary' },
        { pattern: 'snapshots/a.txt', renderer: 'text' },
      ],
    });
    const out = await renderSnapshot(input(), { registry });
    expect(out.notes.join(' ')).toMatch(/shadowed/);
  });

  it('sanitises ANSI out of renderer-supplied text', async () => {
    const ESC = String.fromCharCode(27);
    const out = await renderSnapshot(input(), {
      registry: registryWith({ render: () => [{ kind: 'text', text: `${ESC}[31mred${ESC}[0m` }] }),
    });
    const text = out.blocks.find((b) => b.kind === 'text');
    expect(text?.kind === 'text' && text.text).toBe('red');
  });

  it('uses the default registry when none is given, and never has a hole', async () => {
    const reg = defaultRegistry();
    expect(reg.has('text')).toBe(true);
    expect(reg.has('json')).toBe(true);
    expect(reg.has('series')).toBe(true);
    expect(reg.has('binary')).toBe(true);
  });
});

describe('block validation', () => {
  it('rejects a non-array', () => {
    expect(validateBlocks('nope').errors[0]).toMatch(/array of blocks/);
  });

  it('rejects an unknown kind and keeps the good ones', () => {
    const v = validateBlocks([{ kind: 'text', text: 'a' }, { kind: 'html', html: '<b>' }]);
    expect(v.blocks).toHaveLength(1);
    expect(v.errors[0]).toMatch(/unknown block kind/);
  });

  it('drops an unsafe code language hint rather than emitting it', () => {
    const v = validateBlocks([{ kind: 'code', text: 'x', lang: '"><script>' }]);
    const b = v.blocks[0];
    expect(b?.kind === 'code' && 'lang' in b).toBe(false);
  });

  it('bounds details nesting', () => {
    const deep = { kind: 'details', summary: 's', children: [{ kind: 'details', summary: 's', children: [{ kind: 'details', summary: 's', children: [{ kind: 'details', summary: 's', children: [] }] }] }] };
    const v = validateBlocks([deep]);
    expect(v.errors.join(' ')).toMatch(/nested deeper/);
  });

  it('counts nested children when capping', () => {
    const blocks: RenderBlock[] = [
      { kind: 'details', summary: 's', children: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }] },
      { kind: 'text', text: 'c' },
    ];
    expect(countBlocks(blocks)).toBe(4);
    expect(capBlocks(blocks, 3).blocks).toHaveLength(1);
    expect(capBlocks(blocks, 3).dropped).toBe(1);
  });
});
