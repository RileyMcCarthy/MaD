import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNIFICANT_DIGITS,
  formatNumber,
  isTieAmbiguous,
  quantizeForOutput,
  roundSeriesToSignificantDigits,
  roundToSignificantDigits,
  TieMarginError,
} from './numeric.js';

/** Bit-level next/prev double — a real 1-ULP neighbour, not an approximation. */
function ulpStep(value: number, direction: 1 | -1): number {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const sign = value < 0 ? -1 : 1;
  const next = direction * sign > 0 ? bits + 1n : bits - 1n;
  view.setBigUint64(0, next);
  return view.getFloat64(0);
}

describe('roundToSignificantDigits', () => {
  it('collapses a real 1-ULP divergence across the Math.sin surface', () => {
    // THE measured cross-architecture hazard: Math.sin differs by 1 ULP between
    // arm64 and x64 on the same Node version. 12 significant digits must make
    // both sides emit the same text.
    let checked = 0;
    let ambiguous = 0;
    for (let i = 0; i < 2000; i++) {
      const v = Math.sin(i * 0.37);
      if (v === 0) continue;
      const neighbour = ulpStep(v, 1);
      if (isTieAmbiguous(v) || isTieAmbiguous(neighbour)) {
        ambiguous++;
        continue;
      }
      expect(roundToSignificantDigits(neighbour)).toBe(roundToSignificantDigits(v));
      checked++;
    }
    expect(checked).toBeGreaterThan(1900);
    // The guard should be rare enough to be usable, not a constant abort.
    expect(ambiguous).toBeLessThan(10);
  });

  it('aborts rather than emitting a coin-flip on a rounding boundary', () => {
    // Exactly halfway between two 12-significant-digit values.
    const onBoundary = 1.000000000005;
    expect(isTieAmbiguous(onBoundary)).toBe(true);
    expect(() => roundToSignificantDigits(onBoundary, 12, { label: 'force_mN' })).toThrow(
      TieMarginError,
    );
    try {
      roundToSignificantDigits(onBoundary, 12, { label: 'force_mN' });
    } catch (err) {
      expect(err).toBeInstanceOf(TieMarginError);
      const e = err as TieMarginError;
      expect(e.label).toBe('force_mN');
      expect(e.message).toContain('force_mN');
      expect(e.message).toContain('1.000000000005');
    }
  });

  it('quantization at a boundary would flip direction — which is why it aborts', () => {
    const onBoundary = 1.000000000005;
    const lower = ulpStep(onBoundary, -1);
    const upper = ulpStep(onBoundary, 1);
    // Two neighbours one ULP apart round to DIFFERENT 12-digit values here.
    expect(Number(lower.toPrecision(12))).not.toBe(Number(upper.toPrecision(12)));
  });

  it('leaves non-finite values and signed zero untouched', () => {
    expect(Number.isNaN(roundToSignificantDigits(Number.NaN))).toBe(true);
    expect(roundToSignificantDigits(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(Object.is(roundToSignificantDigits(-0), -0)).toBe(true);
    expect(Object.is(roundToSignificantDigits(0), 0)).toBe(true);
  });

  it('handles decade boundaries where Math.log10 is unreliable', () => {
    for (const v of [1, 10, 100, 1000, 0.1, 0.001, 1e-7, 1e21, -1000, 999.9999999999999]) {
      const rounded = roundToSignificantDigits(v, 12);
      expect(Number.isFinite(rounded)).toBe(true);
      expect(Math.abs(rounded - v)).toBeLessThanOrEqual(Math.abs(v) * 1e-11);
    }
  });

  it('rejects nonsense digit counts', () => {
    expect(() => roundToSignificantDigits(1.5, 0)).toThrow(RangeError);
    expect(() => roundToSignificantDigits(1.5, 18)).toThrow(RangeError);
    expect(() => roundToSignificantDigits(1.5, 2.5)).toThrow(RangeError);
  });

  it('actually rounds at the declared precision', () => {
    expect(roundToSignificantDigits(1.23456789012345, 12)).toBe(1.23456789012);
    expect(roundToSignificantDigits(123456789.012345, 6)).toBe(123457000);
    expect(DEFAULT_SIGNIFICANT_DIGITS).toBe(12);
  });

  it('labels the offending index when quantizing a series', () => {
    expect(roundSeriesToSignificantDigits([1.5, 2.5], 12)).toEqual([1.5, 2.5]);
    expect(() => roundSeriesToSignificantDigits([1, 1.000000000005], 12, { label: 'pos' })).toThrow(
      /pos\[1\]/,
    );
  });
});

describe('formatNumber / quantizeForOutput', () => {
  it('keeps -0, NaN and both infinities distinguishable', () => {
    expect(formatNumber(-0)).toBe('-0');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(Number.NaN)).toBe('NaN');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });

  it('emits identical text for 1-ULP neighbours', () => {
    const v = Math.sin(1.1);
    expect(quantizeForOutput(ulpStep(v, 1))).toBe(quantizeForOutput(v));
  });
});
