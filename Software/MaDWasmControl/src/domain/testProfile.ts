/**
 * Motion-profile → G-code generation.
 *
 * Ported from the desktop `GCodeGenerator` component. Pure function: turns a
 * TestProfile (motion profile + sample profile) into G-code lines plus a
 * distance-vs-time series for the preview chart. Emits the trailing `G122`
 * stop the firmware contract requires.
 */

import { TestProfile, WaveformFn } from './types';

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

/**
 * Unit waveform value in [-1, 1] for a phase in *turns* (cycles; the fractional
 * part is used). Both shapes pass through 0 at the start of a cycle so a move
 * begins smoothly from the centre, and return to 0 after whole cycles.
 */
export function waveformSample(fn: WaveformFn, turns: number): number {
  if (fn === 'triangle') {
    const t = turns - Math.floor(turns);
    if (t < 0.25) return 4 * t; //        0 → +1
    if (t < 0.75) return 2 - 4 * t; //   +1 → -1
    return 4 * t - 4; //                 -1 → 0
  }
  return Math.sin(2 * Math.PI * turns);
}

/** Peak velocity (mm/s) a waveform reaches — sine: 2πAf, triangle: 4Af. */
export function waveformPeakVelocity(fn: WaveformFn, amplitude: number, frequency: number): number {
  const k = fn === 'triangle' ? 4 : 2 * Math.PI;
  return k * Math.abs(amplitude) * Math.abs(frequency);
}

export function generateTestGcode(profile: TestProfile): GeneratedGcode {
  const gcode: string[] = [];
  const distance: number[] = [0];
  const time: number[] = [0];
  let currentTime = 0;
  let currentPosition = 0;
  let currentMode: 'absolute' | 'relative' = 'absolute';

  gcode.push(`; Test Profile: ${profile.name}`);
  gcode.push(`; Description: ${profile.description}`);
  gcode.push('');
  gcode.push('G90 ; Set absolute positioning');

  profile.sets.forEach((set, setIndex) => {
    gcode.push(`; Set ${setIndex + 1}: ${set.name} (${set.executions} executions)`);
    gcode.push('');

    for (let i = 0; i < set.executions; i++) {
      gcode.push(`; Execution ${i + 1}/${set.executions}`);

      set.moves.forEach((move) => {
        const position = Number(move.moveParameters.position) || 0;
        const velocity = Number(move.moveParameters.velocity) || 0;
        const moveDistance = Number(move.moveParameters.distance) || 0;
        const dwellTime = Number(move.moveParameters.time) || 0;

        const startPosition = currentPosition;
        const startTime = currentTime;

        if (move.absoluteOrRelative === 'absolute' && currentMode !== 'absolute') {
          gcode.push('G90 ; Set absolute positioning');
          currentMode = 'absolute';
        } else if (move.absoluteOrRelative === 'relative' && currentMode !== 'relative') {
          gcode.push('G91 ; Set relative positioning');
          currentMode = 'relative';
        }

        switch (move.moveType) {
          case 'linear': {
            if (move.absoluteOrRelative === 'absolute') {
              gcode.push(`G1 X${position} F${velocity}`);
              currentPosition = position;
              currentTime += Math.abs(currentPosition - startPosition) / (velocity || 1);
            } else {
              gcode.push(`G1 X${moveDistance} F${velocity}`);
              currentPosition += moveDistance;
              currentTime += Math.abs(moveDistance) / (velocity || 1);
            }
            distance.push(startPosition);
            time.push(startTime);
            distance.push(currentPosition);
            time.push(currentTime);
            break;
          }
          case 'dwell': {
            gcode.push(`G4 P${dwellTime}`);
            currentTime += dwellTime / 1000;
            distance.push(startPosition);
            time.push(startTime);
            distance.push(startPosition);
            time.push(currentTime);
            break;
          }
          case 'math': {
            // Position-vs-time waveform, expanded host-side into G1 segments the
            // firmware plays back like any linear program (runs unattended from
            // SD). Centre = absolute target position, or current position (+ any
            // relative offset). Segment feedrate = Δposition / Δt so each segment
            // takes the sampled time step, reproducing the waveform's timing.
            const fn: WaveformFn = move.moveParameters.waveform === 'triangle' ? 'triangle' : 'sine';
            const amplitude = Math.abs(Number(move.moveParameters.amplitude) || 0);
            const frequency = Number(move.moveParameters.frequency) || 0;
            const cycles = Number(move.moveParameters.cycles) || 0;
            const phaseTurns = (Number(move.moveParameters.phase) || 0) / 360;
            const mean = move.absoluteOrRelative === 'absolute' ? position : startPosition + moveDistance;

            if (amplitude > 0 && frequency > 0 && cycles > 0) {
              if (currentMode !== 'absolute') {
                gcode.push('G90 ; Set absolute positioning');
                currentMode = 'absolute';
              }
              const segments = Math.min(
                WAVEFORM_MAX_SEGMENTS,
                Math.max(1, Math.round(cycles * WAVEFORM_SEGMENTS_PER_CYCLE)),
              );
              const dt = 1 / (frequency * WAVEFORM_SEGMENTS_PER_CYCLE); // s per segment
              const sampleAt = (k: number): number =>
                mean + amplitude * waveformSample(fn, k / WAVEFORM_SEGMENTS_PER_CYCLE + phaseTurns);

              gcode.push(`; Waveform: ${fn} A=${amplitude}mm f=${frequency}Hz x${cycles} cycle(s)`);
              let prevP = currentPosition;
              const startP = sampleAt(0);
              // Ramp in to the waveform's first point if we're not already there.
              if (Math.abs(startP - currentPosition) > 1e-6) {
                const rampV = waveformPeakVelocity(fn, amplitude, frequency) || 1;
                gcode.push(`G1 X${round3(startP)} F${round3(rampV)}`);
                distance.push(round3(startP));
                time.push(currentTime);
                prevP = startP;
              }
              for (let k = 1; k <= segments; k++) {
                const target = sampleAt(k);
                const v = dt > 0 ? Math.abs(target - prevP) / dt : 0;
                if (v > 0) gcode.push(`G1 X${round3(target)} F${round3(v)}`);
                distance.push(round3(target));
                time.push(round3(currentTime + k * dt));
                prevP = target;
              }
              currentTime += segments * dt;
              currentPosition = prevP;
            }
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
