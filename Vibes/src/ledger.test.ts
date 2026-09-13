/**
 * Numbering is the one part of the ledger a reader is invited to cite, so the
 * properties that make a citation trustworthy are tested directly: a number
 * never moves, and a number is never handed to a second behaviour.
 */

import { describe, expect, it } from 'vitest';
import { assignNumbers, handle, key, type Behaviour } from './ledger.js';

function b(id: string, over: Partial<Behaviour> = {}): Behaviour {
  return {
    v: 2, num: 0, id, expect: 'holds', suite: 'control', lang: 'ts',
    file: 'src/x.test.ts', test: id, given: 'g', then: 't', status: 'pass',
    ...over,
  };
}

const nums = (bs: readonly Behaviour[]) => Object.fromEntries(bs.map((x) => [key(x), x.num]));

describe('behaviour numbering', () => {
  it('numbers a fresh ledger from one, in suite/id order', () => {
    const { numbered, highWater } = assignNumbers([], [b('beta'), b('alpha')], 0);
    expect(nums(numbered)).toEqual({ 'control/alpha/holds': 1, 'control/beta/holds': 2 });
    expect(highWater).toBe(2);
  });

  it('keeps every existing number when a behaviour is added ahead of it alphabetically', () => {
    const first = assignNumbers([], [b('middle'), b('zulu')], 0).numbered;
    const second = assignNumbers(first, [b('aaa'), b('middle'), b('zulu')], 2).numbered;
    // The new one sorts first but must NOT take number 1.
    expect(nums(second)).toEqual({ 'control/middle/holds': 1, 'control/zulu/holds': 2, 'control/aaa/holds': 3 });
  });

  it('never reuses the number of a deleted behaviour', () => {
    const first = assignNumbers([], [b('alpha'), b('beta')], 0);
    expect(first.highWater).toBe(2);
    // beta is deleted, then a new behaviour arrives.
    const afterDelete = assignNumbers(first.numbered, [b('alpha')], first.highWater);
    expect(afterDelete.highWater).toBe(2);
    const withNew = assignNumbers(afterDelete.numbered, [b('alpha'), b('gamma')], afterDelete.highWater);
    expect(nums(withNew.numbered)['control/gamma/holds']).toBe(3);
  });

  it('is stable across repeated runs on the same tree', () => {
    const once = assignNumbers([], [b('a'), b('b'), b('c')], 0);
    const twice = assignNumbers(once.numbered, [b('c'), b('a'), b('b')], once.highWater);
    expect(nums(twice.numbered)).toEqual(nums(once.numbered));
    expect(twice.highWater).toBe(once.highWater);
  });

  it('gives each expectation of one test its own number', () => {
    const { numbered } = assignNumbers([], [b('t'), b('t', { expect: 'second' })], 0);
    expect(new Set(numbered.map((x) => x.num)).size).toBe(2);
  });

  it('keeps an expectation number when a sibling expectation is added', () => {
    const first = assignNumbers([], [b('t', { expect: 'zzz' })], 0);
    const second = assignNumbers(first.numbered, [b('t', { expect: 'aaa' }), b('t', { expect: 'zzz' })], first.highWater);
    expect(nums(second.numbered)['control/t/zzz']).toBe(1);
    expect(nums(second.numbered)['control/t/aaa']).toBe(2);
  });

  it('gives the same id in two suites its own number', () => {
    const { numbered } = assignNumbers([], [b('shared'), b('shared', { suite: 'firmware' })], 0);
    const seen = numbered.map((x) => x.num);
    expect(new Set(seen).size).toBe(2);
  });

  it('assigns numbers to a ledger written before numbering existed', () => {
    const legacy = [{ ...b('old'), num: undefined as unknown as number }];
    const { numbered } = assignNumbers(legacy, [b('old'), b('new')], 0);
    expect(numbered.every((x) => x.num > 0)).toBe(true);
    expect(new Set(numbered.map((x) => x.num)).size).toBe(2);
  });

  it('cites a behaviour as BH-n', () => {
    expect(handle(b('x', { num: 42 }))).toBe('BH-42');
  });
});
