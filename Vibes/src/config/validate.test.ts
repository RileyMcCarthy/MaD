import { describe, expect, it } from 'vitest';

import type { ComponentEntry } from '../types.js';
import type { Diagnostic, DiagnosticCode } from './diagnostics.js';
import { validateManifest, validateRootConfig } from './validate.js';

const codes = (ds: readonly Diagnostic[]): DiagnosticCode[] => ds.map((d) => d.code);
const has = (ds: readonly Diagnostic[], c: DiagnosticCode): boolean => codes(ds).includes(c);
const errors = (ds: readonly Diagnostic[]): readonly Diagnostic[] => ds.filter((d) => d.severity === 'error');

const ROOT = 'vibes.config.mjs';
const MANIFEST = 'compA/vibes/vibes.manifest.mjs';

const entry: ComponentEntry = { id: 'compa', root: 'compA' };

function root(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    baseRef: 'origin/main',
    report: { out: '.vibes/report', formats: ['md', 'json'] },
    components: [{ id: 'compa', root: 'compA' }],
    ...over,
  };
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { component: 'compa', producers: [], ...over };
}

function producer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'p1', cmd: 'echo hi > "$VIBES_OUT/x"', out: 'snapshots/p1', ciJob: 'vibes', ...over };
}

/* ═════════════════════════════ root ═══════════════════════════════════ */

describe('validateRootConfig', () => {
  it('accepts a minimal registry', () => {
    const r = validateRootConfig(root(), ROOT);
    expect(errors(r.diagnostics)).toEqual([]);
    expect(r.entries.map((e) => e.id)).toEqual(['compa']);
  });

  it('rejects a factory root config, naming why a factory cannot work', () => {
    const r = validateRootConfig(() => root(), ROOT);
    expect(has(r.diagnostics, 'V017_ROOT_NOT_OBJECT')).toBe(true);
    expect(r.diagnostics[0]?.evidence.join(' ')).toMatch(/baseSha/);
  });

  it('treats unknown keys as errors, never as noise to drop', () => {
    const r = validateRootConfig(root({ discover: ['**/vibes/*.mjs'] }), ROOT);
    expect(has(r.diagnostics, 'V012_ROOT_UNKNOWN_KEY')).toBe(true);
    // There is no discovery key by design; a typo must not be silently ignored.
    expect(r.diagnostics.find((d) => d.code === 'V012_ROOT_UNKNOWN_KEY')?.locator).toBe('discover');
  });

  it('requires version 1', () => {
    expect(has(validateRootConfig(root({ version: 2 }), ROOT).diagnostics, 'V013_ROOT_VERSION')).toBe(true);
  });

  it('requires a non-empty components array', () => {
    const missing = validateRootConfig(root({ components: undefined }), ROOT);
    expect(has(missing.diagnostics, 'V0A3_FIELD_TYPE')).toBe(true);
    const empty = validateRootConfig(root({ components: [] }), ROOT);
    expect(errors(empty.diagnostics).length).toBeGreaterThan(0);
  });

  it('rejects an invalid or duplicated component id', () => {
    const invalid = validateRootConfig(root({ components: [{ id: 'Comp A', root: 'x' }] }), ROOT);
    expect(has(invalid.diagnostics, 'V020_ID_INVALID')).toBe(true);

    const dup = validateRootConfig(
      root({ components: [{ id: 'compa', root: 'a' }, { id: 'compa', root: 'b' }] }),
      ROOT,
    );
    expect(has(dup.diagnostics, 'V021_ID_DUPLICATE')).toBe(true);
  });

  it('refuses a component rooted at the repo root', () => {
    const r = validateRootConfig(root({ components: [{ id: 'all', root: '.' }] }), ROOT);
    expect(has(r.diagnostics, 'V025_ROOT_IS_REPO_ROOT')).toBe(true);
  });

  it('demands a reason AND an expiry when a component is disabled', () => {
    const r = validateRootConfig(
      root({ components: [{ id: 'hardware', root: 'Hardware', enabled: false }] }),
      ROOT,
    );
    const disabled = r.diagnostics.filter((d) => d.code === 'V026_DISABLED_REASON_REQUIRED');
    expect(disabled.map((d) => d.locator)).toEqual([
      'components[0].disabledReason',
      'components[0].disabledUntil',
    ]);
  });

  it('rejects a malformed disabledUntil date', () => {
    const r = validateRootConfig(
      root({
        components: [
          { id: 'hardware', root: 'Hardware', enabled: false, disabledReason: 'no runner', disabledUntil: '2026-13-99' },
        ],
      }),
      ROOT,
    );
    expect(has(r.diagnostics, 'V026_DISABLED_REASON_REQUIRED')).toBe(true);
  });

  it('warns when disabledReason is set on an enabled component', () => {
    const r = validateRootConfig(
      root({ components: [{ id: 'compa', root: 'compA', disabledReason: 'leftover' }] }),
      ROOT,
    );
    expect(r.diagnostics.some((d) => d.severity === 'warn')).toBe(true);
  });

  it('rejects brace globs in generates', () => {
    const r = validateRootConfig(
      root({ components: [{ id: 'compa', root: 'compA', generates: ['out/**/*.{c,h}'] }] }),
      ROOT,
    );
    expect(has(r.diagnostics, 'V0A0_GLOB_BRACES')).toBe(true);
  });

  it('validates report.formats against the known set', () => {
    const r = validateRootConfig(root({ report: { out: '.vibes/report', formats: ['pdf'] } }), ROOT);
    expect(errors(r.diagnostics).length).toBeGreaterThan(0);
  });

  it('rejects a report.out that escapes the repo', () => {
    const r = validateRootConfig(root({ report: { out: '../elsewhere', formats: ['md'] } }), ROOT);
    expect(has(r.diagnostics, 'V015_REPORT_OUT_ESCAPES')).toBe(true);
  });

  it('rejects an out-of-range concurrency', () => {
    expect(has(validateRootConfig(root({ concurrency: 0 }), ROOT).diagnostics, 'V018_CONCURRENCY_RANGE')).toBe(true);
  });

  it('rejects non-SharedDefaults keys in root defaults', () => {
    const r = validateRootConfig(root({ defaults: { witnesses: ['src/**'] } }), ROOT);
    expect(errors(r.diagnostics).length).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════ manifest ═════════════════════════════════ */

describe('validateManifest', () => {
  it('accepts an ingest-only manifest with no producers and no witnesses', () => {
    const m = validateManifest(
      manifest({ ingest: { junit: 'vibes/artifacts/*.xml', required: false } }),
      MANIFEST,
      entry,
    );
    expect(errors(m.diagnostics)).toEqual([]);
  });

  it('cross-checks the component id against the registry', () => {
    const m = validateManifest(manifest({ component: 'compb' }), MANIFEST, entry);
    expect(has(m.diagnostics, 'V038_COMPONENT_MISMATCH')).toBe(true);
  });

  it('rejects registry-only keys with a code that names the split', () => {
    for (const key of ['root', 'enabled', 'dependsOn', 'generates', 'submodules', 'disabledReason']) {
      const m = validateManifest(manifest({ [key]: 'whatever' }), MANIFEST, entry);
      expect(has(m.diagnostics, 'V037_REGISTRY_KEY_IN_MANIFEST'), key).toBe(true);
    }
  });

  it('rejects an unknown manifest key', () => {
    const m = validateManifest(manifest({ witneses: ['src/**'] }), MANIFEST, entry);
    expect(has(m.diagnostics, 'V036_MANIFEST_UNKNOWN_KEY')).toBe(true);
  });

  it('requires witnesses once there is a producer', () => {
    const m = validateManifest(manifest({ producers: [producer()] }), MANIFEST, entry);
    expect(has(m.diagnostics, 'V050_WITNESSES_REQUIRED')).toBe(true);
  });

  it('rejects a witness under vibes/, which is already implicit', () => {
    const m = validateManifest(
      manifest({ producers: [producer()], witnesses: ['vibes/producers/**'] }),
      MANIFEST,
      entry,
    );
    expect(has(m.diagnostics, 'V052_WITNESS_IN_VIBES_DIR')).toBe(true);
  });

  it('rejects an invalid or duplicated producer name', () => {
    const invalid = validateManifest(
      manifest({ producers: [producer({ name: 'Gcode Corpus' })], witnesses: ['src/**'] }),
      MANIFEST,
      entry,
    );
    expect(has(invalid.diagnostics, 'V040_NAME_INVALID')).toBe(true);

    const dup = validateManifest(
      manifest({ producers: [producer(), producer({ out: 'snapshots/other' })], witnesses: ['src/**'] }),
      MANIFEST,
      entry,
    );
    expect(has(dup.diagnostics, 'V041_NAME_DUPLICATE')).toBe(true);
  });

  it('rejects a cmd that changes directory', () => {
    for (const cmd of ['cd sub && make', 'make; cd other', 'true | cd x']) {
      const m = validateManifest(
        manifest({ producers: [producer({ cmd })], witnesses: ['src/**'] }),
        MANIFEST,
        entry,
      );
      expect(has(m.diagnostics, 'V042_CMD_HAS_CD'), cmd).toBe(true);
    }
  });

  it('allows a cmd that merely mentions cd inside a word', () => {
    const m = validateManifest(
      manifest({ producers: [producer({ cmd: 'node cdn/build.mjs' })], witnesses: ['src/**'] }),
      MANIFEST,
      entry,
    );
    expect(has(m.diagnostics, 'V042_CMD_HAS_CD')).toBe(false);
  });

  it('rejects an out that escapes the vibes dir', () => {
    const m = validateManifest(
      manifest({ producers: [producer({ out: '../snapshots' })], witnesses: ['src/**'] }),
      MANIFEST,
      entry,
    );
    expect(has(m.diagnostics, 'V043_OUT_ESCAPES')).toBe(true);
  });

  it('rejects a timeout outside the allowed range', () => {
    const m = validateManifest(
      manifest({ producers: [producer({ timeoutMs: 10 })], witnesses: ['src/**'] }),
      MANIFEST,
      entry,
    );
    expect(has(m.diagnostics, 'V049_TIMEOUT_RANGE')).toBe(true);
  });

  it('warns — not errors — when a producer has no CI job', () => {
    const m = validateManifest(
      manifest({ producers: [producer({ ciJob: undefined })], witnesses: ['src/**'] }),
      MANIFEST,
      entry,
    );
    const d = m.diagnostics.find((x) => x.code === 'V04G_CIJOB_MISSING');
    expect(d?.severity).toBe('warn');
    expect(errors(m.diagnostics)).toEqual([]);
  });

  describe('compare', () => {
    const withCompare = (compare: unknown): readonly Diagnostic[] =>
      validateManifest(
        manifest({ producers: [producer({ compare })], witnesses: ['src/**'] }),
        MANIFEST,
        entry,
      ).diagnostics;

    it('accepts exact and a first-match-wins rule array', () => {
      expect(errors(withCompare({ kind: 'exact' }))).toEqual([]);
      expect(
        errors(
          withCompare([
            { match: '**/*.csv', use: { kind: 'tolerance', rel: 1e-9, reason: 'float64 → decimal text' } },
            { match: '**/*', use: { kind: 'exact' } },
          ]),
        ),
      ).toEqual([]);
    });

    it('demands a reason for every loosened comparison', () => {
      const ds = withCompare({ kind: 'tolerance', rel: 1e-9 });
      expect(has(ds, 'V04C_TOLERANCE_NO_REASON')).toBe(true);
    });

    it('refuses an unbounded tolerance', () => {
      expect(has(withCompare({ kind: 'tolerance', reason: 'why' }), 'V04B_TOLERANCE_UNBOUNDED')).toBe(true);
    });

    it('caps rel and abs so "tolerant" cannot mean "compare nothing"', () => {
      expect(has(withCompare({ kind: 'tolerance', rel: 0.5, reason: 'why' }), 'V04B_TOLERANCE_UNBOUNDED')).toBe(true);
      expect(has(withCompare({ kind: 'tolerance', abs: 5, reason: 'why' }), 'V04B_TOLERANCE_UNBOUNDED')).toBe(true);
    });

    it('caps the pixel diff ratio too', () => {
      expect(
        has(withCompare({ kind: 'pixel', maxDiffRatio: 0.9, reason: 'antialiasing' }), 'V04B_TOLERANCE_UNBOUNDED'),
      ).toBe(true);
    });

    it('rejects an unknown compare kind', () => {
      expect(errors(withCompare({ kind: 'fuzzy' })).length).toBeGreaterThan(0);
    });

    it('rejects braces in a rule match', () => {
      expect(has(withCompare([{ match: '**/*.{csv,tsv}', use: { kind: 'exact' } }]), 'V0A0_GLOB_BRACES')).toBe(true);
    });
  });

  it('rejects an env value that is neither a string nor null', () => {
    const m = validateManifest(
      manifest({ producers: [producer({ env: { PORT: 5174 } })], witnesses: ['src/**'] }),
      MANIFEST,
      entry,
    );
    expect(errors(m.diagnostics).length).toBeGreaterThan(0);
  });

  it('accepts null env values — null means "unset in the child"', () => {
    const m = validateManifest(
      manifest({ producers: [producer({ env: { ELECTRON_RUN_AS_NODE: null } })], witnesses: ['src/**'] }),
      MANIFEST,
      entry,
    );
    expect(errors(m.diagnostics)).toEqual([]);
  });

  it('accepts both the string and array forms of an ingest glob', () => {
    expect(
      errors(validateManifest(manifest({ ingest: { junit: 'a.xml' } }), MANIFEST, entry).diagnostics),
    ).toEqual([]);
    expect(
      errors(validateManifest(manifest({ ingest: { junit: ['a.xml', 'b.xml'] } }), MANIFEST, entry).diagnostics),
    ).toEqual([]);
  });

  it('accepts the lcov object form with a sourceRoot', () => {
    const m = validateManifest(
      manifest({ ingest: { lcov: [{ path: 'coverage/lcov.info', sourceRoot: '.' }] } }),
      MANIFEST,
      entry,
    );
    expect(errors(m.diagnostics)).toEqual([]);
  });
});

/* ═════════════════════ diagnostic quality invariants ══════════════════ */

describe('every diagnostic is actionable', () => {
  const corpus: readonly Diagnostic[] = [
    ...validateRootConfig(
      root({
        version: 3,
        discover: ['**'],
        concurrency: 0,
        components: [
          { id: 'BAD ID', root: '/abs' },
          { id: 'compa', root: 'compA', enabled: false },
          { id: 'compa', root: 'compA', generates: ['x/{a,b}/**'] },
        ],
      }),
      ROOT,
    ).diagnostics,
    ...validateManifest(
      {
        component: 'other',
        root: 'narrowed',
        producers: [
          { name: 'BAD', cmd: 'cd x && make', out: '../escape', timeoutMs: 1, compare: { kind: 'tolerance' } },
        ],
        witnesses: ['vibes/**', 'src/**/*.{ts,tsx}'],
      },
      MANIFEST,
      entry,
    ).diagnostics,
  ];

  it('produced a broad corpus', () => {
    expect(corpus.length).toBeGreaterThan(10);
  });

  it('names a file, a fix and evidence-only facts', () => {
    for (const d of corpus) {
      expect(d.file, d.code).toBeTruthy();
      expect(d.fix.length, d.code).toBeGreaterThan(0);
      expect(d.message.length, d.code).toBeLessThanOrEqual(100);
      expect(d.message.endsWith('.'), d.code).toBe(false);
      // Messages read as sentences, not as Titles Of Errors.
      expect(/^[A-Z]/.test(d.message), `${d.code}: ${d.message}`).toBe(false);
    }
  });

  it('gives a locator for every field-level finding', () => {
    const fieldLevel = corpus.filter((d) => d.code !== 'V057_WITNESS_MULTICLAIM');
    expect(fieldLevel.every((d) => d.locator !== undefined || d.code.startsWith('V05'))).toBe(true);
  });
});
