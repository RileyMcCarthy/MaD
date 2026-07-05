/**
 * Test-run analysis: expected-motion reconstruction and stress–strain.
 *
 * Ported from the desktop `TestRunViewer`. Pure functions, browser-safe.
 */

import { SampleProfile } from './types';
import { TestDataPoint } from './sample';

export interface ExpectedMotion {
  time: number[];
  position: number[];
}

/**
 * Reconstruct the expected position-vs-time curve from a run's G-code (sample
 * frame), anchored at `initialPositionMm`. Mirrors the generator's kinematics.
 */
export function generateExpectedMotion(
  gcode: string[],
  initialPositionMm: number,
): ExpectedMotion {
  const time: number[] = [0];
  const position: number[] = [initialPositionMm];
  let currentTime = 0;
  let currentPosition = initialPositionMm;
  let mode: 'absolute' | 'relative' = 'absolute';

  for (const rawLine of gcode) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';')) continue;

    let g: number | null = null;
    let x: number | null = null;
    let f: number | null = null;
    let p: number | null = null;
    for (const token of line.split(/\s+/)) {
      if (!token) continue;
      const code = token[0].toUpperCase();
      const value = parseFloat(token.slice(1));
      if (Number.isNaN(value)) continue;
      if (code === 'G') g = Math.round(value);
      else if (code === 'X') x = value;
      else if (code === 'F') f = value;
      else if (code === 'P') p = value;
    }

    if (g === 90) {
      mode = 'absolute';
      continue;
    }
    if (g === 91) {
      mode = 'relative';
      continue;
    }
    if ((g === 0 || g === 1) && x !== null) {
      const startPos = currentPosition;
      const startTime = currentTime;
      currentPosition = mode === 'absolute' ? x : currentPosition + x;
      const dist = Math.abs(currentPosition - startPos);
      const feed = f ?? 0;
      currentTime += feed > 0 ? dist / feed : 0;
      position.push(startPos);
      time.push(startTime);
      position.push(currentPosition);
      time.push(currentTime);
      continue;
    }
    if (g === 4 && p !== null) {
      const startTime = currentTime;
      currentTime += p / 1000;
      position.push(currentPosition);
      time.push(startTime);
      position.push(currentPosition);
      time.push(currentTime);
    }
  }

  return { time, position };
}

/**
 * Interpolate an expected curve onto arbitrary sample timestamps.
 * O(n + m): clamps before the first / after the last expected point.
 */
export function interpolateExpected(
  expected: ExpectedMotion,
  sampleTimes: number[],
): number[] | null {
  const { time: expTime, position: expPos } = expected;
  if (expTime.length < 2) return null;
  const lastIdx = expTime.length - 1;
  const firstTime = expTime[0];
  const firstPos = expPos[0];
  const lastTime = expTime[lastIdx];
  const lastPos = expPos[lastIdx];

  const out: number[] = [];
  let seg = 0;
  for (const t of sampleTimes) {
    if (t <= firstTime) {
      out.push(firstPos);
      continue;
    }
    if (t >= lastTime) {
      out.push(lastPos);
      continue;
    }
    while (seg < lastIdx - 1 && t > expTime[seg + 1]) seg += 1;
    const t0 = expTime[seg];
    const t1 = expTime[seg + 1];
    const p0 = expPos[seg];
    const p1 = expPos[seg + 1];
    out.push(p0 + ((t - t0) / (t1 - t0 || 1)) * (p1 - p0));
  }
  return out;
}

export interface StressStrainPoint {
  /** strain (%) */
  x: number;
  /** stress (MPa) */
  y: number;
}

export interface StressStrain {
  data: StressStrainPoint[];
  maxStress?: number;
  maxStrain?: number;
}

/**
 * Compute stress–strain from logged points.
 * stress = |force| / (width·thickness) [MPa]; strain = ΔL / gaugeLength · 100 [%].
 */
export function computeStressStrain(
  points: TestDataPoint[],
  sampleProfile: SampleProfile,
  gaugeLengthMm: number,
): StressStrain {
  const area = sampleProfile.sampleWidth * sampleProfile.sampleThickness; // mm²
  if (area <= 0 || points.length === 0) return { data: [] };

  const gauge = gaugeLengthMm > 0 ? gaugeLengthMm : 1;
  const initialPosition = points[0].positionMm || 0;

  const data = points
    .map((pt) => {
      const stress = Math.abs(pt.forceN) / area;
      const strain = (Math.abs(pt.positionMm - initialPosition) / gauge) * 100;
      return { x: strain, y: stress };
    })
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0);

  const maxStress = sampleProfile.maxForce / area;
  const maxStrain = initialPosition > 0 ? (sampleProfile.maxDisplacement / initialPosition) * 100 : undefined;

  return { data, maxStress, maxStrain };
}
