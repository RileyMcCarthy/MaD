/**
 * The ideal path of the gantry: each move a straight line from where it
 * starts to where it ends, at exactly the commanded speed, with no
 * acceleration. It is what the commands ask for, drawn so the live chart can
 * show how closely the machine follows them. The setpoint (the firmware's own
 * trajectory, acceleration included) and the measured position are compared
 * against it.
 *
 * Times are seconds on the live chart's clock; positions are machine mm.
 */

import type { ExpectedMotion } from './analysis';

export interface PathSegment {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
}

/**
 * The segment for a relative jog of `mm` at `speed` mm/s. A jog sent while an
 * earlier one is still underway starts where and when that one ends, as the
 * machine queues it.
 */
export function jogSegment(
  previous: readonly PathSegment[],
  nowS: number,
  startMm: number,
  mm: number,
  speed: number,
): PathSegment {
  const last = previous[previous.length - 1];
  const queued = last !== undefined && last.t1 > nowS;
  const t0 = queued ? last.t1 : nowS;
  const p0 = queued ? last.p1 : startMm;
  const duration = speed > 0 ? Math.abs(mm) / speed : 0;
  return { t0, t1: t0 + duration, p0, p1: p0 + mm };
}

/** Segments for a test program's ideal motion, starting at `t0S`, shifted into the machine frame. */
export function segmentsFromMotion(motion: ExpectedMotion, t0S: number, offsetMm: number): PathSegment[] {
  const out: PathSegment[] = [];
  for (let i = 1; i < motion.time.length; i++) {
    const a = motion.time[i - 1];
    const b = motion.time[i];
    if (b < a) continue;
    out.push({
      t0: t0S + a,
      t1: t0S + b,
      p0: motion.position[i - 1] + offsetMm,
      p1: motion.position[i] + offsetMm,
    });
  }
  return out;
}

/**
 * Ideal position at time `t`, or null where the path says nothing: before it
 * starts, or after it has ended somewhere other than where the machine is now
 * heading (`targetMm`, the end of the move the machine is running), which means
 * something the path does not know about moved it.
 */
export function expectedAt(
  segments: readonly PathSegment[],
  t: number,
  targetMm: number,
  toleranceMm = 0.05,
): number | null {
  if (segments.length === 0 || t < segments[0].t0) return null;
  for (const s of segments) {
    if (t <= s.t1) {
      if (s.t1 <= s.t0) return s.p1;
      return s.p0 + ((t - s.t0) / (s.t1 - s.t0)) * (s.p1 - s.p0);
    }
  }
  const end = segments[segments.length - 1].p1;
  return Number.isFinite(targetMm) && Math.abs(end - targetMm) > toleranceMm ? null : end;
}
