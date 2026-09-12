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
      then: 'stored samples decode to CSV rows in microseconds, millinewtons, and micrometres, with 1.5 N written as 1500 millinewtons and 10.25 mm as 10250 micrometres',
    },
    () => {
      const a = encodeStoredSample({ force: 1.5, position: 10.25, time: 1000, setpoint: 10 });
      const b = encodeStoredSample({ force: -2.0, position: 11.0, time: 2000, setpoint: 11 });
      const buf = new Uint8Array(STOREDSAMPLE_WIRE_SIZE * 2);
      buf.set(a, 0);
      buf.set(b, STOREDSAMPLE_WIRE_SIZE);

      const csv = decodeBinarySampleDataToCSV(buf);
      const lines = csv.trim().split('\n');
      expect(lines[0]).toBe('time_us,force_mN,position_um,setpoint_um');
      // row 1: time 1000, force 1.5 N → 1500 mN, position 10.25 mm → 10250 µm
      expect(lines[1]).toBe('1000,1500,10250,10000');
      expect(lines[2]).toBe('2000,-2000,11000,11000');
    },
  );
});

describe('parseTestCSV', () => {
  behaviour(
    {
      id: 'sample.csv-parses-to-engineering-units',
      covers: 'src/domain/sample.ts#parseTestCSV',
      given: 'a CSV row of 1000000 microseconds, 1500 millinewtons, and 10250 micrometres',
      then: 'a CSV row in microseconds, millinewtons, and micrometres parses as 1 s, 1.5 N, and 10.25 mm',
    },
    () => {
      const csv = 'time_us,force_mN,position_um,setpoint_um\n1000000,1500,10250,10000\n';
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
      then: 'a malformed CSV row is skipped and the valid row is kept',
    },
    () => {
      const csv = 'time_us,force_mN,position_um,setpoint_um\nbad,row\n0,0,0,0\n';
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
      then: 'a timestamp that matches a recorded sample returns that sample value',
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
      then: 'a timestamp halfway between two samples returns the value halfway between them',
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
      then: 'a timestamp outside the recorded span, or an empty series, has no interpolated value',
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
      then: 'motion-start time is the first sample that has moved by the threshold from the opening position',
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
      then: 'a series that never moves has no motion-start time',
    },
    () => {
      expect(motionStartTimeUs([0, 100], [10, 10], 80)).toBeUndefined();
    },
  );
});
