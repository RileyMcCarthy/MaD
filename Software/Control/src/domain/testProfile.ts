/**
 * Motion-profile → G-code generation.
 *
 * Ported from the desktop `GCodeGenerator` component. Pure function: turns a
 * TestProfile (motion profile + sample profile) into G-code lines plus a
 * distance-vs-time series for the preview chart. Emits the trailing `G122`
 * stop the firmware contract requires.
 */

import { TestProfile } from './types';

export interface GeneratedGcode {
  gcode: string[];
  /** Parallel arrays for the distance-vs-time preview chart. */
  time: number[];
  distance: number[];
}

/** Linear segments emitted per waveform cycle (sampling resolution of f(t)). */
export const WAVEFORM_SEGMENTS_PER_CYCLE = 32;
/** Hard cap on segments a single waveform move may expand to (bounds upload size). */
export const WAVEFORM_MAX_SEGMENTS = 20000;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
// A waveform's amplitude and frequency are carried on the wire at 0.1 µm and
// 1 µHz. Emitting them at round3 would quantise to 1 µm and 1 mHz and throw
// that away in the text layer, which is the one place nobody would look for it.
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round6 = (n: number): number => Math.round(n * 1000000) / 1000000;

/**
 * How far a wave of unit amplitude is from where it started, at a phase in
 * *turns* (cycles): 1 − cos, from 0 at the start up to 2 at the far peak and
 * back. The firmware starts a wave at rest where the carriage is (a peak) and
 * sets off in the direction of the amplitude's sign.
 */
export function waveFromStart(turns: number): number {
  return 1 - Math.cos(2 * Math.PI * turns);
}

/** Peak velocity (mm/s) of a sine wave: 2πAf. */
export function sinePeakVelocity(amplitude: number, frequency: number): number {
  return 2 * Math.PI * Math.abs(amplitude) * Math.abs(frequency);
}

/**
 * Peak acceleration (mm/s²) of a sine wave: (2πf)²A.
 *
 * This matters because the firmware's closed-loop servo ENFORCES the machine
 * profile's acceleration limit: a waveform that demands more than the machine
 * is rated for is not rejected, it is tracked at the limit, and the recorded
 * motion comes out attenuated without anything looking like an error.
 */
export function sinePeakAcceleration(amplitude: number, frequency: number): number {
  const w = 2 * Math.PI * Math.abs(frequency);
  return w * w * Math.abs(amplitude);
}

/**
 * A chirp's cycles: a linear sweep from f0 to f1 averages (f0+f1)/2, so a sweep
 * of `duration` seconds holds that many cycles, rounded to a whole number (at
 * least one) so it ends at rest where it started. Returns the cycles and the
 * duration they actually take.
 */
export function chirpCycles(f0: number, f1: number, duration: number): { cycles: number; duration: number } {
  const mean = (Math.abs(f0) + Math.abs(f1)) / 2;
  if (!(mean > 0) || !(duration > 0)) return { cycles: 0, duration: 0 };
  const cycles = Math.max(1, Math.round(duration * mean));
  return { cycles, duration: cycles / mean };
}

/** Where a chirp has got to, in cycles, `t` seconds into a sweep from f0 to f1 over `span` s. */
export function chirpTurns(f0: number, f1: number, span: number, t: number): number {
  return f0 * t + ((f1 - f0) * t * t) / (2 * span);
}

/** Longest straight segment an S-curve's speed-up or braking is drawn with, s. */
export const SIGMOID_SEGMENT_S = 0.01;

/**
 * An S-curve move of `distance` mm at up to `velocity` mm/s and `acceleration`
 * mm/s². The acceleration rises and falls as a half-sine bump peaking at
 * `acceleration`, so it never jumps: speeding up from rest to v takes
 * Ta = pi*v / (2a) and covers a*Ta^2/pi. A move too short to reach `velocity`
 * peaks lower, at sqrt(2*a*d/pi), and spends no time cruising. Braking mirrors
 * the speed-up. Null for a move that cannot run (no distance, speed or
 * acceleration).
 */
export interface SigmoidPlan {
  /** Total time, s. */
  duration: number;
  /** Highest speed reached, mm/s. */
  peakVelocity: number;
  /** Time spent speeding up (and, mirrored, braking), s. */
  rampTime: number;
  /** Distance covered at `t` seconds from the start, mm (0 .. distance). */
  at: (t: number) => number;
}

export function planSigmoid(distance: number, velocity: number, acceleration: number): SigmoidPlan | null {
  const d = Math.abs(distance);
  if (!(d > 0) || !(velocity > 0) || !(acceleration > 0)) return null;
  let v = velocity;
  let ta = (Math.PI * v) / (2 * acceleration);
  let rampDist = (acceleration * ta * ta) / Math.PI;
  if (2 * rampDist > d) {
    v = Math.sqrt((2 * acceleration * d) / Math.PI);
    ta = (Math.PI * v) / (2 * acceleration);
    rampDist = d / 2;
  }
  const cruise = (d - 2 * rampDist) / v;
  const duration = 2 * ta + cruise;
  const ramp = (t: number): number => ((acceleration * ta) / Math.PI) * (t - (ta / Math.PI) * Math.sin((Math.PI * t) / ta));
  const at = (t: number): number => {
    if (t <= 0) return 0;
    if (t >= duration) return d;
    if (t <= ta) return ramp(t);
    if (t <= ta + cruise) return rampDist + v * (t - ta);
    return d - ramp(duration - t);
  };
  return { duration, peakVelocity: v, rampTime: ta, at };
}

export function generateTestGcode(profile: TestProfile): GeneratedGcode {
  const gcode: string[] = [];
  const distance: number[] = [0];
  const time: number[] = [0];
  let currentTime = 0;
  let currentPosition = 0;
  // The last sine cycle emitted, while nothing has moved since: the next
  // identical one joins it as one more cycle of the same wave.
  let sineRun: { line: number; amplitude: number; frequency: number; cycles: number } | null = null;

  gcode.push(`; Test Profile: ${profile.name}`);
  gcode.push(`; Description: ${profile.description}`);
  gcode.push('');
  gcode.push('G90 ; Set absolute positioning');

  const point = (t: number, x: number) => {
    time.push(round3(t));
    distance.push(round3(x));
  };

  profile.sets.forEach((set, setIndex) => {
    gcode.push(`; Set ${setIndex + 1}: ${set.name} (${set.executions} executions)`);
    gcode.push('');

    for (let i = 0; i < set.executions; i++) {
      gcode.push(`; Execution ${i + 1}/${set.executions}`);

      set.moves.forEach((move) => {
        const p = move.moveParameters;
        const position = Number(p.position) || 0;
        const velocity = Number(p.velocity) || 0;
        const startPosition = currentPosition;
        const startTime = currentTime;
        const isSine = move.moveType === 'math' && (p.waveform ?? 'sine') === 'sine';
        if (!isSine) sineRun = null;

        switch (move.moveType) {
          case 'linear': {
            gcode.push(`G1 X${position} F${velocity}`);
            currentPosition = position;
            currentTime += Math.abs(currentPosition - startPosition) / (velocity || 1);
            point(startTime, startPosition);
            point(currentTime, currentPosition);
            break;
          }
          case 'dwell': {
            const dwellTime = Number(p.time) || 0;
            gcode.push(`G4 P${dwellTime}`);
            currentTime += dwellTime / 1000;
            point(startTime, startPosition);
            point(currentTime, startPosition);
            break;
          }
          case 'math': {
            if (p.waveform === 'sigmoid') {
              // An S-curve move, sent as straight segments whose speeds follow
              // the curve: short ones through the speed-up and braking, one
              // through the cruise. The firmware carries the speed from each
              // into the next (look-ahead), so they run as one smooth motion;
              // their targets are absolute, so the move ends exactly on position.
              const plan = planSigmoid(position - startPosition, velocity, Number(p.acceleration) || 0);
              if (plan === null) break;
              const dir = position >= startPosition ? 1 : -1;
              gcode.push(
                `; sigmoid to ${position} mm at ${velocity} mm/s, ${Number(p.acceleration) || 0} mm/s2`,
              );
              const rampSteps = Math.max(4, Math.ceil(plan.rampTime / SIGMOID_SEGMENT_S));
              const cruise = plan.duration - 2 * plan.rampTime;
              const times: number[] = [];
              for (let k = 1; k <= rampSteps; k++) times.push((k / rampSteps) * plan.rampTime);
              if (cruise > 1e-9) times.push(plan.rampTime + cruise);
              for (let k = 1; k <= rampSteps; k++) times.push(plan.rampTime + cruise + (k / rampSteps) * plan.rampTime);
              let fromT = 0;
              let from = startPosition;
              point(startTime, startPosition);
              for (const t of times) {
                const to = t >= plan.duration ? position : round3(startPosition + dir * plan.at(t));
                if (Math.abs(to - from) >= 0.001) {
                  const feed = Math.max(0.001, round3(Math.abs(to - from) / (t - fromT)));
                  gcode.push(`G1 X${to} F${feed}`);
                  from = to;
                  fromT = t;
                }
                point(startTime + t, to);
              }
              currentTime = startTime + plan.duration;
              currentPosition = position;
              break;
            }
            if (p.waveform === 'chirp') {
              // The firmware's own G123 with an end frequency: one sweep of
              // whole cycles, a cosine from rest where the gantry is.
              const amplitude = Number(p.amplitude) || 0;
              const f0 = Number(p.frequency) || 0;
              const f1 = Number(p.endFrequency) || 0;
              const sweep = chirpCycles(f0, f1, Number(p.duration) || 0);
              if (!(Math.abs(amplitude) > 0 && f0 > 0 && f1 > 0 && sweep.cycles > 0)) break;
              gcode.push(
                `G123 A${round4(amplitude)} F${round6(f0)} C${sweep.cycles} W0 E${round6(f1)}` +
                  ` ; chirp A=${amplitude}mm ${f0}->${f1}Hz, ${sweep.cycles} cycle(s) in ${round3(sweep.duration)}s`,
              );
              const steps = Math.min(WAVEFORM_MAX_SEGMENTS, sweep.cycles * WAVEFORM_SEGMENTS_PER_CYCLE * 2);
              point(currentTime, startPosition);
              for (let k = 1; k <= steps; k++) {
                const t = (k / steps) * sweep.duration;
                point(currentTime + t, startPosition + amplitude * waveFromStart(chirpTurns(f0, f1, sweep.duration, t)));
              }
              currentTime += sweep.duration;
              currentPosition = startPosition;
              break;
            }
            // Sine: one cycle of the firmware's own G123 canned cycle, a cosine
            // from rest where the gantry is, which is a peak of the wave. One
            // wave of N cycles and N back-to-back one-cycle waves trace the
            // same path, but one command lets the firmware run them without a
            // handover at every cycle, so identical cycles are joined.
            // Signed: the direction the wave sets off in from where it starts.
            const amplitude = Number(p.amplitude) || 0;
            const frequency = Number(p.frequency) || 0;
            if (!(Math.abs(amplitude) > 0 && frequency > 0)) break;
            if (sineRun && sineRun.amplitude === amplitude && sineRun.frequency === frequency) {
              sineRun.cycles += 1;
            } else {
              sineRun = { line: gcode.length, amplitude, frequency, cycles: 1 };
              gcode.push('');
            }
            gcode[sineRun.line] =
              `G123 A${round4(amplitude)} F${round6(frequency)} C${sineRun.cycles} W0` +
              ` ; sine A=${amplitude}mm f=${frequency}Hz x${sineRun.cycles} cycle(s)`;
            // Preview chart only: sample one cycle for display (not emitted as motion).
            const steps = WAVEFORM_SEGMENTS_PER_CYCLE;
            const cycleS = 1 / frequency;
            point(currentTime, startPosition);
            for (let k = 1; k <= steps; k++) {
              point(currentTime + (k / steps) * cycleS, startPosition + amplitude * waveFromStart(k / steps));
            }
            currentTime += cycleS;
            currentPosition = startPosition; // a whole cycle ends where it started
            break;
          }
          default:
            break;
        }
      });
    }
  });

  gcode.push('');
  gcode.push('G122 ; Stop - signal test complete');

  return { gcode, time, distance };
}
