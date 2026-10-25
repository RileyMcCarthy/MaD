/**
 * Motor calibration: an open-loop check of the drive/encoder pair.
 *
 * The machine drives a fixed number of step pulses forward and back with the
 * servo loop out of the path, and reports how far the encoder moved each way
 * (raw numbers only). Everything that judges those numbers against the
 * machine profile lives here, so it is pure and testable without a device.
 *
 * Report only: nothing here changes the profile. The point is to find a
 * setting that does not match the hardware before the closed loop runs on it.
 */

import {
  MotorCalibrationState,
  type MotorCalibrationRequest as ProtoMotorCalibrationRequest,
  type MotorCalibrationResult as ProtoMotorCalibrationResult,
} from '@/protocol/generated/protoemb';

/** Firmware ceilings (APP_MOTORCALIBRATION_MAX_* in app_motorCalibration.h). */
export const CALIBRATION_MAX_PULSES = 200_000;
export const CALIBRATION_MAX_FREQUENCY = 20_000;

/** Short and slow by default: one millimetre each way at one millimetre a second. */
export const CALIBRATION_DEFAULT_DISTANCE_MM = 1;
export const CALIBRATION_DEFAULT_SPEED_MM_S = 1;

/** The firmware abandons a leg once the encoder has moved this many times the
 *  distance the profile expects — a drive far finer than the profile claims
 *  would otherwise carry the carriage much further than asked. */
export const CALIBRATION_OVERTRAVEL_FACTOR = 3;

/** How far measured counts per pulse may stray from the profile before it is
 *  reported as a mismatch. A tick of overshoot on a short run is well inside. */
export const CALIBRATION_RATIO_TOLERANCE = 0.02;

/** Below this share of the expected counts, the encoder is reported as not counting. */
export const CALIBRATION_SILENT_FRACTION = 0.05;

/**
 * Whether this firmware's servo loop emits one drive pulse per encoder count.
 * It does today (dev_servo commands a pulse rate equal to the encoder-count
 * rate), so any profile whose encoder and servo steps/mm differ will race the
 * carriage until that is fixed in firmware. Flip when it is.
 */
export const SERVO_LOOP_ASSUMES_ONE_PULSE_PER_COUNT = true;

export type CalibrationOutcome =
  | 'idle'
  | 'starting'
  | 'forward'
  | 'reverse'
  | 'done'
  | 'refused-motion-disabled'
  | 'refused-busy'
  | 'refused-at-endstop'
  | 'aborted-motion-disabled'
  | 'aborted-fault'
  | 'aborted-endstop'
  | 'aborted-timeout'
  | 'aborted-overtravel'
  | 'refused-restricted'
  | 'aborted-restricted'
  | 'aborted-jog';

export interface CalibrationResult {
  outcome: CalibrationOutcome;
  /** Pulses emitted forward (positive) and back (negative). */
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
}

export type CalibrationPlan =
  | { ok: true; request: ProtoMotorCalibrationRequest }
  | { ok: false; reason: string };

const OUTCOME_BY_STATE: Record<MotorCalibrationState, CalibrationOutcome> = {
  [MotorCalibrationState.IDLE]: 'idle',
  [MotorCalibrationState.STARTING]: 'starting',
  [MotorCalibrationState.FORWARD]: 'forward',
  [MotorCalibrationState.REVERSE]: 'reverse',
  [MotorCalibrationState.DONE]: 'done',
  [MotorCalibrationState.REFUSED_MOTION_DISABLED]: 'refused-motion-disabled',
  [MotorCalibrationState.REFUSED_BUSY]: 'refused-busy',
  [MotorCalibrationState.REFUSED_AT_ENDSTOP]: 'refused-at-endstop',
  [MotorCalibrationState.ABORTED_MOTION_DISABLED]: 'aborted-motion-disabled',
  [MotorCalibrationState.ABORTED_FAULT]: 'aborted-fault',
  [MotorCalibrationState.ABORTED_ENDSTOP]: 'aborted-endstop',
  [MotorCalibrationState.ABORTED_TIMEOUT]: 'aborted-timeout',
  [MotorCalibrationState.ABORTED_OVERTRAVEL]: 'aborted-overtravel',
  [MotorCalibrationState.REFUSED_RESTRICTED]: 'refused-restricted',
  [MotorCalibrationState.ABORTED_RESTRICTED]: 'aborted-restricted',
  [MotorCalibrationState.ABORTED_JOG]: 'aborted-jog',
};

export function calibrationResultFromWire(r: ProtoMotorCalibrationResult): CalibrationResult {
  return {
    outcome: OUTCOME_BY_STATE[r.state] ?? 'idle',
    pulsesForward: r.pulsesForward,
    pulsesReverse: r.pulsesReverse,
    countsForward: r.countsForward,
    countsReverse: r.countsReverse,
  };
}

/** True while the machine is still working on it. */
export function isCalibrationActive(outcome: CalibrationOutcome): boolean {
  return outcome === 'starting' || outcome === 'forward' || outcome === 'reverse';
}

/** One line an operator can act on, for each way a calibration can stop. */
export const OUTCOME_TEXT: Record<CalibrationOutcome, string> = {
  idle: 'Not run yet.',
  starting: 'Starting…',
  forward: 'Driving forward…',
  reverse: 'Driving back…',
  done: 'Complete.',
  'refused-motion-disabled': 'Refused: enable motion (and clear any fault) first.',
  'refused-busy': 'Refused: a move or a test is running.',
  'refused-at-endstop': 'Refused: the carriage is on an end stop. Jog it clear first.',
  'aborted-motion-disabled': 'Stopped: motion was disabled.',
  'aborted-fault': 'Stopped: the machine faulted.',
  'aborted-endstop': 'Stopped: the carriage reached an end stop.',
  'aborted-timeout': 'Stopped: the drive took far longer than expected to send its pulses.',
  'aborted-overtravel':
    'Stopped: the encoder moved over three times further than the profile expects. The drive is likely set much finer than servo steps/mm says, or encoder steps/mm is far too low.',
  'refused-restricted':
    'Refused: the machine is speed-restricted (door open or a tension limit). Clear the restriction first.',
  'aborted-restricted': 'Stopped: the machine became speed-restricted (door opened or a tension limit).',
  'aborted-jog': 'Stopped: a jog took the drive. The jog ran at the restricted speed; run the calibration again.',
};

/** Turn the operator's settings into a request the firmware will accept. */
export function planCalibration(s: CalibrationSettings): CalibrationPlan {
  if (!(s.encoderStepsPerMM > 0) || !(s.servoStepsPerMM > 0)) {
    return { ok: false, reason: 'Encoder and servo steps/mm must both be greater than zero.' };
  }
  if (!(s.distanceMm > 0) || !(s.speedMmPerS > 0)) {
    return { ok: false, reason: 'Distance and speed must both be greater than zero.' };
  }
  const pulses = Math.round(s.distanceMm * s.servoStepsPerMM);
  const frequency = Math.round(s.speedMmPerS * s.servoStepsPerMM);
  const maxCounts = Math.ceil(CALIBRATION_OVERTRAVEL_FACTOR * s.distanceMm * s.encoderStepsPerMM);
  if (pulses < 1 || frequency < 1) {
    return { ok: false, reason: 'Distance or speed is too small to send a single pulse.' };
  }
  if (pulses > CALIBRATION_MAX_PULSES) {
    return {
      ok: false,
      reason: `That is ${pulses} pulses; the machine allows at most ${CALIBRATION_MAX_PULSES}. Use a shorter distance.`,
    };
  }
  if (frequency > CALIBRATION_MAX_FREQUENCY) {
    return {
      ok: false,
      reason: `That is ${frequency} pulses/s; the machine allows at most ${CALIBRATION_MAX_FREQUENCY}. Use a lower speed.`,
    };
  }
  return { ok: true, request: { pulses, frequency, maxCounts } };
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
    | 'asymmetric'
    | 'loop-needs-one-to-one';
  severity: FindingSeverity;
  message: string;
}

export interface CalibrationLeg {
  pulses: number;
  counts: number;
  /** Signed: positive when the encoder moved the way the carriage was driven. */
  countsPerPulse: number;
  /**
   * The same measurement in the units the operator typed. One run fixes only
   * the RATIO of the two values, so each is what the measurement makes it if
   * the OTHER entered value is right. Signed like countsPerPulse; null when
   * the encoder did not count.
   */
  encoderStepsPerMM: number | null;
  servoStepsPerMM: number | null;
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
   * The run's measurement in the units the operator typed: the mean of the two
   * directions, signed (negative = encoder counts against the motion). Null
   * when either direction did not count. Each assumes the OTHER entered value
   * is right, as on CalibrationLeg.
   */
  measuredEncoderStepsPerMM: number | null;
  measuredServoStepsPerMM: number | null;
  findings: CalibrationFinding[];
}

function leg(pulses: number, counts: number, profile: CalibrationProfile): CalibrationLeg {
  // Pulses carry the commanded direction's sign, so a positive ratio means the
  // encoder counted the way the carriage was driven.
  const countsPerPulse = pulses === 0 ? 0 : counts / pulses;
  return {
    pulses,
    counts,
    countsPerPulse,
    encoderStepsPerMM: countsPerPulse === 0 ? null : profile.servoStepsPerMM * countsPerPulse,
    servoStepsPerMM: countsPerPulse === 0 ? null : profile.encoderStepsPerMM / countsPerPulse,
  };
}

function mean(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : (a + b) / 2;
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
  const forward = leg(result.pulsesForward, result.countsForward, profile);
  const reverse = leg(result.pulsesReverse, result.countsReverse, profile);
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
        message: `The steps/mm entered don't match the hardware (${fmt(Math.abs(error) * 100, 3)}% off). Correct whichever value you trust less: the encoder's counts per revolution and the drive's pulses per revolution tell you which.`,
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

  if (SERVO_LOOP_ASSUMES_ONE_PULSE_PER_COUNT && Math.abs(expected - 1) > CALIBRATION_RATIO_TOLERANCE) {
    findings.push({
      id: 'loop-needs-one-to-one',
      severity: 'warning',
      message: `The servo loop in this firmware sends one drive pulse per encoder count, so encoder and servo steps/mm must be equal (they are ${profile.encoderStepsPerMM} and ${profile.servoStepsPerMM}). Set the drive's pulses per revolution to the encoder's counts per revolution, then set both values the same.`,
    });
  }

  return {
    expectedCountsPerPulse: expected,
    forward,
    reverse,
    measuredCountsPerPulse: measured,
    impliedServoStepsPerMM: measured === null ? null : profile.encoderStepsPerMM / measured,
    impliedEncoderStepsPerMM: measured === null ? null : profile.servoStepsPerMM * measured,
    measuredEncoderStepsPerMM: mean(forward.encoderStepsPerMM, reverse.encoderStepsPerMM),
    measuredServoStepsPerMM: mean(forward.servoStepsPerMM, reverse.servoStepsPerMM),
    findings,
  };
}

export interface CalibrationRunner {
  start: (request: ProtoMotorCalibrationRequest) => Promise<boolean>;
  read: () => Promise<CalibrationResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type CalibrationRun =
  | { ok: true; result: CalibrationResult }
  | { ok: false; reason: string };

export const CALIBRATION_POLL_MS = 250;

/**
 * Longest a run can legitimately take: the firmware gives each leg twice its
 * nominal time plus a second, then a quarter-second settle; the rest is slack
 * for the link.
 */
export function calibrationDeadlineMs(request: ProtoMotorCalibrationRequest): number {
  const legMs = 2 * ((request.pulses * 1000) / request.frequency) + 1000 + 250;
  return 2 * legMs + 5000;
}

/** Start a calibration and poll its result until the machine has finished. */
export async function runCalibration(
  runner: CalibrationRunner,
  request: ProtoMotorCalibrationRequest,
  onProgress?: (result: CalibrationResult) => void,
): Promise<CalibrationRun> {
  const accepted = await runner.start(request);
  if (!accepted) {
    return { ok: false, reason: 'The machine did not accept the calibration request.' };
  }
  const deadline = runner.now() + calibrationDeadlineMs(request);
  for (;;) {
    const result = await runner.read();
    onProgress?.(result);
    if (!isCalibrationActive(result.outcome)) return { ok: true, result };
    if (runner.now() > deadline) {
      return { ok: false, reason: 'The machine did not finish the calibration in time.' };
    }
    await runner.sleep(CALIBRATION_POLL_MS);
  }
}
