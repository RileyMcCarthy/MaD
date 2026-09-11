/**
 * M1 — Unit-scale bible (parameterized).
 *
 * Guards silent ×1000 mismatches between engineering units (N, mm, s) and
 * wire/storage units (mN, µm, µs). Historical class: slope stored as N not mN.
 */
import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { decodeBinarySampleDataToCSV, parseTestCSV } from './sample';
import { encodeStoredSample, STOREDSAMPLE_WIRE_SIZE } from '@/protocol/generated/protoemb';

/** Pure conversions used at the sample CSV boundary (must stay consistent). */
export function forceNToMn(forceN: number): number {
  return Math.round(forceN * 1000);
}
export function forceMnToN(forceMn: number): number {
  return forceMn / 1000;
}
export function posMmToUm(mm: number): number {
  return Math.round(mm * 1000);
}
export function posUmToMm(um: number): number {
  return um / 1000;
}
export function timeSToUs(s: number): number {
  return Math.round(s * 1_000_000);
}
export function timeUsToS(us: number): number {
  return us / 1_000_000;
}

describe('M1 unit-scale matrix: pure conversions', () => {
  behaviour(
    {
      id: 'units.force-newtons-and-millinewtons',
      covers: 'src/domain/sample.ts#decodeBinarySampleDataToCSV',
      given: 'forces in newtons including zero, 1.5, negatives, and millinewton-scale values',
      then: 'a force in newtons converts to millinewtons by a factor of one thousand, and converting back recovers the original newtons',
    },
    () => {
      for (const { forceN, forceMn } of [
        { forceN: 0, forceMn: 0 },
        { forceN: 1.5, forceMn: 1500 },
        { forceN: -2, forceMn: -2000 },
        { forceN: 0.001, forceMn: 1 },
        { forceN: -0.001, forceMn: -1 },
        { forceN: 123.456, forceMn: 123456 },
        { forceN: 50, forceMn: 50000 },
      ]) {
        expect(forceNToMn(forceN)).toBe(forceMn);
        expect(forceMnToN(forceMn)).toBeCloseTo(forceN, 6);
        // Round-trip engineering → raw → engineering
        expect(forceMnToN(forceNToMn(forceN))).toBeCloseTo(forceN, 3);
      }
    },
  );

  behaviour(
    {
      id: 'units.position-millimetres-and-micrometres',
      covers: 'src/domain/sample.ts#decodeBinarySampleDataToCSV',
      given: 'positions in millimetres including zero, 10.25, negatives, and micrometre-scale values',
      then: 'a position in millimetres converts to micrometres by a factor of one thousand, and converting back recovers the original millimetres',
    },
    () => {
      for (const { mm, um } of [
        { mm: 0, um: 0 },
        { mm: 10.25, um: 10250 },
        { mm: -0.001, um: -1 },
        { mm: 0.001, um: 1 },
        { mm: 100, um: 100000 },
        { mm: -50.5, um: -50500 },
      ]) {
        expect(posMmToUm(mm)).toBe(um);
        expect(posUmToMm(um)).toBeCloseTo(mm, 6);
        expect(posUmToMm(posMmToUm(mm))).toBeCloseTo(mm, 3);
      }
    },
  );

  behaviour(
    {
      id: 'units.time-seconds-and-microseconds',
      covers: 'src/domain/sample.ts#parseTestCSV',
      given: 'times in seconds including zero, one, one half, and two and a half',
      then: 'a time in seconds converts to microseconds by a factor of one million, and converting back recovers the original seconds',
    },
    () => {
      for (const { s, us } of [
        { s: 0, us: 0 },
        { s: 1, us: 1_000_000 },
        { s: 0.5, us: 500_000 },
        { s: 2.5, us: 2_500_000 },
      ]) {
        expect(timeSToUs(s)).toBe(us);
        expect(timeUsToS(us)).toBeCloseTo(s, 9);
      }
    },
  );

  behaviour(
    {
      id: 'units.stored-force-is-newtons',
      covers: 'src/domain/sample.ts#decodeBinarySampleDataToCSV',
      given: 'a stored sample whose force field is 1.5 newtons',
      then: 'a stored force of 1.5 newtons is written as 1500 millinewtons in the CSV',
      why: 'the stored-sample force field is newtons; the CSV force column is millinewtons',
    },
    () => {
      // If someone stores force already in mN into a field documented as N,
      // encodeStoredSample(force: 1500) would become 1_500_000 mN in CSV.
      const csv = decodeBinarySampleDataToCSV(
        encodeStoredSample({ force: 1.5, position: 0, time: 0, setpoint: 0 }),
      );
      const row = csv.trim().split('\n')[1];
      const forceMn = Number(row.split(',')[1]);
      expect(forceMn).toBe(1500);
      expect(Math.abs(forceMn)).toBeLessThan(100_000); // sane test-scale force
    },
  );
});

describe('M1 unit-scale matrix: StoredSample → CSV → engineering', () => {
  behaviour(
    {
      id: 'units.sample-round-trips-engineering-units',
      covers: 'src/domain/sample.ts#parseTestCSV',
      given: 'stored samples across zero, positive, negative, and millinewton-scale force and position',
      then: 'a stored sample round-trips through CSV back to the original newtons, millimetres, and seconds',
    },
    () => {
      for (const { forceN, posMm, setMm, timeUs } of [
        { forceN: 0, posMm: 0, setMm: 0, timeUs: 0 },
        { forceN: 1.5, posMm: 10.25, setMm: 10, timeUs: 1000 },
        { forceN: -2, posMm: 11, setMm: 11, timeUs: 2_000_000 },
        { forceN: 0.001, posMm: 0.001, setMm: 0, timeUs: 500_000 },
        { forceN: 100, posMm: -3.5, setMm: -3.5, timeUs: 10_000 },
      ]) {
        const buf = encodeStoredSample({
          force: forceN,
          position: posMm,
          time: timeUs,
          setpoint: setMm,
        });
        expect(buf.length).toBe(STOREDSAMPLE_WIRE_SIZE);
        const csv = decodeBinarySampleDataToCSV(buf);
        expect(csv.startsWith('time_us,force_mN,position_um,setpoint_um')).toBe(true);
        const pts = parseTestCSV(csv);
        expect(pts).toHaveLength(1);
        expect(pts[0].forceN).toBeCloseTo(forceN, 3);
        expect(pts[0].positionMm).toBeCloseTo(posMm, 3);
        expect(pts[0].setpointMm).toBeCloseTo(setMm, 3);
        expect(pts[0].timeS).toBeCloseTo(timeUs / 1e6, 6);
      }
    },
  );
});
