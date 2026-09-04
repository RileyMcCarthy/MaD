/**
 * What a producer touched OUTSIDE its received dir.
 *
 * The classification is stricter than a plain "did anything change" check
 * because of the received/accept split: a write into a COMMITTED baseline dir
 * is a violation whoever owns it. `git add -A` after a run must stage nothing
 * under a baseline — that property IS the accept step.
 */

import { describe, expect, test } from 'vitest';

import type { StatusEntry } from '../git/index.js';
import { classifyEscapes, dirtySubmodules, statusDelta, statusMap } from './escapes.js';

const entry = (path: string, index = ' ', worktree = 'M'): StatusEntry => ({
  path,
  index,
  worktree,
});

const OUT_REPOS = ['Software/Control/vibes/snapshots/domain', 'SIL/vibes/snapshots/trace'];

describe('status bracketing', () => {
  test('reports paths that appeared or changed, sorted, ignoring the unchanged', () => {
    const before = statusMap([entry('a.txt'), entry('same.txt', 'M', ' ')]);
    const after = statusMap([
      entry('z.txt', '?', '?'),
      entry('a.txt', 'M', 'M'),
      entry('same.txt', 'M', ' '),
    ]);
    expect(statusDelta(before, after)).toEqual([
      { path: 'a.txt', status: 'MM', before: ' M' },
      { path: 'z.txt', status: '??', before: null },
    ]);
  });

  test('a path that became clean again is not an escape', () => {
    // `git status` simply stops listing it, and a "disappeared from status"
    // signal is not evidence a producer wrote anything.
    const before = statusMap([entry('a.txt')]);
    expect(statusDelta(before, statusMap([]))).toEqual([]);
  });
});

describe('classification', () => {
  const ctx = { outRepos: OUT_REPOS, submodules: ['SIL/embsim', 'Protocol/ProtoEmb'] };

  test('a write into a COMMITTED baseline is a violation, own dir included', () => {
    const own = classifyEscapes(
      [{ path: 'Software/Control/vibes/snapshots/domain/a.json', status: ' M', before: null }],
      { ...ctx, ownOutRepo: 'Software/Control/vibes/snapshots/domain' },
    );
    expect(own[0]?.kind).toBe('baseline-write');
    // `vibes accept` is the only writer of a baseline. A producer that writes
    // there directly has re-created in-place snapshots, which deletes the review
    // step the whole design exists to preserve.
    expect(own[0]?.detail).toContain('$VIBES_OUT_DIR');

    const other = classifyEscapes(
      [{ path: 'SIL/vibes/snapshots/trace/x.csv', status: '??', before: null }],
      { ...ctx, ownOutRepo: 'Software/Control/vibes/snapshots/domain' },
    );
    expect(other[0]?.kind).toBe('baseline-write');
    expect(other[0]?.detail).toContain("another producer's");
  });

  test('a modified tracked file elsewhere is a mutated source', () => {
    const e = classifyEscapes([{ path: 'Software/Control/src/domain/gcode.ts', status: ' M', before: null }], ctx);
    expect(e[0]?.kind).toBe('mutated-source');
    // The run measured a tree it also changed, so nothing it reports is a
    // statement about the committed code.
    expect(e[0]?.detail).toContain('measured a tree it also changed');
  });

  test('a new untracked non-ignored file is a stray write', () => {
    const e = classifyEscapes([{ path: 'scratch/out.txt', status: '??', before: null }], ctx);
    expect(e[0]?.kind).toBe('stray-write');
  });

  test('a dirty gitlink names the inner command, because the outer status cannot', () => {
    const e = classifyEscapes([{ path: 'SIL/embsim', status: ' M', before: null }], ctx);
    expect(e[0]?.kind).toBe('submodule-dirty');
    // The superproject collapses ALL dirt inside a submodule into one ` M <sub>`
    // line, so a remedy that does not name `git -C` is unactionable.
    expect(e[0]?.detail).toContain('git -C SIL/embsim status');
  });

  test('.vibes/ is expected scratch and never an escape', () => {
    const e = classifyEscapes(
      [
        { path: '.vibes/received/control/domain/a.json', status: '??', before: null },
        { path: '.vibes/logs/control/domain.out.log', status: '??', before: null },
      ],
      ctx,
    );
    expect(e).toEqual([]);
  });

  test('dirt that predates the run is not attributed to the producer', () => {
    // Vibe-coded work is frequently uncommitted. Blaming a producer for the
    // author's own in-progress edits would make the tool unusable locally.
    const e = classifyEscapes([{ path: 'src/wip.ts', status: ' M', before: null }], {
      ...ctx,
      preexisting: new Set(['src/wip.ts']),
    });
    expect(e).toEqual([]);
  });

  test('a file directly at an out dir path is still inside it', () => {
    const e = classifyEscapes(
      [{ path: 'Software/Control/vibes/snapshots/domain', status: '??', before: null }],
      ctx,
    );
    expect(e[0]?.kind).toBe('baseline-write');
  });

  test('a sibling path that merely starts with an out dir name is NOT inside it', () => {
    const e = classifyEscapes(
      [{ path: 'Software/Control/vibes/snapshots/domain-extra/x', status: '??', before: null }],
      ctx,
    );
    expect(e[0]?.kind).toBe('stray-write');
  });
});

describe('dirtySubmodules', () => {
  test('lists only the declared submodules that are actually dirty', () => {
    const status: StatusEntry[] = [
      entry('SIL/embsim', ' ', 'M'),
      entry('Protocol/ProtoEmb', ' ', ' '),
      entry('src/other.ts', ' ', 'M'),
    ];
    expect(dirtySubmodules(status, ['SIL/embsim', 'Protocol/ProtoEmb'])).toEqual(['SIL/embsim']);
    expect(dirtySubmodules([], ['SIL/embsim'])).toEqual([]);
  });
});
