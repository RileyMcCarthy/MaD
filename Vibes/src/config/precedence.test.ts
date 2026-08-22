import { describe, expect, it } from 'vitest';

import type { Producer, SharedDefaults } from '../types.js';
import { BUILTIN_DEFAULTS } from './constants.js';
import { applyProducer, mergeDefaults, mergeEnv, raiseRunWhen } from './precedence.js';

const producer = (over: Partial<Producer> = {}): Producer => ({
  name: 'p',
  cmd: 'true',
  out: 'snapshots/p',
  ...over,
});

describe('mergeDefaults', () => {
  it('walks builtin → root → manifest, most specific winning', () => {
    const root: SharedDefaults = { timeoutMs: 60_000, runWhen: 'always' };
    const manifest: SharedDefaults = { timeoutMs: 90_000 };
    const eff = mergeDefaults([root, manifest]);
    expect(eff.timeoutMs).toBe(90_000);
    expect(eff.runWhen).toBe('always'); // manifest did not touch it
    expect(eff.clean).toBe(BUILTIN_DEFAULTS.clean);
  });

  it('skips undefined layers instead of resetting to the builtin', () => {
    const eff = mergeDefaults([{ timeoutMs: 5_000 }, undefined]);
    expect(eff.timeoutMs).toBe(5_000);
  });

  it('replaces compare wholesale — a half-merged CompareSpec is unreadable', () => {
    const root: SharedDefaults = {
      compare: [{ match: '**/*.csv', use: { kind: 'tolerance', rel: 1e-9, reason: 'float text' } }],
    };
    const manifest: SharedDefaults = { compare: { kind: 'exact' } };
    expect(mergeDefaults([root, manifest]).compare).toEqual({ kind: 'exact' });
  });
});

describe('mergeEnv', () => {
  it('merges key-by-key at every step', () => {
    expect(mergeEnv({ A: '1', B: '2' }, { B: '3', C: '4' })).toEqual({ A: '1', B: '3', C: '4' });
  });

  it('keeps null as a value — it means "unset in the child", not "absent"', () => {
    const merged = mergeEnv({ ELECTRON_RUN_AS_NODE: '1' }, { ELECTRON_RUN_AS_NODE: null });
    expect(merged['ELECTRON_RUN_AS_NODE']).toBeNull();
    expect(Object.hasOwn(merged, 'ELECTRON_RUN_AS_NODE')).toBe(true);
  });
});

describe('applyProducer', () => {
  it('lets the producer beat both defaults layers', () => {
    const base = mergeDefaults([{ timeoutMs: 60_000 }, { timeoutMs: 90_000 }]);
    const eff = applyProducer(base, producer({ timeoutMs: 120_000 }));
    expect(eff.timeoutMs).toBe(120_000);
  });

  it('merges env across all three layers rather than replacing it', () => {
    const base = mergeDefaults([{ env: { TZ: 'UTC' } }, { env: { RUST_BACKTRACE: '1' } }]);
    const eff = applyProducer(base, producer({ env: { TZ: 'America/Denver' } }));
    expect(eff.env).toEqual({ TZ: 'America/Denver', RUST_BACKTRACE: '1' });
  });

  it('leaves untouched keys at the inherited value', () => {
    const base = mergeDefaults([{ runWhen: 'always', clean: false }]);
    const eff = applyProducer(base, producer());
    expect(eff.runWhen).toBe('always');
    expect(eff.clean).toBe(false);
  });

  it('renderer defaults to null, not the empty string', () => {
    expect(applyProducer(mergeDefaults([]), producer()).renderer).toBeNull();
    expect(applyProducer(mergeDefaults([]), producer({ renderer: 'gcode' })).renderer).toBe('gcode');
  });
});

describe('raiseRunWhen', () => {
  it('an author may raise to always but never lower below what Vibes computed', () => {
    expect(raiseRunWhen('changed', true)).toBe('always');
    expect(raiseRunWhen('always', true)).toBe('always');
    expect(raiseRunWhen('changed', false)).toBe('changed');
    expect(raiseRunWhen('always', false)).toBe('always');
  });
});
