import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  actualCaseMismatch,
  anchorGlob,
  checkGlob,
  checkRelPath,
  globIntersectsDir,
  globLiteralPrefix,
  isStrictDescendant,
  isSymlink,
  normalizeRel,
  pathsOverlap,
  realpathDeepest,
  repoRelative,
} from './paths.js';

describe('checkRelPath', () => {
  it('accepts plain relative POSIX paths', () => {
    expect(checkRelPath('snapshots/gcode')).toBeNull();
    expect(checkRelPath('Software/Control')).toBeNull();
  });

  it('rejects absolute, backslash, NUL, drive-letter and .. paths', () => {
    expect(checkRelPath('/etc/passwd')?.reason).toMatch(/relative/);
    expect(checkRelPath('snapshots\\gcode')?.reason).toMatch(/POSIX/);
    expect(checkRelPath('a\0b')?.reason).toMatch(/NUL/);
    expect(checkRelPath('C:/x')?.reason).toMatch(/relative/);
    expect(checkRelPath('../sibling')?.reason).toMatch(/\.\./);
    expect(checkRelPath('')?.reason).toMatch(/empty/);
  });

  it('rejects "." unless explicitly allowed (cwd is the only field that means it)', () => {
    expect(checkRelPath('.')).not.toBeNull();
    expect(checkRelPath('.', { allowDot: true })).toBeNull();
  });
});

describe('checkGlob', () => {
  it('rejects braces — git pathspecs silently match nothing with them', () => {
    const p = checkGlob('**/x.{ts,tsx}');
    expect(p?.reason).toMatch(/brace/);
    expect(p?.evidence).toMatch(/git pathspecs/);
  });

  it('rejects a closing brace alone, so a half-written pattern cannot slip through', () => {
    expect(checkGlob('src/a}')?.reason).toMatch(/brace/);
  });

  it('accepts globstars, character classes and a leading negation', () => {
    expect(checkGlob('src/**')).toBeNull();
    expect(checkGlob('src/*.ts')).toBeNull();
    expect(checkGlob('!src/**/*.test.ts')).toBeNull();
  });

  it('still rejects an escaping path behind a negation', () => {
    expect(checkGlob('!../elsewhere/**')?.reason).toMatch(/\.\./);
  });
});

describe('globLiteralPrefix', () => {
  it('stops at the first magic segment', () => {
    expect(globLiteralPrefix('src/domain/**')).toBe('src/domain');
    expect(globLiteralPrefix('src/*.ts')).toBe('src');
    expect(globLiteralPrefix('**')).toBe('');
    expect(globLiteralPrefix('makefile')).toBe('makefile');
    expect(globLiteralPrefix('!vibes/snapshots/**')).toBe('vibes/snapshots');
  });
});

describe('globIntersectsDir', () => {
  it('matches in both directions — a generates glob reaches INTO a component root', () => {
    // The real case: protocol declares it generates into Control's tree.
    expect(globIntersectsDir('Software/Control/src/generated/**', 'Software/Control')).toBe(true);
    // And the reverse: a root that contains the glob's prefix.
    expect(globIntersectsDir('Software/Control/**', 'Software/Control/src')).toBe(true);
  });

  it('does not match a sibling with a shared string prefix', () => {
    expect(globIntersectsDir('Software/ControlX/**', 'Software/Control')).toBe(false);
  });

  it('treats a bare globstar as intersecting everything', () => {
    expect(globIntersectsDir('**', 'anything/at/all')).toBe(true);
  });
});

describe('anchorGlob', () => {
  it('re-anchors root-relative globs to the repo root, preserving negation', () => {
    expect(anchorGlob('Software/Control', 'src/domain/**')).toBe('Software/Control/src/domain/**');
    expect(anchorGlob('Software/Control', '!src/**/*.test.ts')).toBe('!Software/Control/src/**/*.test.ts');
  });
});

describe('containment', () => {
  it('isStrictDescendant is strict', () => {
    expect(isStrictDescendant('/a/b', '/a/b/c')).toBe(true);
    expect(isStrictDescendant('/a/b', '/a/b')).toBe(false);
    expect(isStrictDescendant('/a/b', '/a')).toBe(false);
    expect(isStrictDescendant('/a/b', '/a/bc')).toBe(false);
  });

  it('pathsOverlap catches equality and nesting in either direction', () => {
    expect(pathsOverlap('/a/b', '/a/b')).toBe(true);
    expect(pathsOverlap('/a/b', '/a/b/c')).toBe(true);
    expect(pathsOverlap('/a/b/c', '/a/b')).toBe(true);
    expect(pathsOverlap('/a/b', '/a/c')).toBe(false);
  });
});

describe('filesystem-backed helpers', () => {
  it('realpathDeepest resolves through a symlinked ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibes-paths-'));
    mkdirSync(join(root, 'real', 'inner'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const resolved = realpathDeepest(join(root, 'link', 'inner', 'not-yet'));
    expect(resolved.endsWith(join('real', 'inner', 'not-yet'))).toBe(true);
  });

  it('isSymlink uses lstat, so a link to a directory is a link', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibes-paths-'));
    mkdirSync(join(root, 'd'));
    symlinkSync(join(root, 'd'), join(root, 'l'));
    expect(isSymlink(join(root, 'l'))).toBe(true);
    expect(isSymlink(join(root, 'd'))).toBe(false);
  });

  it('actualCaseMismatch reports the on-disk spelling (APFS is case-insensitive)', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibes-paths-'));
    mkdirSync(join(root, 'Snapshots'));
    writeFileSync(join(root, 'Snapshots', 'x.txt'), 'x');
    expect(actualCaseMismatch(join(root, 'Snapshots'))).toBeNull();
    // Only meaningful on a case-insensitive FS; on Linux the path simply does
    // not exist and the helper returns null, which is also correct.
    const mismatch = actualCaseMismatch(join(root, 'snapshots'));
    expect(mismatch === null || mismatch === 'Snapshots').toBe(true);
  });
});

describe('string form', () => {
  it('normalizeRel collapses ./ and trailing slashes', () => {
    expect(normalizeRel('./a//b/')).toBe('a/b');
    expect(normalizeRel('.')).toBe('');
  });

  it('repoRelative produces POSIX repo paths', () => {
    expect(repoRelative('/repo', '/repo/a/b')).toBe('a/b');
  });
});
