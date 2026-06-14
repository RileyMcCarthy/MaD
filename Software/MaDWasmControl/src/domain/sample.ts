/**
 * Stored-sample decoding for downloaded test data.
 *
 * Ported from the desktop `DeviceInterface.ts` decodeBinarySampleDataToCSV —
 * pure function, browser-safe (`Uint8Array`).
 */

import {
  decodeStoredSample,
  STOREDSAMPLE_WIRE_SIZE,
} from '@/protocol/generated/protoemb';

/**
 * Decode a buffer of binary `StoredSample` structs into a CSV string.
 * Columns mirror the firmware sample frame: time_us, force_mN, position_um,
 * setpoint_um (the decoded structs are in UI units, converted back to raw).
 */
export function decodeBinarySampleDataToCSV(data: Uint8Array): string {
  const lines: string[] = ['time_us,force_mN,position_um,setpoint_um'];
  const numSamples = Math.floor(data.length / STOREDSAMPLE_WIRE_SIZE);

  for (let i = 0; i < numSamples; i++) {
    const offset = i * STOREDSAMPLE_WIRE_SIZE;
    const sample = decodeStoredSample(
      data.subarray(offset, offset + STOREDSAMPLE_WIRE_SIZE),
    );
    const forceMN = Math.round(sample.force * 1000);
    const positionUM = Math.round(sample.position * 1000);
    const setpointUM = Math.round(sample.setpoint * 1000);
    lines.push(`${sample.time},${forceMN},${positionUM},${setpointUM}`);
  }

  return `${lines.join('\n')}\n`;
}

/** Parsed downloaded CSV row in engineering units (N, mm). */
export interface TestDataPoint {
  timeS: number;
  forceN: number;
  positionMm: number;
  setpointMm: number;
}

/** Parse the CSV produced by `decodeBinarySampleDataToCSV` back into points. */
export function parseTestCSV(csv: string): TestDataPoint[] {
  const points: TestDataPoint[] = [];
  const rows = csv.split('\n');
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i].trim();
    if (!row) continue;
    const [timeUs, forceMn, posUm, setUm] = row.split(',').map(Number);
    if ([timeUs, forceMn, posUm, setUm].some((n) => Number.isNaN(n))) continue;
    points.push({
      timeS: timeUs / 1_000_000,
      forceN: forceMn / 1000,
      positionMm: posUm / 1000,
      setpointMm: setUm / 1000,
    });
  }
  return points;
}
