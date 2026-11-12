/**
 * The ideal path the live chart draws as "Expected" (domain/expectedPath.ts):
 * jogs and test programs as straight lines at their commanded speed. Held
 * outside React, like liveBuffer, because every incoming sample reads it.
 */
import { generateExpectedMotion } from '@/domain/analysis';
import { PathSegment, expectedAt, jogSegment, segmentsFromMotion } from '@/domain/expectedPath';
import { latestLiveSample, liveClockSeconds } from './liveBuffer';

let segments: PathSegment[] = [];

/** A relative jog was sent: draw it from where the machine is heading now. */
export function planJog(mm: number, speed: number): void {
  const now = liveClockSeconds();
  const live = latestLiveSample();
  const start = live ? live.machineSetpoint : 0;
  const pending = segments.filter((s) => s.t1 > now);
  segments = [...pending, jogSegment(pending, now, start, mm, speed)];
}

/**
 * A test program started: draw its G-code. Absolute targets in the program
 * are sample extension, so the path is shifted by the gauge length into the
 * machine frame, as the firmware does.
 */
export function planTest(gcode: string[]): void {
  const live = latestLiveSample();
  if (!live) {
    segments = [];
    return;
  }
  const gaugeMm = live.machinePosition - live.samplePosition;
  const motion = generateExpectedMotion(gcode, live.samplePosition);
  segments = segmentsFromMotion(motion, liveClockSeconds(), gaugeMm);
}

/** Something the path cannot predict happened (stop, homing, motion off). */
export function clearExpectedPath(): void {
  segments = [];
}

/** Ideal position at live time `t`, given where the machine is heading; NaN when unknown. */
export function expectedPositionAt(t: number, targetMm: number): number {
  return expectedAt(segments, t, targetMm) ?? Number.NaN;
}
