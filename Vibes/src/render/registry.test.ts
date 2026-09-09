import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';
import type { Verdict } from '../types.js';
import { BUILTIN_RENDERERS, sniffRenderer } from './builtins/index.js';
import type { RendererBinding, RenderInput, SnapshotFileRef } from './registry.js';
import { BindingTable, RendererRegistry, validateBindings } from './registry.js';

function ref(repoPath: string, overrides: Partial<SnapshotFileRef> = {}): SnapshotFileRef {
  const verdict: Verdict = { kind: 'different', mode: 'exact' };
  return {
    component: 'control',
    producer: 'domain',
    file: repoPath.split('/').slice(-1)[0] ?? repoPath,
    repoPath,
    state: 'changed',
    verdict,
    bytes: 10,
    ...overrides,
  };
}

function input(repoPath: string, baseline = 'a\n', received = 'b\n'): RenderInput {
  return {
    ref: ref(repoPath),
    baseline: Buffer.from(baseline),
    received: Buffer.from(received),
  };
}

/**
 * THE TRAP THIS MODULE EXISTS TO AVOID. Documented as an executable claim so
 * nobody "simplifies" the registry back into a compound picomatch call.
 */
describe('picomatch negation, demonstrated', () => {
  it('a single negated pattern returns TRUE for everything it does not match', () => {
    const naive = picomatch('!**/generated/**');
    expect(naive('src/generated/a.ts')).toBe(false);
    // The inversion: a totally unrelated path now "matches" the binding.
    expect(naive('snapshots/domain/gcode.txt')).toBe(true);
  });

  it('Vibes resolves negation itself, so an exclusion never binds anything', () => {
    const table = new BindingTable([{ pattern: '!**/generated/**', renderer: 'json' }]);
    expect(table.resolve('snapshots/domain/gcode.txt').renderer).toBeNull();
    expect(table.resolve('src/generated/a.ts').renderer).toBeNull();
  });
});

describe('BindingTable specificity', () => {
  const bindings: readonly RendererBinding[] = [
    { pattern: '**/*', renderer: 'text' },
    { pattern: 'snapshots/**/*.json', renderer: 'json' },
    { pattern: 'snapshots/trace/**/*.csv', renderer: 'series' },
  ];
  const table = new BindingTable(bindings);

  it('picks the pattern with the most literal segments, not the last one', () => {
    expect(table.resolve('snapshots/trace/run/a.csv').renderer).toBe('series');
    expect(table.resolve('snapshots/domain/a.json').renderer).toBe('json');
    expect(table.resolve('snapshots/domain/a.txt').renderer).toBe('text');
  });

  it('reports the bindings that matched and lost', () => {
    const r = table.resolve('snapshots/trace/run/a.csv');
    expect(r.shadowed.map((s) => s.renderer)).toContain('text');
  });

  it('breaks ties by declaration order, last one winning', () => {
    const tied = new BindingTable([
      { pattern: 'snapshots/*.txt', renderer: 'text' },
      { pattern: 'snapshots/*.txt', renderer: 'json' },
    ]);
    expect(tied.resolve('snapshots/a.txt').renderer).toBe('json');
  });

  it('lets a more specific negation carve a hole in a broad binding', () => {
    const table2 = new BindingTable([
      { pattern: 'snapshots/**/*.json', renderer: 'json' },
      { pattern: '!snapshots/trace/**/*.json', renderer: 'json' },
    ]);
    expect(table2.resolve('snapshots/domain/a.json').renderer).toBe('json');
    const excluded = table2.resolve('snapshots/trace/a.json');
    expect(excluded.renderer).toBeNull();
    expect(excluded.excludedBy?.pattern).toBe('!snapshots/trace/**/*.json');
  });

  it('lets a still more specific positive re-include inside an exclusion', () => {
    const table3 = new BindingTable([
      { pattern: 'snapshots/**/*.json', renderer: 'json' },
      { pattern: '!snapshots/trace/**', renderer: 'json' },
      { pattern: 'snapshots/trace/keep/manifest.json', renderer: 'json' },
    ]);
    expect(table3.resolve('snapshots/trace/other/a.json').renderer).toBeNull();
    expect(table3.resolve('snapshots/trace/keep/manifest.json').renderer).toBe('json');
  });

  it('matches dotfiles, which snapshot corpora legitimately contain', () => {
    const table4 = new BindingTable([{ pattern: 'snapshots/**', renderer: 'text' }]);
    expect(table4.resolve('snapshots/.vibes-selected').renderer).toBe('text');
  });

  it('treats !(…) as an extglob, not as a negation', () => {
    const table5 = new BindingTable([{ pattern: 'snapshots/!(draft)/a.txt', renderer: 'json' }]);
    expect(table5.resolve('snapshots/final/a.txt').renderer).toBe('json');
    expect(table5.resolve('snapshots/draft/a.txt').renderer).toBeNull();
  });
});

describe('validateBindings', () => {
  const known = new Set(['text', 'json']);

  it('rejects braces, which git ls-files silently fails to expand', () => {
    const errs = validateBindings([{ pattern: 'src/**/*.{ts,tsx}', renderer: 'text' }], known);
    expect(errs[0]?.message).toMatch(/brace expansion/);
  });

  it('rejects an unknown renderer id at config time', () => {
    const errs = validateBindings([{ pattern: 'a/**', renderer: 'nope' }], known);
    expect(errs[0]?.message).toMatch(/unknown renderer/);
  });

  it('rejects a binding that reaches outside its own component', () => {
    const errs = validateBindings(
      [{ pattern: 'Firmware/**/*.txt', renderer: 'text', scope: 'Software/Control' }],
      known,
    );
    expect(errs[0]?.message).toMatch(/may only match paths under/);
  });

  it('accepts a binding inside its scope', () => {
    expect(
      validateBindings(
        [{ pattern: 'Software/Control/vibes/snapshots/**', renderer: 'text', scope: 'Software/Control' }],
        known,
      ),
    ).toEqual([]);
  });

  it('rejects an empty glob', () => {
    expect(validateBindings([{ pattern: '', renderer: 'text' }], known)[0]?.message).toMatch(/empty/);
  });
});

describe('RendererRegistry resolution chain', () => {
  // A renderer that never vetoes, so the test measures the CHAIN and not one
  // builtin's canRender. `binary` would veto on text input and mask the result.
  const custom = { name: 'custom', render: () => [{ kind: 'text' as const, text: 'custom' }] };
  const registry = (bindings: readonly RendererBinding[], producers?: Map<string, string>) =>
    new RendererRegistry({ ...BUILTIN_RENDERERS, custom }, {
      bindings,
      ...(producers ? { producerRenderers: producers } : {}),
      sniff: sniffRenderer,
    });

  it('prefers a glob binding over the producer field', () => {
    const r = registry([{ pattern: 'snapshots/**/*.txt', renderer: 'custom' }], new Map([['control/domain', 'json']]));
    expect(r.resolve(input('snapshots/a.txt')).via).toBe('glob');
    expect(r.resolve(input('snapshots/a.txt')).id).toBe('custom');
  });

  it('falls to the producer field when no glob matches', () => {
    const r = registry([], new Map([['control/domain', 'custom']]));
    const res = r.resolve(input('snapshots/a.txt'));
    expect(res.via).toBe('producer');
    expect(res.id).toBe('custom');
  });

  it('falls to the format sniff when nothing was declared', () => {
    const r = registry([]);
    const res = r.resolve(input('snapshots/a.json', '{"a":1}', '{"a":2}'));
    expect(res.via).toBe('format');
    expect(res.id).toBe('json');
  });

  it('ends at the text renderer, always', () => {
    const r = registry([]);
    const res = r.resolve(input('snapshots/a.txt'));
    expect(res.id).toBe('text');
    expect(res.via).toBe('default');
  });

  it('skips a candidate whose canRender vetoes, rather than emitting nothing', () => {
    const r = registry([{ pattern: 'snapshots/**/*.txt', renderer: 'json' }]);
    // json vetoes on unparseable content; the registry must not stall there.
    const res = r.resolve(input('snapshots/a.txt', 'not json', 'still not json'));
    expect(res.id).toBe('text');
    expect(res.via).toBe('fallback');
  });

  it('refuses to exist without a text renderer', () => {
    const broken = new RendererRegistry({ json: BUILTIN_RENDERERS['json'] as never });
    expect(() => broken.resolve(input('a.txt'))).toThrow(/no "text" renderer/);
  });
});
