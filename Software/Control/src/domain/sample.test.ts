import { describe, it, expect } from 'vitest';
import {
  decodeBinarySampleDataToCSV,
  interpolateAtUs,
  motionStartTimeUs,
  parseTestCSV,
} from './sample';
import { encodeStoredSample, STOREDSAMPLE_WIRE_SIZE } from '@/protocol/generated/protoemb';

describe('decodeBinarySampleDataToCSV', () => {
  it('decodes StoredSample structs to CSV rows in raw units', () => {
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
  });
});

describe('parseTestCSV', () => {
  it('parses CSV into engineering units (N, mm, s)', () => {
    const csv = 'time_us,force_mN,position_um,setpoint_um\n1000000,1500,10250,10000\n';
    const pts = parseTestCSV(csv);
    expect(pts).toHaveLength(1);
    expect(pts[0].timeS).toBeCloseTo(1, 6);
    expect(pts[0].forceN).toBeCloseTo(1.5, 6);
    expect(pts[0].positionMm).toBeCloseTo(10.25, 6);
    expect(pts[0].setpointMm).toBeCloseTo(10, 6);
  });

  it('skips malformed rows', () => {
    const csv = 'time_us,force_mN,position_um,setpoint_um\nbad,row\n0,0,0,0\n';
    expect(parseTestCSV(csv)).toHaveLength(1);
  });
});

describe('interpolateAtUs', () => {
  const t = [0, 100_000, 200_000];
  const x = [0, 1000, 2000];

  it('returns the sample on an exact timestamp', () => {
    expect(interpolateAtUs(t, x, 100_000)).toBe(1000);
  });

  it('linearly interpolates between samples', () => {
    expect(interpolateAtUs(t, x, 50_000)).toBe(500);
    expect(interpolateAtUs(t, x, 150_000)).toBe(1500);
  });

  it('returns undefined outside the recorded span', () => {
    expect(interpolateAtUs(t, x, -1)).toBeUndefined();
    expect(interpolateAtUs(t, x, 200_001)).toBeUndefined();
    expect(interpolateAtUs([], [], 0)).toBeUndefined();
  });
});

describe('motionStartTimeUs', () => {
  it('returns the first sample that has moved', () => {
    const t = [1_000_000, 1_010_000, 1_020_000, 1_030_000];
    const p = [100, 100, 200, 400];
    expect(motionStartTimeUs(t, p, 80)).toBe(1_020_000);
  });

  it('returns undefined when the series never moves', () => {
    expect(motionStartTimeUs([0, 100], [10, 10], 80)).toBeUndefined();
  });
});
