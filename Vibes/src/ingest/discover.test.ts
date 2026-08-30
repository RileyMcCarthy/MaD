import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globFiles } from './discover.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vibes-discover-'));
  mkdirSync(join(root, 'vibes', 'artifacts'), { recursive: true });
  mkdirSync(join(root, 'vibes', 'artifacts', 'nested'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, '.hidden'), { recursive: true });
  writeFileSync(join(root, 'vibes', 'artifacts', 'b.xml'), '<b/>');
  writeFileSync(join(root, 'vibes', 'artifacts', 'a.xml'), '<a/>');
  writeFileSync(join(root, 'vibes', 'artifacts', 'notes.txt'), 'x');
  writeFileSync(join(root, 'vibes', 'artifacts', 'nested', 'c.xml'), '<c/>');
  writeFileSync(join(root, 'node_modules', 'pkg', 'evil.xml'), '<evil/>');
  writeFileSync(join(root, '.hidden', 'h.xml'), '<h/>');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const names = (files: readonly { absPath: string }[]): string[] =>
  files.map((f) => f.absPath.slice(root.length + 1));

describe('globFiles', () => {
  it('resolves a literal path with no globbing at all', async () => {
    const found = await globFiles(root, 'vibes/artifacts/a.xml');
    expect(names(found)).toEqual(['vibes/artifacts/a.xml']);
  });

  it('returns nothing (not an error) for a literal path that does not exist', async () => {
    expect(await globFiles(root, 'vibes/artifacts/missing.xml')).toEqual([]);
  });

  it('matches a single-star glob without descending', async () => {
    const found = await globFiles(root, 'vibes/artifacts/*.xml');
    expect(names(found)).toEqual(['vibes/artifacts/a.xml', 'vibes/artifacts/b.xml']);
  });

  it('sorts bytewise so two runs merge artifacts in the same order', async () => {
    const found = await globFiles(root, 'vibes/**/*.xml');
    expect(names(found)).toEqual([
      'vibes/artifacts/a.xml',
      'vibes/artifacts/b.xml',
      'vibes/artifacts/nested/c.xml',
    ]);
  });

  it('skips node_modules unless the glob names it explicitly', async () => {
    expect(names(await globFiles(root, '**/*.xml'))).not.toContain('node_modules/pkg/evil.xml');
    expect(names(await globFiles(root, 'node_modules/**/*.xml'))).toEqual(['node_modules/pkg/evil.xml']);
  });

  it('does not match dotfile directories implicitly', async () => {
    expect(names(await globFiles(root, '**/*.xml'))).not.toContain('.hidden/h.xml');
  });

  it('treats braces as literal, matching nothing — git pathspecs behave the same way', async () => {
    // A brace pattern that worked here and silently matched nothing in a git
    // pathspec would be the worst kind of inconsistency, so both refuse.
    expect(await globFiles(root, 'vibes/artifacts/*.{xml,json}')).toEqual([]);
  });

  it('reports size and mtime for staleness decisions', async () => {
    const stamp = new Date('2020-01-02T03:04:05Z');
    utimesSync(join(root, 'vibes', 'artifacts', 'a.xml'), stamp, stamp);
    const [file] = await globFiles(root, 'vibes/artifacts/a.xml');
    expect(file?.bytes).toBe(4);
    expect(file?.mtimeMs).toBe(stamp.getTime());
  });

  it('follows a symlinked FILE (CI stages reports that way) but not a symlinked DIR', async () => {
    const linkFile = join(root, 'vibes', 'artifacts', 'linked.xml');
    symlinkSync(join(root, 'vibes', 'artifacts', 'a.xml'), linkFile);
    const linkDir = join(root, 'vibes', 'linkdir');
    symlinkSync(join(root, 'vibes', 'artifacts'), linkDir);

    const found = names(await globFiles(root, 'vibes/**/*.xml'));
    expect(found).toContain('vibes/artifacts/linked.xml');
    expect(found.some((f) => f.startsWith('vibes/linkdir/'))).toBe(false);
  });

  it('refuses to walk an unbounded tree instead of hanging', async () => {
    await expect(globFiles(root, '**/*.xml', { maxEntries: 1 })).rejects.toThrow(/walked more than 1 entries/);
  });

  it('accepts an absolute glob', async () => {
    // Runs after the symlink test, so linked.xml is present too.
    const found = await globFiles(root, join(root, 'vibes/artifacts/*.xml'));
    expect(names(found)).toEqual([
      'vibes/artifacts/a.xml',
      'vibes/artifacts/b.xml',
      'vibes/artifacts/linked.xml',
    ]);
  });
});
