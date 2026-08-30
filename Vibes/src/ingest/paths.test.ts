import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createRelativizer, mapArtifactPath, toPosix } from './paths.js';

const temps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'vibes-paths-'));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('createRelativizer', () => {
  it('maps a path under the root and rejects one outside it', () => {
    const rel = createRelativizer('/repo');
    expect(rel('/repo/a/b.ts')).toBe('a/b.ts');
    expect(rel('/repo')).toBeNull(); // the root itself is not a path IN the repo
    expect(rel('/elsewhere/a.ts')).toBeNull();
  });

  it('resolves through a symlinked root — the real /tmp trap', () => {
    // On macOS /tmp is a symlink to /private/tmp, so a tool launched via one
    // form reports the other and a naive relative() calls every path foreign.
    const real = tmp();
    mkdirSync(join(real, 'src'), { recursive: true });
    writeFileSync(join(real, 'src', 'x.ts'), 'x');
    const linkDir = tmp();
    const link = join(linkDir, 'repo-link');
    symlinkSync(real, link);

    // Root given via the symlink, file reported by its real path.
    const viaLink = createRelativizer(link);
    expect(viaLink(join(realpathSync(real), 'src', 'x.ts'))).toBe('src/x.ts');

    // Root given by real path, file reported through the symlink.
    const viaReal = createRelativizer(real);
    expect(viaReal(join(link, 'src', 'x.ts'))).toBe('src/x.ts');
  });
});

describe('mapArtifactPath', () => {
  const relativize = createRelativizer('/repo');
  const base = { relativize, repoRoot: '/repo', anchorAbs: '/repo/Software/Control' };

  it('anchors a relative path at the declared source root', () => {
    expect(mapArtifactPath('src/a.ts', base)).toEqual({
      ok: true,
      path: 'Software/Control/src/a.ts',
      viaRepoRootFallback: false,
    });
  });

  it('makes an absolute path repo-relative', () => {
    expect(mapArtifactPath('/repo/Software/Control/src/a.ts', base)).toMatchObject({
      ok: true,
      path: 'Software/Control/src/a.ts',
    });
  });

  it('reports outside-repo rather than emitting a ../ escape', () => {
    expect(mapArtifactPath('/opt/x.ts', base)).toEqual({ ok: false, resolved: '/opt/x.ts', reason: 'outside-repo' });
  });

  it('uses the tracked set to disambiguate the double-prefix case', () => {
    const tracked = new Set(['Software/Control/src/a.ts']);
    expect(mapArtifactPath('Software/Control/src/a.ts', { ...base, trackedPaths: tracked })).toEqual({
      ok: true,
      path: 'Software/Control/src/a.ts',
      viaRepoRootFallback: true,
    });
  });

  it('refuses an untracked mapping instead of inventing a file', () => {
    const tracked = new Set(['Software/Control/src/a.ts']);
    expect(mapArtifactPath('src/ghost.ts', { ...base, trackedPaths: tracked })).toEqual({
      ok: false,
      resolved: 'Software/Control/src/ghost.ts',
      reason: 'untracked',
    });
  });

  it('rejects an empty path', () => {
    expect(mapArtifactPath('   ', base).ok).toBe(false);
  });
});

describe('toPosix', () => {
  it('is a no-op on POSIX separators', () => {
    expect(toPosix('a/b/c.ts')).toBe('a/b/c.ts');
  });
});
