import { describe, expect, it } from 'vitest';
import { diffLedgers } from './diff.js';
import type { Behaviour } from './ledger.js';
import { renderMarkdown } from './report.js';

function row(over: {
  id: string;
  then: string;
  given?: string;
  why?: string;
  covers?: string;
  file?: string;
  status?: Behaviour['status'];
}): Behaviour {
  const b: Behaviour = {
    v: 1,
    id: over.id,
    suite: 'control',
    lang: 'ts',
    file: over.file ?? 'src/x.ts',
    test: 't',
    given: over.given ?? 'a situation',
    then: over.then,
    status: over.status ?? 'pass',
  };
  return {
    ...b,
    ...(over.why !== undefined ? { why: over.why } : {}),
    ...(over.covers !== undefined ? { covers: over.covers } : {}),
  };
}

describe('a respecification is a changed claim', () => {
  it('does not list a why-only rewrite as respecified', () => {
    const before = [
      row({
        id: 'gcode.comment-cannot-change-command',
        then: 'a rapid move to zero with a trailing comment naming a different move is still a rapid move to zero',
        why: 'the worst shape of the defect turned a rapid-to-zero into a full-speed move to a far target',
      }),
    ];
    const after = [
      row({
        id: 'gcode.comment-cannot-change-command',
        then: 'a rapid move to zero with a trailing comment naming a different move is still a rapid move to zero',
        why: 'a comment must never change where the crosshead goes',
      }),
    ];
    const d = diffLedgers(before, after);
    expect(d.respecified).toHaveLength(0);
    expect(d.unchanged).toBe(1);
    expect(renderMarkdown(d)).not.toContain('gcode.comment-cannot-change-command');
    expect(renderMarkdown(d)).not.toContain('also changed');
  });

  it('does not list a covers-only or file-only move as respecified', () => {
    const before = [
      row({ id: 'a', then: 'the machine stays disabled', covers: 'old.c#fn', file: 'test/old.c' }),
    ];
    const after = [
      row({ id: 'a', then: 'the machine stays disabled', covers: 'new.c#fn', file: 'test/new.c' }),
    ];
    const d = diffLedgers(before, after);
    expect(d.respecified).toHaveLength(0);
    expect(d.unchanged).toBe(1);
  });

  it('lists a changed claim with the old and new sentences, and nests a rewritten reason under because', () => {
    const before = [
      row({
        id: 'gcode.relative-moves-are-not-offset',
        then: 'a relative move is not offset by the gauge length, because it is a distance rather than a destination',
        why: 'old reason',
      }),
    ];
    const after = [
      row({
        id: 'gcode.relative-moves-are-not-offset',
        then: 'a relative move is not offset by the gauge length, because it states a distance to travel',
        why: 'new reason',
      }),
    ];
    const md = renderMarkdown(diffLedgers(before, after));
    expect(md).toContain('1 behaviour respecified');
    expect(md).toContain('was: **a relative move is not offset by the gauge length, because it is a distance rather than a destination**');
    expect(md).toContain('now: **a relative move is not offset by the gauge length, because it states a distance to travel**');
    expect(md).toContain('  - because:');
    expect(md).toContain('    - was: old reason');
    expect(md).toContain('    - now: new reason');
    expect(md).not.toMatch(/because was/);
    expect(md).not.toContain('also changed');
  });

  it('lists a changed scene the same way', () => {
    const d = diffLedgers(
      [row({ id: 'a', then: 'the machine stays disabled', given: 'old scene' })],
      [row({ id: 'a', then: 'the machine stays disabled', given: 'new scene' })],
    );
    expect(d.respecified).toHaveLength(1);
    expect(d.respecified[0]?.fields).toEqual(['given']);
    const md = renderMarkdown(d);
    expect(md).toContain('  - given:');
    expect(md).toContain('    - was: old scene');
    expect(md).toContain('    - now: new scene');
  });
});
