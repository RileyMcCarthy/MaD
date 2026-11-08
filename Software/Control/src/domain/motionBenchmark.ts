/**
 * Motion benchmark: how well the closed-loop servo tracks its own encoder,
 * and Kp/Ki to start tuning from.
 *
 * The run is a G-code program built from the SAVED machine profile: an
 * acceleration sweep that ramps at Acceleration Max to a quarter, half,
 * three quarters and all of Velocity Max, then 1 mm, 0.1 mm and 0.01 mm
 * moves, with direction changes and a same-direction pair. Every move is
 * measured from the full-rate live samples, which carry the encoder position,
 * the trajectory's commanded position and the move's target.
 *
 * It measures TRACKING: the servo against its own encoder. It cannot see an
 * error the encoder shares (a wrong steps/mm, a loose coupling between the
 * encoder and the load); the ratio check and an external reference cover those.
 */

/** One live sample, in machine millimetres. */
export interface MotionSample {
  /** Seconds, on the live buffer's clock. */
  t: number;
  /** Encoder position. */
  position: number;
  /** Where the trajectory says the machine should be now. */
  commanded: number;
  /** Where the current move ends. */
  setpoint: number;
}

/** The saved profile's motion envelope, in mm, mm/s and mm/s^2. */
export interface MachineLimits {
  maxPositionMm: number;
  maxVelocityMmPerS: number;
  maxAccelMmPerS2: number;
  encoderStepsPerMM: number;
}

/**
 * The tracking run is closed loop on the SAVED profile, so it may only run on
 * steps/mm that the ratio check has just passed: a profile that passed as
 * typed but differs from what the machine has saved would be driven at the
 * saved (unchecked) scale -- on the bench that was 2.7x too fast.
 */
export function trackingMayRun(
  checked: { encoderStepsPerMM: number; servoStepsPerMM: number },
  saved: { encoderStepsPerMM: number; servoStepsPerMM: number },
): boolean {
  return checked.encoderStepsPerMM === saved.encoderStepsPerMM && checked.servoStepsPerMM === saved.servoStepsPerMM;
}

export interface TrackingMove {
  label: string;
  deltaMm: number;
  speedMmPerS: number;
  /** Set on the acceleration sweep's moves: the share of Velocity Max this move ramps to. */
  sweepShare?: number;
}

export type TrackingPlan =
  | { ok: true; moves: TrackingMove[]; travelMm: number }
  | { ok: false; reason: string };

/** The sweep's full-length moves, as a share of the travel between the endstops (Position Max). */
export const BENCHMARK_TRAVEL_SHARE = 0.1;

/** The speeds the acceleration sweep ramps to, as shares of Velocity Max. */
export const SWEEP_SHARES = [0.25, 0.5, 0.75, 1] as const;

/**
 * The program, relative to where the carriage starts, ending where it began.
 *
 * Every move the firmware runs accelerates at Acceleration Max, so the sweep
 * tests that one acceleration at rising speeds: motor torque falls as speed
 * rises, so the faster ramps are where a too-high Acceleration Max shows.
 * Each speed swings L/2 out, L back and L/2 out again, with L a tenth of
 * Position Max, so the operator needs L/2 of room each way. A move too short
 * to reach a speed at Acceleration Max tops out below it, and the assessment
 * reports the speed it did reach.
 */
export function planTrackingRun(limits: MachineLimits): TrackingPlan {
  if (!(limits.maxPositionMm > 0) || !(limits.maxVelocityMmPerS > 0) || !(limits.maxAccelMmPerS2 > 0)) {
    return {
      ok: false,
      reason: 'The saved profile needs Position Max, Velocity Max and Acceleration Max to plan the tracking run.',
    };
  }
  if (!(limits.encoderStepsPerMM > 0)) {
    return { ok: false, reason: 'The saved profile needs Encoder steps/mm.' };
  }
  // An even number of micrometres, so the half moves stay exact on the wire.
  const L = Math.round(BENCHMARK_TRAVEL_SHARE * limits.maxPositionMm * 500) / 500;
  const vMax = limits.maxVelocityMmPerS;
  const vSlow = round3(Math.min(1, 0.05 * vMax));
  const moves: TrackingMove[] = [];
  for (const share of SWEEP_SHARES) {
    const v = round3(share * vMax);
    const half = { deltaMm: L / 2, speedMmPerS: v, sweepShare: share, label: `+${L / 2} mm at ${v} mm/s` };
    moves.push(half, { deltaMm: -L, speedMmPerS: v, sweepShare: share, label: `−${L} mm at ${v} mm/s` }, { ...half });
  }
  moves.push(
    { label: `+1 mm at ${vSlow} mm/s`, deltaMm: 1, speedMmPerS: vSlow },
    { label: `−1 mm at ${vSlow} mm/s`, deltaMm: -1, speedMmPerS: vSlow },
    { label: '+0.1 mm', deltaMm: 0.1, speedMmPerS: vSlow },
    { label: '+0.1 mm (same way)', deltaMm: 0.1, speedMmPerS: vSlow },
    { label: '−0.2 mm', deltaMm: -0.2, speedMmPerS: vSlow },
    { label: '+0.01 mm', deltaMm: 0.01, speedMmPerS: vSlow },
    { label: '−0.01 mm', deltaMm: -0.01, speedMmPerS: vSlow },
  );
  // The 1 mm moves need a millimetre whatever the sweep's length.
  return { ok: true, moves, travelMm: Math.max(L, 1) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface MoveMeasurement {
  label: string;
  deltaMm: number;
  speedMmPerS: number;
  /** Carried from the move: set on the acceleration sweep's moves. */
  sweepShare?: number;
  /** Encoder minus target once settled, in micrometres (signed). */
  finalErrorUm: number;
  /** Largest |commanded − encoder| during the move. */
  peakFollowingErrorUm: number;
  /** Furthest past the target in the direction of travel (0 if never past). */
  overshootUm: number;
  /** From the trajectory reaching the target to the encoder staying within tolerance; null if it never did. */
  settleMs: number | null;
}

/** The servo parks once it is within this many encoder counts of a target (dev_servo positionDeadband). */
export const SERVO_DEADBAND_COUNTS = 8;

/** Close enough to MOVE ON: 1 µm, or the servo's parking deadband if that is coarser. */
export function settleToleranceMm(encoderStepsPerMM: number): number {
  return Math.max(0.001, SERVO_DEADBAND_COUNTS / encoderStepsPerMM);
}

/**
 * Close enough to count as SETTLED in the report: 1 µm, or one encoder count
 * if that is coarser. Tighter than the deadband on purpose -- every move ends
 * inside the deadband, so timing against it always reads zero.
 */
export function measureToleranceMm(encoderStepsPerMM: number): number {
  return Math.max(0.001, 1 / encoderStepsPerMM);
}

/** Measure one move from its samples (oldest first, from just before the move to settled). */
export function measureMove(samples: MotionSample[], move: TrackingMove, toleranceMm: number): MoveMeasurement | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  const target = last.setpoint;
  const dir = Math.sign(move.deltaMm) || 1;
  let peakFe = 0;
  let overshoot = 0;
  let tEnd: number | null = null;
  for (const s of samples) {
    peakFe = Math.max(peakFe, Math.abs(s.commanded - s.position));
    overshoot = Math.max(overshoot, (s.position - target) * dir);
    if (tEnd === null && Math.abs(s.commanded - target) < 1e-6) tEnd = s.t;
  }
  let settleMs: number | null = null;
  if (tEnd !== null) {
    // The last sample outside tolerance; settled from the one after it.
    let lastOut = -1;
    for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i].position - target) > toleranceMm) lastOut = i;
    }
    if (lastOut < samples.length - 1) {
      const tSettled = lastOut < 0 ? tEnd : samples[lastOut + 1].t;
      settleMs = Math.max(0, (tSettled - tEnd) * 1000);
    }
  }
  return {
    label: move.label,
    deltaMm: move.deltaMm,
    speedMmPerS: move.speedMmPerS,
    ...(move.sweepShare === undefined ? {} : { sweepShare: move.sweepShare }),
    finalErrorUm: (last.position - target) * 1000,
    peakFollowingErrorUm: peakFe * 1000,
    overshootUm: Math.max(0, overshoot) * 1000,
    settleMs,
  };
}

/**
 * The drive's lag, from an OPEN-LOOP move at a steady speed: with no feedback
 * the encoder follows the trajectory late by a fixed time, so during the
 * steady middle of the move the gap between them, divided by the speed, is
 * that time. `k` scales the trajectory to the encoder (the measured ratio over
 * the profile's), so a profile that is still a little off does not read as lag.
 */
export function estimateLagSeconds(samples: MotionSample[], speedMmPerS: number): number | null {
  if (samples.length < 5 || !(speedMmPerS > 0)) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dCmd = last.commanded - first.commanded;
  const dPos = last.position - first.position;
  if (Math.abs(dCmd) < 1e-9 || Math.abs(dPos) < 1e-9) return null;
  const k = dPos / dCmd;
  const dir = Math.sign(dCmd);
  const lags: number[] = [];
  for (const s of samples) {
    const progress = (s.commanded - first.commanded) / dCmd;
    if (progress < 0.25 || progress > 0.75) continue;
    const gapMm = (k * (s.commanded - first.commanded) - (s.position - first.position)) * dir;
    lags.push(gapMm / (Math.abs(k) * speedMmPerS));
  }
  if (lags.length < 3) return null;
  lags.sort((a, b) => a - b);
  return lags[Math.floor(lags.length / 2)];
}

export interface TrackingSummary {
  maxAbsFinalErrorUm: number;
  meanAbsFinalErrorUm: number;
  /** Mean final error signed by the move's direction: positive = ends past, negative = ends short. */
  directionalBiasUm: number;
  maxFollowingErrorUm: number;
  maxOvershootUm: number;
  maxSettleMs: number | null;
}

export function summarizeTracking(m: MoveMeasurement[]): TrackingSummary {
  const abs = m.map((x) => Math.abs(x.finalErrorUm));
  const settles = m.map((x) => x.settleMs).filter((x): x is number => x !== null);
  return {
    maxAbsFinalErrorUm: Math.max(0, ...abs),
    meanAbsFinalErrorUm: abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : 0,
    directionalBiasUm: m.length
      ? m.reduce((a, x) => a + x.finalErrorUm * (Math.sign(x.deltaMm) || 1), 0) / m.length
      : 0,
    maxFollowingErrorUm: Math.max(0, ...m.map((x) => x.peakFollowingErrorUm)),
    maxOvershootUm: Math.max(0, ...m.map((x) => x.overshootUm)),
    maxSettleMs: settles.length ? Math.max(...settles) : null,
  };
}

/**
 * The share of Acceleration Max the carriage must deliver on every sweep move
 * for Acceleration Max to pass.
 */
export const ACCEL_DELIVERED_MIN = 0.8;

/** One speed of the acceleration sweep, judged. */
export interface SweepStep {
  share: number;
  /** The speed asked for. */
  speedMmPerS: number;
  /** The fastest the trajectory got on this step's moves (a short move tops out below the speed asked for). */
  reachedMmPerS: number;
  /** Largest following error over this step's moves. */
  peakFollowingErrorUm: number;
  /** The worst share of Acceleration Max delivered over this step's moves, 0 to 1. */
  delivered: number;
}

export type AccelVerdict =
  | { kind: 'pass'; steps: SweepStep[]; topSpeedMmPerS: number }
  | { kind: 'too-high'; steps: SweepStep[]; worst: SweepStep }
  | { kind: 'not-judged'; steps: SweepStep[] };

/**
 * Could the carriage deliver Acceleration Max at every speed the sweep reached?
 *
 * A carriage that falls short of the acceleration it is asked for falls
 * behind its trajectory through the ramp: delivering a share r of
 * Acceleration Max leaves it about (1 − r) of the ramp's length, v²/2a,
 * behind by the time the trajectory reaches speed. So the following error
 * beyond what the drive's lag explains (lag x speed), divided by the ramp's
 * length, is the share the carriage did NOT deliver. The servo's parking
 * deadband is forgiven, since the servo itself allows that much error.
 *
 * The servo's correction during the ramp hides part of a shortfall, so this
 * reads generous; a carriage that stalls is still far outside it.
 */
export function assessAcceleration(
  moves: MoveMeasurement[],
  limits: MachineLimits,
  lagSeconds: number | null,
): AccelVerdict {
  const a = limits.maxAccelMmPerS2;
  const forgivenUm = (SERVO_DEADBAND_COUNTS / limits.encoderStepsPerMM) * 1000;
  const lag = lagSeconds !== null && lagSeconds > 0 ? lagSeconds : 0;
  const steps: SweepStep[] = [];
  for (const share of SWEEP_SHARES) {
    const mine = moves.filter((m) => m.sweepShare === share);
    if (mine.length === 0) continue;
    let reached = 0;
    let peakFe = 0;
    let delivered = 1;
    for (const m of mine) {
      // The trapezoid ramps at a; a move too short to reach its speed peaks at sqrt(a·d).
      const v = Math.min(m.speedMmPerS, Math.sqrt(a * Math.abs(m.deltaMm)));
      const rampUm = ((v * v) / (2 * a)) * 1000;
      const behindUm = Math.max(0, m.peakFollowingErrorUm - lag * v * 1000 - forgivenUm);
      reached = Math.max(reached, v);
      peakFe = Math.max(peakFe, m.peakFollowingErrorUm);
      delivered = Math.min(delivered, rampUm > 0 ? Math.max(0, 1 - behindUm / rampUm) : 1);
    }
    steps.push({
      share,
      speedMmPerS: mine[0].speedMmPerS,
      reachedMmPerS: round(reached, 3),
      peakFollowingErrorUm: peakFe,
      delivered,
    });
  }
  if (steps.length < SWEEP_SHARES.length) return { kind: 'not-judged', steps };
  const failing = steps.filter((s) => s.delivered < ACCEL_DELIVERED_MIN);
  if (failing.length > 0) {
    const worst = failing.reduce((w, s) => (s.delivered < w.delivered ? s : w));
    return { kind: 'too-high', steps, worst };
  }
  return { kind: 'pass', steps, topSpeedMmPerS: Math.max(...steps.map((s) => s.reachedMmPerS)) };
}

export interface GainSuggestion {
  /** 1/s */
  kp: number;
  /** 1/s^2 */
  ki: number;
  /** Why each value is what it is, in operator language. */
  notes: string[];
}

/** Kp below this barely corrects anything; the servo's own default is 8. */
export const KP_MIN = 2;

/**
 * Starting gains, from what the run measured.
 *
 * Kp: the loop adds Kp x error to the commanded speed. Two things cap it. The
 * drive's lag: past about 0.5/lag the correction arrives too late and the
 * carriage rings. And the motion envelope: Kp much above maxAccel/maxVel turns
 * a modest error into a demand the acceleration limit cannot meet.
 *
 * Ki: only to remove a steady error the load leaves behind (it ends short in
 * one direction). With the integral on, the error behaves like a spring and
 * damper; Ki = Kp^2/8 gives a damping ratio of about 0.7. Without a measured
 * bias the integral only adds overshoot, so it stays off.
 */
export function suggestGains(input: {
  lagSeconds: number | null;
  limits: MachineLimits;
  summary: TrackingSummary;
}): GainSuggestion {
  const notes: string[] = [];
  const envelopeCap = input.limits.maxAccelMmPerS2 / input.limits.maxVelocityMmPerS;
  let kp = envelopeCap;
  if (input.lagSeconds !== null && input.lagSeconds > 0) {
    const lagCap = 0.5 / input.lagSeconds;
    if (lagCap < kp) {
      kp = lagCap;
      notes.push(`Kp is held to 0.5 ÷ the drive's lag of ${round(input.lagSeconds * 1000, 1)} ms, so corrections arrive in time.`);
    } else {
      notes.push(`Kp is held to Acceleration Max ÷ Velocity Max, so a correction never asks for more than the acceleration limit.`);
    }
  } else {
    notes.push(`The drive's lag could not be measured, so Kp only respects Acceleration Max ÷ Velocity Max.`);
  }
  kp = Math.max(KP_MIN, kp);
  const tol = 1; // µm
  let ki = 0;
  if (Math.abs(input.summary.directionalBiasUm) > tol) {
    ki = (kp * kp) / 8;
    notes.push(
      `Moves end ${round(Math.abs(input.summary.directionalBiasUm), 1)} µm ${input.summary.directionalBiasUm < 0 ? 'short' : 'past'} on average, so the integral is on to remove it.`,
    );
  } else {
    notes.push('Moves end on target without a steady bias, so the integral stays off.');
  }
  return { kp: round(kp, 2), ki: round(ki, 2), notes };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export interface TrackingRunner {
  /** Send `G91` then a closed-loop `G1 X F`; true once accepted. */
  jog: (deltaMm: number, speedMmPerS: number) => Promise<boolean>;
  /** Every sample since a moment on the live clock. */
  samplesSince: (t: number) => MotionSample[];
  clock: () => number;
  motionEnabled: () => boolean;
  stop: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type TrackingOutcome = 'done' | 'move-refused' | 'aborted-motion-disabled' | 'aborted-overtravel' | 'aborted-timeout';

export interface TrackingRun {
  outcome: TrackingOutcome;
  measurements: MoveMeasurement[];
}

export const TRACKING_SETTLE_MS = 300;
export const TRACKING_POLL_MS = 50;

/** Run the program: each move, then wait for the trajectory to end and the encoder to hold still. */
export async function runTracking(
  runner: TrackingRunner,
  moves: TrackingMove[],
  limits: MachineLimits,
  onMove?: (index: number) => void,
): Promise<TrackingRun> {
  const tol = settleToleranceMm(limits.encoderStepsPerMM);
  const measureTol = measureToleranceMm(limits.encoderStepsPerMM);
  const measurements: MoveMeasurement[] = [];
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    onMove?.(i);
    const t0 = runner.clock();
    const startSamples = runner.samplesSince(t0 - 0.2);
    const start = startSamples.length ? startSamples[startSamples.length - 1].position : null;
    if (!(await runner.jog(move.deltaMm, move.speedMmPerS))) {
      return { outcome: runner.motionEnabled() ? 'move-refused' : 'aborted-motion-disabled', measurements };
    }
    const nominalMs = (Math.abs(move.deltaMm) / move.speedMmPerS) * 1000;
    const deadline = runner.now() + 2 * nominalMs + 3000;
    let stillSince: number | null = null;
    for (;;) {
      await runner.sleep(TRACKING_POLL_MS);
      if (!runner.motionEnabled()) return { outcome: 'aborted-motion-disabled', measurements };
      const s = runner.samplesSince(t0);
      const latest = s.length ? s[s.length - 1] : null;
      if (latest && start !== null && Math.abs(latest.position - start) > Math.abs(move.deltaMm) + 2) {
        await runner.stop();
        return { outcome: 'aborted-overtravel', measurements };
      }
      const arrived =
        latest !== null &&
        Math.abs(latest.commanded - latest.setpoint) < 1e-6 &&
        Math.abs(latest.position - latest.setpoint) <= tol &&
        s.length > 1;
      if (arrived) {
        stillSince ??= runner.now();
        if (runner.now() - stillSince >= TRACKING_SETTLE_MS) break;
      } else {
        stillSince = null;
      }
      if (runner.now() > deadline) {
        // Not settled inside tolerance: measure what there is (it is the finding), don't abandon.
        break;
      }
    }
    const m = measureMove(runner.samplesSince(t0 - 0.05), move, measureTol);
    if (m) measurements.push(m);
  }
  return { outcome: 'done', measurements };
}
