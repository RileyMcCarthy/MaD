/**
 * Pre-run check: where a test asks for more than the machine or the sample
 * profile allows.
 *
 * The machine does not refuse such a test up front. Straight and sigmoid moves
 * above its velocity limit run at that limit, and a move too short to reach its
 * speed at the machine's acceleration peaks lower; a sine or chirp beyond its
 * speed or acceleration limits is refused by the machine when the run reaches
 * it; and the sample profile's limits stop the motion during the run. Each of
 * those looks like a machine fault unless the operator was told beforehand, so
 * the runner lists them and asks before running anyway.
 *
 * Positions follow the test G-code's frame: sample extension in mm, measured
 * from zero length; a sine sets off from wherever the sample is when it
 * starts, out to twice its amplitude and back. The machine position is extension plus gauge length.
 */

import { planSigmoid, sinePeakAcceleration, sinePeakVelocity } from './testProfile';
import type { MachineConfiguration, TestProfile } from './types';

export interface LimitContext {
  /** Live machine configuration; null when not connected (machine checks are skipped). */
  machine: MachineConfiguration | null;
  /** Sample extension when the test starts, mm. */
  startExtensionMm: number;
  /** Machine position minus sample extension, mm; null when unknown. */
  gaugeLengthMm: number | null;
  /** Speed ceiling in force right now because the machine is restricted; null when not restricted. */
  restrictedVelocityMmS: number | null;
}

export interface LimitIssue {
  /** Stable key, one per kind of problem. */
  id:
    | 'sample-velocity'
    | 'machine-velocity'
    | 'machine-acceleration'
    | 'sample-displacement'
    | 'machine-position-max'
    | 'machine-position-min'
    | 'sample-force-above-machine'
    | 'restricted-velocity';
  /** Whose limit it is. */
  source: 'machine' | 'sample';
  message: string;
}

interface Envelope {
  maxVelocity: number;
  maxAcceleration: number;
  minExtension: number;
  maxExtension: number;
  /** Every straight move: its length (mm) and commanded speed (mm/s). */
  linearMoves: Array<{ distance: number; speed: number }>;
}

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

/** The fastest speed, harshest acceleration and travel range the test asks for. */
export function testEnvelope(profile: TestProfile, startExtensionMm: number): Envelope {
  let pos = startExtensionMm;
  const env: Envelope = {
    maxVelocity: 0,
    maxAcceleration: 0,
    minExtension: pos,
    maxExtension: pos,
    linearMoves: [],
  };
  const reach = (p: number) => {
    env.minExtension = Math.min(env.minExtension, p);
    env.maxExtension = Math.max(env.maxExtension, p);
  };
  for (const set of profile.sets) {
    const executions = Math.max(0, Math.round(Number(set.executions) || 0));
    for (let i = 0; i < executions; i++) {
      for (const move of set.moves) {
        const p = move.moveParameters;
        if (move.moveType === 'linear') {
          const from = pos;
          pos = Number(p.position) || 0;
          const speed = Math.abs(Number(p.velocity) || 0);
          env.maxVelocity = Math.max(env.maxVelocity, speed);
          env.linearMoves.push({ distance: Math.abs(pos - from), speed });
          reach(pos);
        } else if (move.moveType === 'math' && p.waveform === 'sigmoid') {
          const end = Number(p.position) || 0;
          const acceleration = Math.abs(Number(p.acceleration) || 0);
          const plan = planSigmoid(end - pos, Math.abs(Number(p.velocity) || 0), acceleration);
          if (plan === null) continue;
          env.maxVelocity = Math.max(env.maxVelocity, plan.peakVelocity);
          env.maxAcceleration = Math.max(env.maxAcceleration, acceleration);
          pos = end;
          reach(pos);
        } else if (move.moveType === 'math') {
          // A cosine from rest where the sample is, out to twice the amplitude
          // in the direction of its sign and back. A chirp is judged at the
          // faster of its two frequencies, where its speed and acceleration peak.
          const amplitude = Number(p.amplitude) || 0;
          const frequency =
            p.waveform === 'chirp'
              ? Math.max(Number(p.frequency) || 0, Number(p.endFrequency) || 0)
              : Number(p.frequency) || 0;
          if (amplitude === 0 || frequency <= 0) continue;
          env.maxVelocity = Math.max(env.maxVelocity, sinePeakVelocity(amplitude, frequency));
          env.maxAcceleration = Math.max(env.maxAcceleration, sinePeakAcceleration(amplitude, frequency));
          reach(pos + 2 * amplitude);
        }
      }
    }
  }
  return env;
}

export function checkTestLimits(profile: TestProfile, ctx: LimitContext): LimitIssue[] {
  const issues: LimitIssue[] = [];
  const env = testEnvelope(profile, ctx.startExtensionMm);
  const sample = profile.sampleProfile;
  const m = ctx.machine;

  if (sample.maxVelocity > 0 && env.maxVelocity > sample.maxVelocity) {
    issues.push({
      id: 'sample-velocity',
      source: 'sample',
      message: `Motion profile speed of ${fmt(env.maxVelocity)} mm/s exceeds sample limit of ${fmt(sample.maxVelocity)} mm/s.`,
    });
  }
  if (sample.maxDisplacement > 0 && env.maxExtension > sample.maxDisplacement) {
    issues.push({
      id: 'sample-displacement',
      source: 'sample',
      message: `Motion profile displacement of ${fmt(env.maxExtension)} mm exceeds sample limit of ${fmt(sample.maxDisplacement)} mm.`,
    });
  }

  if (m) {
    const vMax = m['Velocity Max (mm/s)'];
    if (vMax > 0 && env.maxVelocity > vMax) {
      issues.push({
        id: 'machine-velocity',
        source: 'machine',
        message: `Motion profile speed of ${fmt(env.maxVelocity)} mm/s exceeds machine limit of ${fmt(vMax)} mm/s.`,
      });
    }
    // Acceleration the profile needs: a waveform's peak, or a straight move
    // that has to speed up and brake to a stop within its own length, which
    // takes v²/d to reach speed v over distance d.
    const aMax = m['Acceleration Max (mm/s^2)'];
    let neededAccel = env.maxAcceleration;
    for (const mv of env.linearMoves) {
      if (mv.distance <= 0) continue;
      const reachable = vMax > 0 ? Math.min(mv.speed, vMax) : mv.speed;
      neededAccel = Math.max(neededAccel, (reachable * reachable) / mv.distance);
    }
    if (aMax > 0 && neededAccel > aMax * 1.02) {
      issues.push({
        id: 'machine-acceleration',
        source: 'machine',
        message: `Motion profile acceleration of ${fmt(neededAccel)} mm/s² exceeds machine limit of ${fmt(aMax)} mm/s².`,
      });
    }

    const pMax = m['Position Max (mm)'];
    if (ctx.gaugeLengthMm !== null) {
      const top = ctx.gaugeLengthMm + env.maxExtension;
      const bottom = ctx.gaugeLengthMm + env.minExtension;
      if (pMax > 0 && top > pMax) {
        issues.push({
          id: 'machine-position-max',
          source: 'machine',
          message: `Motion profile position of ${fmt(top)} mm exceeds machine limit of ${fmt(pMax)} mm.`,
        });
      }
      if (bottom < 0) {
        issues.push({
          id: 'machine-position-min',
          source: 'machine',
          message: `Motion profile position of ${fmt(bottom)} mm is below machine limit of 0 mm.`,
        });
      }
    }
    const fMax = m['Tensile Force Max (N)'];
    if (fMax > 0 && sample.maxForce > fMax) {
      issues.push({
        id: 'sample-force-above-machine',
        source: 'machine',
        message: `Sample profile force of ${fmt(sample.maxForce)} N exceeds machine limit of ${fmt(fMax)} N.`,
      });
    }
  }

  if (ctx.restrictedVelocityMmS !== null && ctx.restrictedVelocityMmS > 0 && env.maxVelocity > ctx.restrictedVelocityMmS) {
    issues.push({
      id: 'restricted-velocity',
      source: 'machine',
      message: `Motion profile speed of ${fmt(env.maxVelocity)} mm/s exceeds restricted machine limit of ${fmt(ctx.restrictedVelocityMmS)} mm/s.`,
    });
  }
  return issues;
}
