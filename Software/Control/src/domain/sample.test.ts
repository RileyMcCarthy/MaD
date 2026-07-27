import { describe, it, expect } from 'vitest';
import { decodeBinarySampleDataToCSV, parseTestCSV } from './sample';
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
