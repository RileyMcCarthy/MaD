/**
 * Motor calibration: an open-loop check of the drive/encoder pair.
 *
 * The app drives the carriage a fixed number of step pulses forward and back
 * with `G124` (a linear move with the servo feedback off), and reads how far
 * the encoder moved from the live samples. Everything that judges those
 * numbers against the machine profile lives here, so it is pure and testable
 * without a device.
 *
 * Report only: nothing here changes the profile. The point is to find a
 * setting that does not match the hardware before the closed loop runs on it.
 *
 * Two profiles are involved. The one being EDITED (`CalibrationProfile`) is
 * what is judged. The one SAVED on the machine (`device`) is what the firmware
 * uses to turn G-code millimetres into pulses and encoder counts into the
 * position it reports, so it is what the conversions below must undo.
 */

/** Slowest a leg may run before it is abandoned: twice its nominal time plus this. */
export const CALIBRATION_TIMEOUT_MARGIN_MS = 3000;
/** The carriage counts as stopped once the encoder holds still this long. */
export const CALIBRATION_SETTLE_MS = 500;
export const CALIBRATION_POLL_MS = 100;
export const CALIBRATION_MAX_PULSES = 200_000;

/**
 * Slow, and long enough to measure the ratio well: each run loses a roughly
 * fixed few encoder counts at its ends whatever its length, so on the bench a
 * 1 mm run read 0.2-0.3% short and a 5 mm run under 0.1%.
 */
export const CALIBRATION_DEFAULT_DISTANCE_MM = 5;
export const CALIBRATION_DEFAULT_SPEED_MM_S = 1;

/** A leg is abandoned (motion disabled) once the encoder has moved this many
 *  times the distance the profile expects -- a drive far finer than the
 *  profile claims would otherwise carry the carriage much further than asked. */
export const CALIBRATION_OVERTRAVEL_FACTOR = 3;

/** How far measured counts per pulse may stray from the profile before it is
 *  reported as a mismatch. A tick of overshoot on a short run is well inside. */
export const CALIBRATION_RATIO_TOLERANCE = 0.02;

/** Below this share of the expected counts, the encoder is reported as not counting. */
export const CALIBRATION_SILENT_FRACTION = 0.05;

export type CalibrationOutcome =
  | 'done'
  | 'refused-motion-disabled'
  | 'refused-busy'
  | 'refused-no-data'
  | 'aborted-motion-disabled'
  | 'aborted-overtravel'
  | 'aborted-timeout';

export interface CalibrationResult {
  outcome: CalibrationOutcome;
  /** Pulses sent forward (positive) and back (negative). */
  pulsesForward: number;
  pulsesReverse: number;
  /** Encoder change over each leg. */
  countsForward: number;
  countsReverse: number;
}

export interface CalibrationProfile {
  encoderStepsPerMM: number;
  servoStepsPerMM: number;
}

export interface CalibrationSettings extends CalibrationProfile {
  distanceMm: number;
  speedMmPerS: number;
  /** The profile SAVED on the machine: the firmware's own conversions. */
  device: CalibrationProfile;
}

/** One leg, in the units G124 takes, and what it will really send. */
export interface CalibrationRequest {
  /** G124 X and F, in the machine's millimetres (its saved servo steps/mm). */
  moveMm: number;
  speedMmPerS: number;
  /** The pulses that X turns into on the machine. */
  pulses: number;
  /** Abandon the leg once the reported position has moved further than this. */
  maxTravelMm: number;
  /** How long the leg should take. */
  nominalMs: number;
}

export type CalibrationPlan = { ok: true; request: CalibrationRequest } | { ok: false; reason: string };

/** One line an operator can act on, for each way a calibration can end without a result. */
export const OUTCOME_TEXT: Record<CalibrationOutcome, string> = {
  done: 'Complete.',
  'refused-motion-disabled': 'Not run: enable motion (and clear any fault) first.',
  'refused-busy': 'Not run: the machine is busy with a move or a test.',
  'refused-no-data': 'Not run: no live position from the machine.',
  'aborted-motion-disabled': 'Stopped: motion was disabled.',
  'aborted-overtravel':
    'Stopped: the encoder moved over three times further than the profile expects. The drive is likely set much finer than servo steps/mm says, or encoder steps/mm is far too low.',
  'aborted-timeout': 'Stopped: the carriage was still moving long after the pulses should have finished.',
};

/**
 * Turn the operator's settings into a G124 the machine will run.
 *
 * The run is sized in PULSES from the steps/mm being edited (distance x servo
 * steps/mm), then expressed in the machine's millimetres, because the drive
 * gets X times the servo steps/mm the machine has SAVED. X goes over the wire
 * in micrometres, so the pulses actually sent are what that rounded X becomes.
 */
export function planCalibration(s: CalibrationSettings): CalibrationPlan {
  if (!(s.encoderStepsPerMM > 0) || !(s.servoStepsPerMM > 0)) {
    return { ok: false, reason: 'Encoder and servo steps/mm must both be greater than zero.' };
  }
  if (!(s.device.encoderStepsPerMM > 0) || !(s.device.servoStepsPerMM > 0)) {
    return {
      ok: false,
      reason: "The machine's saved profile has no steps/mm. Write a configuration to the device first.",
    };
  }
  if (!(s.distanceMm > 0) || !(s.speedMmPerS > 0)) {
    return { ok: false, reason: 'Distance and speed must both be greater than zero.' };
  }
  const wanted = Math.round(s.distanceMm * s.servoStepsPerMM);
  if (wanted > CALIBRATION_MAX_PULSES) {
    return {
      ok: false,
      reason: `That is ${wanted} pulses each way; the calibration allows at most ${CALIBRATION_MAX_PULSES}. Use a shorter distance.`,
    };
  }
  const moveUm = Math.round((wanted / s.device.servoStepsPerMM) * 1000);
  // As the machine does it: app_motion turns X into whole encoder counts with
  // the saved encoder steps/mm, and dev_servo pulses those at servo/encoder.
  const counts = Math.trunc((moveUm * s.device.encoderStepsPerMM) / 1000);
  const pulses = Math.round((counts * s.device.servoStepsPerMM) / s.device.encoderStepsPerMM);
  if (pulses < 1) {
    return { ok: false, reason: 'Distance is too small to send a single pulse.' };
  }
  const pulseRate = s.speedMmPerS * s.servoStepsPerMM;
  const speedMmPerS = pulseRate / s.device.servoStepsPerMM;
  const expectedCounts = pulses * (s.encoderStepsPerMM / s.servoStepsPerMM);
  return {
    ok: true,
    request: {
      moveMm: moveUm / 1000,
      speedMmPerS,
      pulses,
      maxTravelMm: (CALIBRATION_OVERTRAVEL_FACTOR * expectedCounts) / s.device.encoderStepsPerMM,
      nominalMs: (pulses / pulseRate) * 1000,
    },
  };
}

export type FindingSeverity = 'ok' | 'warning' | 'error';

export interface CalibrationFinding {
  id:
    | 'matches'
    | 'encoder-silent'
    | 'one-direction-silent'
    | 'direction-reversed'
    | 'direction-inconsistent'
    | 'ratio-mismatch'
    | 'asymmetric';
  severity: FindingSeverity;
  message: string;
}

export interface CalibrationLeg {
  pulses: number;
  counts: number;
  /** Signed: positive when the encoder moved the way the carriage was driven. */
  countsPerPulse: number;
}

export interface CalibrationAssessment {
  expectedCountsPerPulse: number;
  forward: CalibrationLeg;
  reverse: CalibrationLeg;
  /** Mean of the two legs' magnitudes, when both counted the right way. */
  measuredCountsPerPulse: number | null;
  /** If encoder steps/mm is right: what servo steps/mm the measurement implies. */
  impliedServoStepsPerMM: number | null;
  /** If servo steps/mm is right: what encoder steps/mm the measurement implies. */
  impliedEncoderStepsPerMM: number | null;
  /**
   * What was actually measured, per direction on average: the pulses sent and
   * the encoder counts that came back, signed so that a positive count means
   * the encoder followed the motion. `expectedCounts` is what the entered
   * steps/mm predict for those pulses. This is the only thing the run
   * measures; any steps/mm derived from it assumes the other value is right.
   */
  pulsesSent: number;
  countsMeasured: number;
  countsExpected: number;
  findings: CalibrationFinding[];
}

function leg(pulses: number, counts: number): CalibrationLeg {
  // Pulses carry the commanded direction's sign, so a positive ratio means the
  // encoder counted the way the carriage was driven.
  return { pulses, counts, countsPerPulse: pulses === 0 ? 0 : counts / pulses };
}

function fmt(n: number, digits = 3): string {
  return Number(n.toPrecision(digits)).toString();
}

/** Judge a finished calibration against the profile it was planned from. */
export function assessCalibration(
  result: CalibrationResult,
  profile: CalibrationProfile,
): CalibrationAssessment {
  const expected = profile.encoderStepsPerMM / profile.servoStepsPerMM;
  const forward = leg(result.pulsesForward, result.countsForward);
  const reverse = leg(result.pulsesReverse, result.countsReverse);
  const findings: CalibrationFinding[] = [];

  const silentBelow = CALIBRATION_SILENT_FRACTION * expected;
  const fwdSilent = Math.abs(forward.countsPerPulse) < silentBelow;
  const revSilent = Math.abs(reverse.countsPerPulse) < silentBelow;

  let measured: number | null = null;
  if (fwdSilent && revSilent) {
    findings.push({
      id: 'encoder-silent',
      severity: 'error',
      message:
        'The encoder did not count in either direction. Check that it is coupled to the motor, that A and B reach the board, that it shares a ground with the board, and that its outputs have pull-ups.',
    });
  } else if (fwdSilent || revSilent) {
    findings.push({
      id: 'one-direction-silent',
      severity: 'error',
      message: `The encoder counted only when driving ${fwdSilent ? 'back' : 'forward'}. One encoder channel may be disconnected, or the carriage did not move one way.`,
    });
  } else if (forward.countsPerPulse < 0 && reverse.countsPerPulse < 0) {
    findings.push({
      id: 'direction-reversed',
      severity: 'error',
      message:
        'The encoder counts the opposite way to the motion. Swap the encoder A and B wires, or reverse the drive direction setting; the servo loop would run away as wired.',
    });
  } else if (forward.countsPerPulse < 0 || reverse.countsPerPulse < 0) {
    findings.push({
      id: 'direction-inconsistent',
      severity: 'error',
      message:
        'The encoder counted the same way whichever way the carriage was driven. Check the drive direction wiring and that the carriage actually reverses.',
    });
  } else {
    measured = (forward.countsPerPulse + reverse.countsPerPulse) / 2;
    const error = measured / expected - 1;
    if (Math.abs(error) > CALIBRATION_RATIO_TOLERANCE) {
      findings.push({
        id: 'ratio-mismatch',
        severity: 'error',
        message: `The steps/mm entered don't match the hardware (${fmt(Math.abs(error) * 100, 3)}% off).`,
      });
    }
    const spread = Math.abs(forward.countsPerPulse - reverse.countsPerPulse) / measured;
    if (spread > CALIBRATION_RATIO_TOLERANCE) {
      findings.push({
        id: 'asymmetric',
        severity: 'warning',
        message: `Forward and back differ by ${fmt(spread * 100, 2)}%. Look for slip, backlash or lost pulses.`,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      id: 'matches',
      severity: 'ok',
      message: 'Calibration passed: the encoder follows the motor in the right direction, at the rate your steps/mm predict.',
    });
  }

  return {
    expectedCountsPerPulse: expected,
    forward,
    reverse,
    measuredCountsPerPulse: measured,
    impliedServoStepsPerMM: measured === null ? null : profile.encoderStepsPerMM / measured,
    impliedEncoderStepsPerMM: measured === null ? null : profile.servoStepsPerMM * measured,
    pulsesSent: (Math.abs(forward.pulses) + Math.abs(reverse.pulses)) / 2,
    // Each leg's counts signed by its own direction, so both agree in sign
    // when the encoder follows the motion and a reversed encoder reads negative.
    countsMeasured:
      (forward.counts * Math.sign(forward.pulses || 1) + reverse.counts * Math.sign(reverse.pulses || -1)) / 2,
    countsExpected: ((Math.abs(forward.pulses) + Math.abs(reverse.pulses)) / 2) * expected,
    findings,
  };
}

export interface CalibrationRunner {
  /** Send `G91` then `G124 X F` (relative, feedback off); true once accepted. */
  move: (moveMm: number, speedMmPerS: number) => Promise<boolean>;
  /** Latest reported machine position in mm (the encoder), or null without live data. */
  position: () => number | null;
  motionEnabled: () => boolean;
  testRunning: () => boolean;
  /** Abandon: disable motion. */
  stop: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type CalibrationProgress = 'forward' | 'reverse';

export type CalibrationRun = { ok: true; result: CalibrationResult } | { ok: false; reason: string };

type Leg = { ok: true; counts: number } | { ok: false; outcome: CalibrationOutcome };

/**
 * Drive one leg and measure it. The encoder is read once the carriage has held
 * still for CALIBRATION_SETTLE_MS after the leg's nominal time -- a step/dir
 * drive lags the pulses it is sent -- and the change is turned back into
 * counts with the machine's own encoder steps/mm.
 */
async function runLeg(
  runner: CalibrationRunner,
  request: CalibrationRequest,
  device: CalibrationProfile,
  sign: 1 | -1,
): Promise<Leg> {
  const start = runner.position();
  if (start === null) return { ok: false, outcome: 'refused-no-data' };
  if (!(await runner.move(sign * request.moveMm, request.speedMmPerS))) {
    return { ok: false, outcome: runner.motionEnabled() ? 'refused-busy' : 'refused-motion-disabled' };
  }
  const t0 = runner.now();
  const deadline = t0 + 2 * request.nominalMs + CALIBRATION_TIMEOUT_MARGIN_MS;
  let last = start;
  let stillSince = runner.now();
  for (;;) {
    await runner.sleep(CALIBRATION_POLL_MS);
    if (!runner.motionEnabled()) return { ok: false, outcome: 'aborted-motion-disabled' };
    const pos = runner.position() ?? last;
    if (Math.abs(pos - start) > request.maxTravelMm) {
      await runner.stop();
      return { ok: false, outcome: 'aborted-overtravel' };
    }
    // Still = within half an encoder count of the last reading.
    if (Math.abs(pos - last) * device.encoderStepsPerMM >= 0.5) {
      stillSince = runner.now();
    }
    last = pos;
    const now = runner.now();
    if (now - t0 >= request.nominalMs && now - stillSince >= CALIBRATION_SETTLE_MS) {
      return { ok: true, counts: Math.round((pos - start) * device.encoderStepsPerMM) };
    }
    if (now > deadline) {
      await runner.stop();
      return { ok: false, outcome: 'aborted-timeout' };
    }
  }
}

/** Run a calibration: G124 forward, settle, read; G124 back, settle, read. */
export async function runCalibration(
  runner: CalibrationRunner,
  request: CalibrationRequest,
  device: CalibrationProfile,
  onProgress?: (p: CalibrationProgress) => void,
): Promise<CalibrationRun> {
  const empty = { pulsesForward: 0, pulsesReverse: 0, countsForward: 0, countsReverse: 0 };
  if (!runner.motionEnabled()) return { ok: true, result: { outcome: 'refused-motion-disabled', ...empty } };
  if (runner.testRunning()) return { ok: true, result: { outcome: 'refused-busy', ...empty } };

  onProgress?.('forward');
  const fwd = await runLeg(runner, request, device, 1);
  if (!fwd.ok) return { ok: true, result: { outcome: fwd.outcome, ...empty } };
  onProgress?.('reverse');
  const back = await runLeg(runner, request, device, -1);
  if (!back.ok) {
    return { ok: true, result: { ...empty, outcome: back.outcome, pulsesForward: request.pulses, countsForward: fwd.counts } };
  }
  return {
    ok: true,
    result: {
      outcome: 'done',
      pulsesForward: request.pulses,
      countsForward: fwd.counts,
      pulsesReverse: -request.pulses,
      countsReverse: back.counts,
    },
  };
}
