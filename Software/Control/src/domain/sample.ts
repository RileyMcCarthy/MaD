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

/**
 * Linear interpolation of `values` at virtual time `tUs`.
 *
 * Firmware sample `time` is `HAL_time_getUs()`, which SIL maps to the
 * emulator's `virtual_us` counter. Times must be non-decreasing. Out of
 * range or empty series → `undefined`.
 */
export function interpolateAtUs(
  timesUs: readonly number[],
  values: readonly number[],
  tUs: number,
): number | undefined {
  const n = timesUs.length;
  if (n === 0 || n !== values.length) return undefined;
  if (tUs < timesUs[0] || tUs > timesUs[n - 1]) return undefined;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timesUs[mid] < tUs) lo = mid + 1;
    else hi = mid;
  }
  if (timesUs[lo] === tUs) return values[lo];
  const i0 = lo - 1;
  if (i0 < 0) return values[lo];
  const span = timesUs[lo] - timesUs[i0];
  if (span === 0) return values[i0];
  const w = (tUs - timesUs[i0]) / span;
  return values[i0] + w * (values[lo] - values[i0]);
}

/**
 * First sample time at which position has moved at least `minDeltaUm`
 * from the opening sample — the motion-start instant on the virtual clock.
 */
export function motionStartTimeUs(
  timesUs: readonly number[],
  positionsUm: readonly number[],
  minDeltaUm = 80,
): number | undefined {
  if (timesUs.length < 2 || timesUs.length !== positionsUm.length) {
    return undefined;
  }
  const p0 = positionsUm[0];
  for (let i = 1; i < timesUs.length; i++) {
    if (Math.abs(positionsUm[i] - p0) >= minDeltaUm) return timesUs[i];
  }
  return undefined;
}
