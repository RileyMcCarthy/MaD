import { describe, expect, test } from 'vitest';

import { parseAcceptArgs } from './args.js';
import { acceptModeOf, acceptedByOf } from './model.js';

describe('parseAcceptArgs', () => {
  test('an unknown flag is an ERROR, never a positional', () => {
    // The hazard this exists for: `--acceptdeletions=3` silently becoming a
    // producer selector is how an unauthorised deletion gets authorised.
    const r = parseAcceptArgs(['--acceptdeletions=3']);
    expect(r.errors).toEqual(['unknown flag --acceptdeletions=3']);
    expect(r.options.producers).toEqual([]);
  });

  test('--all implies --yes, because it bypasses the per-file offer', () => {
    const r = parseAcceptArgs(['--all', '--reason', 'x']);
    expect(r.options.all).toBe(true);
    expect(r.options.yes).toBe(true);
    expect(acceptModeOf(r.options)).toBe('bulk');
    expect(acceptedByOf(r.options)).toBe('--all');
  });

  test('--yes alone records acceptedBy --yes', () => {
    const r = parseAcceptArgs(['-y']);
    expect(r.options.yes).toBe(true);
    expect(r.options.all).toBe(false);
    expect(acceptedByOf(r.options)).toBe('--yes');
    expect(acceptModeOf(r.options)).toBe('bulk');
  });

  test('a bare invocation is reviewed/cli', () => {
    const r = parseAcceptArgs([]);
    expect(acceptModeOf(r.options)).toBe('reviewed');
    expect(acceptedByOf(r.options)).toBe('cli');
    expect(r.errors).toEqual([]);
  });

  test('--bootstrap outranks --yes in the recorded mode', () => {
    const r = parseAcceptArgs(['--bootstrap', '--yes', '--reason', 'adopting']);
    expect(acceptModeOf(r.options)).toBe('bootstrap');
    expect(acceptedByOf(r.options)).toBe('--yes');
  });

  test('--accept-deletions demands a clean integer', () => {
    expect(parseAcceptArgs(['--accept-deletions=3']).options.acceptDeletions).toBe(3);
    expect(parseAcceptArgs(['--accept-deletions', '0']).options.acceptDeletions).toBe(0);
    const bad = parseAcceptArgs(['--accept-deletions=3x']);
    expect(bad.options.acceptDeletions).toBeNull();
    expect(bad.errors[0]).toContain('non-negative integer');
    const neg = parseAcceptArgs(['--accept-deletions=-1']);
    expect(neg.errors.length).toBe(1);
  });

  test('a value flag with no value errors instead of eating the next flag', () => {
    const r = parseAcceptArgs(['--reason', '--yes']);
    expect(r.errors).toEqual(['--reason requires a value']);
    // and --yes is still parsed, so the operator sees every problem at once
    expect(r.options.yes).toBe(true);
  });

  test('repeated --reason concatenates rather than silently keeping the last', () => {
    const r = parseAcceptArgs(['--reason', 'epsilon widened', '--reason', 'see #412']);
    expect(r.options.reason).toBe('epsilon widened see #412');
  });

  test('--component and --producer are repeatable; positionals are producers', () => {
    const r = parseAcceptArgs([
      '--component', 'control',
      '--component', 'sil',
      '--producer', 'control/domain',
      'firmware/trace',
    ]);
    expect(r.options.components).toEqual(['control', 'sil']);
    expect(r.options.producers).toEqual(['control/domain', 'firmware/trace']);
  });

  test('everything after -- is a selector, even if it looks like a flag', () => {
    const r = parseAcceptArgs(['--', '--weird-name']);
    expect(r.options.producers).toEqual(['--weird-name']);
    expect(r.errors).toEqual([]);
  });

  test('a boolean flag given a value is an error, not a silent truthy', () => {
    const r = parseAcceptArgs(['--yes=false']);
    expect(r.errors).toEqual(['--yes takes no value']);
    // Loud: `--yes=false` reading as "yes" would be the worst possible default.
    expect(r.options.yes).toBe(true);
  });

  test('--help is reported without inventing selections', () => {
    const r = parseAcceptArgs(['--help']);
    expect(r.help).toBe(true);
    expect(r.options.producers).toEqual([]);
  });
});
