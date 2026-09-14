import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  decodeBinarySampleDataToCSV,
  interpolateAtUs,
  motionStartTimeUs,
  parseTestCSV,
} from './sample';
import { encodeStoredSample, STOREDSAMPLE_WIRE_SIZE } from '@/protocol/generated/protoemb';

describe('decodeBinarySampleDataToCSV', () => {
  behaviour(
    {
      id: 'sample.binary-decodes-to-raw-csv',
      covers: 'src/domain/sample.ts#decodeBinarySampleDataToCSV',
      given: 'two stored samples, one at 1.5 N and 10.25 mm, one at -2 N and 11 mm',
      expect: {
        'header-row': 'the CSV opens with a header naming the time, force, position and setpoint columns',
        'scaled-rows':
          'each sample decodes to a CSV row in microseconds, millinewtons and micrometres, scaling force and position by a thousand',
      },
    },
    () => {
      const a = encodeStoredSample({ force: 1.5, position: 10.25, time: 1000, setpoint: 10 });
      const b = encodeStoredSample({ force: -2.0, position: 11.0, time: 2000, setpoint: 11 });
      const buf = new Uint8Array(STOREDSAMPLE_WIRE_SIZE * 2);
      buf.set(a, 0);
      buf.set(b, STOREDSAMPLE_WIRE_SIZE);

      const csv = decodeBinarySampleDataToCSV(buf);
      const lines = csv.trim().split('\n');
      expect(lines[0]).toBe('time_us,force_mN,position_nm,setpoint_nm');
      // row 1: time 1000, force 1.5 N → 1500 mN, position 10.25 mm → 10,250,000 nm
      expect(lines[1]).toBe('1000,1500,10250000,10000000');
      expect(lines[2]).toBe('2000,-2000,11000000,11000000');
    },
  );
});

describe('parseTestCSV', () => {
  behaviour(
    {
      id: 'sample.csv-parses-to-engineering-units',
      covers: 'src/domain/sample.ts#parseTestCSV',
      given: 'a CSV row of 1000000 microseconds, 1500 millinewtons, and 10250000 nanometres',
      expect: {
        'one-reading': 'exactly one reading comes back',
        'engineering-units': 'the reading is 1 s, 1.5 N, and 10.25 mm',
      },
    },
    () => {
      const csv = 'time_us,force_mN,position_nm,setpoint_nm\n1000000,1500,10250000,10000000\n';
      const pts = parseTestCSV(csv);
      expect(pts).toHaveLength(1);
      expect(pts[0].timeS).toBeCloseTo(1, 6);
      expect(pts[0].forceN).toBeCloseTo(1.5, 6);
      expect(pts[0].positionMm).toBeCloseTo(10.25, 6);
      expect(pts[0].setpointMm).toBeCloseTo(10, 6);
    },
  );

  behaviour(
    {
      id: 'sample.csv-skips-malformed-rows',
      covers: 'src/domain/sample.ts#parseTestCSV',
      given: 'a CSV with a header, a malformed row, and one valid row',
      expect: { 'only-valid-row': 'parsing returns only the valid row' },
    },
    () => {
      const csv = 'time_us,force_mN,position_nm,setpoint_nm\nbad,row\n0,0,0,0\n';
      expect(parseTestCSV(csv)).toHaveLength(1);
    },
  );
});

describe('interpolateAtUs', () => {
  const t = [0, 100_000, 200_000];
  const x = [0, 1000, 2000];

  behaviour(
    {
      id: 'sample.interpolate-at-recorded-time',
      covers: 'src/domain/sample.ts#interpolateAtUs',
      given: 'a recorded series and a timestamp that matches a sample exactly',
      expect: { 'sample-value': 'the interpolated result is that sample\'s own value' },
    },
    () => {
      expect(interpolateAtUs(t, x, 100_000)).toBe(1000);
    },
  );

  behaviour(
    {
      id: 'sample.interpolate-between-samples',
      covers: 'src/domain/sample.ts#interpolateAtUs',
      given: 'a recorded series and timestamps halfway between samples',
      expect: {
        'halfway-value': 'the interpolated result is halfway between the two neighbouring sample values',
      },
    },
    () => {
      expect(interpolateAtUs(t, x, 50_000)).toBe(500);
      expect(interpolateAtUs(t, x, 150_000)).toBe(1500);
    },
  );

  behaviour(
    {
      id: 'sample.interpolate-outside-span',
      covers: 'src/domain/sample.ts#interpolateAtUs',
      given: 'a timestamp before the first sample, after the last, or an empty series',
      expect: { 'no-value': 'no interpolated value is produced' },
    },
    () => {
      expect(interpolateAtUs(t, x, -1)).toBeUndefined();
      expect(interpolateAtUs(t, x, 200_001)).toBeUndefined();
      expect(interpolateAtUs([], [], 0)).toBeUndefined();
    },
  );
});

describe('motionStartTimeUs', () => {
  behaviour(
    {
      id: 'sample.motion-starts-at-first-move',
      covers: 'src/domain/sample.ts#motionStartTimeUs',
      given: 'a position series that stays put for two samples then moves well past the threshold',
      expect: {
        'first-sample-past-threshold':
          'motion start is reported at the time of the first sample past the threshold',
      },
    },
    () => {
      const t = [1_000_000, 1_010_000, 1_020_000, 1_030_000];
      const p = [100, 100, 200, 400];
      expect(motionStartTimeUs(t, p, 80)).toBe(1_020_000);
    },
  );

  behaviour(
    {
      id: 'sample.motion-start-when-still',
      covers: 'src/domain/sample.ts#motionStartTimeUs',
      given: 'a position series that never leaves the opening position',
      expect: { 'no-start-time': 'no motion-start time is reported' },
    },
    () => {
      expect(motionStartTimeUs([0, 100], [10, 10], 80)).toBeUndefined();
    },
  );
});
