import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ComponentEntry } from '../types.js';
import { loadManifest, loadRootConfig } from './load.js';

/** Every test builds a real directory tree and lets Node's real ESM loader
 *  answer. Mocking `import()` would test the mock, not the trap. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'vibes-load-'));
}

function writeRoot(repo: string, body: string, ext = '.mjs'): void {
  writeFileSync(join(repo, `vibes.config${ext}`), body);
}

function writeManifest(repo: string, root: string, body: string, ext = '.mjs'): void {
  mkdirSync(join(repo, root, 'vibes'), { recursive: true });
  writeFileSync(join(repo, root, 'vibes', `vibes.manifest${ext}`), body);
}

const VALID_ROOT = `export default {
  version: 1,
  baseRef: 'origin/main',
  report: { out: '.vibes/report', formats: ['md'] },
  components: [{ id: 'compa', root: 'compA' }],
};`;

const entry: ComponentEntry = { id: 'compa', root: 'compA' };

const manifestReq = (repo: string) => ({
  repoRoot: repo,
  entry,
  absRoot: join(repo, 'compA'),
  baseRef: 'origin/main',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  required: true,
});

describe('loadRootConfig', () => {
  it('loads a valid .mjs registry', async () => {
    const repo = scratch();
    writeRoot(repo, VALID_ROOT);
    const r = await loadRootConfig(repo);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.config?.baseRef).toBe('origin/main');
    expect(r.entries).toHaveLength(1);
  });

  it('reports a missing registry against its exact, underived path', async () => {
    const r = await loadRootConfig(scratch());
    expect(r.diagnostics[0]?.code).toBe('V010_ROOT_MISSING');
    expect(r.diagnostics[0]?.file).toBe('vibes.config.mjs');
  });

  it('rejects a .js registry and explains the CommonJS trap', async () => {
    const repo = scratch();
    writeRoot(repo, VALID_ROOT, '.js');
    const r = await loadRootConfig(repo);
    const d = r.diagnostics[0];
    expect(d?.code).toBe('V011_ROOT_NOT_MJS');
    expect(d?.file).toBe('vibes.config.js');
    expect(d?.evidence.join(' ')).toMatch(/no package.json|CommonJS/);
    expect(d?.fix).toMatch(/rename vibes\.config\.js to vibes\.config\.mjs/);
  });

  it('reports a missing default export rather than an empty config', async () => {
    const repo = scratch();
    writeRoot(repo, `export const config = { version: 1 };`);
    const r = await loadRootConfig(repo);
    expect(r.diagnostics[0]?.code).toBe('V033_NO_DEFAULT_EXPORT');
    expect(r.diagnostics[0]?.evidence.join(' ')).toMatch(/config/);
  });

  it('never accepts CommonJS syntax in an .mjs as an empty-but-valid config', async () => {
    const repo = scratch();
    writeRoot(repo, `module.exports = { version: 1 };`);
    const r = await loadRootConfig(repo);
    // WHICH diagnostic depends on the host, and all three outcomes are real:
    // node 20 throws ReferenceError ("module is not defined") → V032; node 23
    // exposes a `module` global and the file evaluates to nothing → V033; a
    // loader with CJS interop hands back `{version:1}` → shape errors. The
    // invariant that must hold everywhere is that none of them yields a usable
    // config, because a silently-empty registry reports a whole repo as clean.
    expect(r.config).toBeNull();
    expect(r.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('reports a throwing registry with its message and stack frames', async () => {
    const repo = scratch();
    writeRoot(repo, `throw new Error('boom from the config');\nexport default {};`);
    const r = await loadRootConfig(repo);
    expect(r.diagnostics[0]?.code).toBe('V034_MANIFEST_THREW');
    expect(r.diagnostics[0]?.evidence.join(' ')).toMatch(/boom from the config/);
  });

  it('rejects a factory registry — baseSha is derived FROM this file', async () => {
    const repo = scratch();
    writeRoot(repo, `export default () => ({ version: 1 });`);
    const r = await loadRootConfig(repo);
    expect(r.diagnostics.some((d) => d.code === 'V017_ROOT_NOT_OBJECT')).toBe(true);
  });
});

describe('loadManifest', () => {
  it('loads the object form from the DERIVED path', async () => {
    const repo = scratch();
    writeManifest(repo, 'compA', `export default { component: 'compa', producers: [] };`);
    const m = await loadManifest(manifestReq(repo));
    expect(m.file).toBe('compA/vibes/vibes.manifest.mjs');
    expect(m.manifest?.component).toBe('compa');
    expect(m.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('calls a factory with the full ManifestContext', async () => {
    const repo = scratch();
    writeManifest(
      repo,
      'compA',
      `export default (ctx) => ({
         component: ctx.component,
         producers: [],
         ingest: { junit: ctx.vibesDir.endsWith('compA/vibes') ? 'ok.xml' : 'wrong.xml', required: false },
       });`,
    );
    const m = await loadManifest(manifestReq(repo));
    expect(m.manifest?.component).toBe('compa');
    expect(m.manifest?.ingest?.junit).toBe('ok.xml');
  });

  it('awaits an async factory', async () => {
    const repo = scratch();
    writeManifest(
      repo,
      'compA',
      `export default async ({ baseSha, headSha }) => ({
         component: 'compa',
         producers: [],
         ingest: { junit: baseSha.slice(0, 4) + '-' + headSha.slice(0, 4) + '.xml', required: false },
       });`,
    );
    const m = await loadManifest(manifestReq(repo));
    expect(m.manifest?.ingest?.junit).toBe('aaaa-bbbb.xml');
  });

  it('reports a throwing factory with a span inside the manifest', async () => {
    const repo = scratch();
    writeManifest(repo, 'compA', `export default () => {\n  throw new Error('factory exploded');\n};`);
    const m = await loadManifest(manifestReq(repo));
    const d = m.diagnostics.find((x) => x.code === 'V034_MANIFEST_THREW');
    expect(d?.evidence.join(' ')).toMatch(/factory exploded/);
    expect(d?.span?.line).toBe(2);
  });

  it('rejects a factory that returns a non-object', async () => {
    const repo = scratch();
    writeManifest(repo, 'compA', `export default () => 42;`);
    const m = await loadManifest(manifestReq(repo));
    expect(m.diagnostics.some((d) => d.code === 'V039_MANIFEST_NOT_OBJECT')).toBe(true);
  });

  it('errors when a required manifest is missing', async () => {
    const repo = scratch();
    mkdirSync(join(repo, 'compA'), { recursive: true });
    const m = await loadManifest(manifestReq(repo));
    expect(m.diagnostics[0]?.code).toBe('V030_MANIFEST_MISSING');
    expect(m.exists).toBe(false);
  });

  it('stays silent when the manifest is absent and not required (a disabled component)', async () => {
    const repo = scratch();
    mkdirSync(join(repo, 'compA'), { recursive: true });
    const m = await loadManifest({ ...manifestReq(repo), required: false });
    expect(m.diagnostics).toEqual([]);
    expect(m.manifest).toBeNull();
  });

  it('rejects a .js manifest even where a sibling package.json says module', async () => {
    const repo = scratch();
    mkdirSync(join(repo, 'compA'), { recursive: true });
    writeFileSync(join(repo, 'compA', 'package.json'), JSON.stringify({ type: 'module' }));
    writeManifest(repo, 'compA', `export default { component: 'compa', producers: [] };`, '.js');
    const m = await loadManifest(manifestReq(repo));
    const d = m.diagnostics[0];
    expect(d?.code).toBe('V031_MANIFEST_NOT_MJS');
    expect(d?.file).toBe('compA/vibes/vibes.manifest.js');
    // One filename means two languages across this repo; .mjs is unambiguous.
    expect(d?.evidence.join(' ')).toMatch(/"type": module/);
  });

  it('busts the ESM cache on rewrite, so a second load sees the new bytes', async () => {
    const repo = scratch();
    writeManifest(repo, 'compA', `export default { component: 'compa', producers: [] };`);
    const first = await loadManifest(manifestReq(repo));
    expect(first.manifest?.witnesses).toBeUndefined();

    // Node's mtime resolution is coarse enough that a same-millisecond rewrite
    // would reuse the cached module; nudge the mtime explicitly.
    const p = join(repo, 'compA', 'vibes', 'vibes.manifest.mjs');
    writeFileSync(p, `export default { component: 'compa', producers: [], witnesses: ['src/**'] };`);
    const { utimesSync } = await import('node:fs');
    const later = new Date(Date.now() + 5_000);
    utimesSync(p, later, later);

    const second = await loadManifest(manifestReq(repo));
    expect(second.manifest?.witnesses).toEqual(['src/**']);
  });
});
