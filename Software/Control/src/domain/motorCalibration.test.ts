import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { MotorCalibrationState } from '@/protocol/generated/protoemb';
import {
  CALIBRATION_MAX_FREQUENCY,
  CALIBRATION_MAX_PULSES,
  CALIBRATION_POLL_MS,
  OUTCOME_TEXT,
  assessCalibration,
  calibrationDeadlineMs,
  calibrationResultFromWire,
  planCalibration,
  runCalibration,
  type CalibrationResult,
} from './motorCalibration';

/** A finished run of `pulses` each way, the encoder counting `perPulse` per pulse. */
function done(pulses: number, fwdPerPulse: number, revPerPulse = fwdPerPulse): CalibrationResult {
  return {
    outcome: 'done',
    pulsesForward: pulses,
    pulsesReverse: -pulses,
    countsForward: Math.round(pulses * fwdPerPulse),
    countsReverse: -Math.round(pulses * revPerPulse),
  };
}

const MATCHED = { encoderStepsPerMM: 2400, servoStepsPerMM: 2400 };
const ids = (r: ReturnType<typeof assessCalibration>) => r.findings.map((f) => f.id);

describe('motor calibration planning', () => {
  behaviour(
    {
      id: 'motorcal.plan-from-profile',
      covers: 'src/domain/motorCalibration.ts#planCalibration',
      given: 'a profile of 2400 encoder steps/mm and 6400 servo steps/mm, 1 mm each way at 1 mm/s',
      expect: {
        'pulses-from-servo': 'the pulse count is the distance times servo steps/mm',
        'rate-from-servo': 'the pulse rate is the speed times servo steps/mm',
        'bound-from-encoder': 'the encoder travel bound is three times the distance times encoder steps/mm',
      },
    },
    () => {
      const plan = planCalibration({
        encoderStepsPerMM: 2400,
        servoStepsPerMM: 6400,
        distanceMm: 1,
        speedMmPerS: 1,
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.request.pulses).toBe(6400);
      expect(plan.request.frequency).toBe(6400);
      expect(plan.request.maxCounts).toBe(7200);
    },
  );

  behaviour(
    {
      id: 'motorcal.plan-limits',
      covers: 'src/domain/motorCalibration.ts#planCalibration',
      given: 'calibration settings the machine would refuse',
      expect: {
        'unset-profile': 'a profile with zero steps/mm cannot be planned',
        'zero-distance': 'a zero distance or speed cannot be planned',
        'too-far': 'a distance needing more pulses than the machine allows cannot be planned, and the reason names the limit',
        'too-fast': 'a speed needing a faster pulse rate than the machine allows cannot be planned, and the reason names the limit',
      },
    },
    () => {
      const base = { encoderStepsPerMM: 8192, servoStepsPerMM: 8192, distanceMm: 1, speedMmPerS: 1 };
      expect(planCalibration({ ...base, servoStepsPerMM: 0 }).ok).toBe(false);
      expect(planCalibration({ ...base, distanceMm: 0 }).ok).toBe(false);
      expect(planCalibration({ ...base, speedMmPerS: 0 }).ok).toBe(false);
      const far = planCalibration({ ...base, distanceMm: 100 });
      expect(far.ok).toBe(false);
      if (!far.ok) expect(far.reason).toContain(String(CALIBRATION_MAX_PULSES));
      const fast = planCalibration({ ...base, speedMmPerS: 10 });
      expect(fast.ok).toBe(false);
      if (!fast.ok) expect(fast.reason).toContain(String(CALIBRATION_MAX_FREQUENCY));
    },
  );
});

describe('motor calibration assessment', () => {
  behaviour(
    {
      id: 'motorcal.matched-profile',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run whose encoder counted once per pulse both ways, on a profile with equal encoder and servo steps/mm',
      expect: {
        'reported-ok': 'the only finding is that the profile matches the hardware',
        'measured-ratio': 'the measured counts per pulse is one',
      },
    },
    () => {
      const a = assessCalibration(done(2400, 1), MATCHED);
      expect(ids(a)).toEqual(['matches']);
      expect(a.measuredCountsPerPulse).toBe(1);
    },
  );

  behaviour(
    {
      id: 'motorcal.ratio-mismatch',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a profile of 2400 encoder and 2400 servo steps/mm on a drive actually set to 6400 pulses per revolution',
      expect: {
        'mismatch-reported': 'a mismatch between the measured and expected counts per pulse is reported as an error',
        'servo-implied': 'taking encoder steps/mm as right, the servo steps/mm the measurement implies is 6400',
        'encoder-implied': 'taking servo steps/mm as right, the encoder steps/mm the measurement implies is 900',
      },
      why: {
        'servo-implied':
          'one measurement fixes only the ratio of the two values, so both readings of it are reported for the operator to choose',
      },
    },
    () => {
      const a = assessCalibration(done(6400, 2400 / 6400), MATCHED);
      expect(a.findings.find((f) => f.id === 'ratio-mismatch')?.severity).toBe('error');
      expect(a.impliedServoStepsPerMM).toBeCloseTo(6400, 6);
      expect(a.impliedEncoderStepsPerMM).toBeCloseTo(900, 6);
    },
  );

  behaviour(
    {
      id: 'motorcal.small-error-tolerated',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run that measured one percent more counts per pulse than the profile expects',
      expect: { 'no-mismatch': 'no mismatch is reported' },
      why: { 'no-mismatch': 'a tick of pulse overshoot on a short run is that size, so anything inside two percent passes' },
    },
    () => {
      expect(ids(assessCalibration(done(2400, 1.01), MATCHED))).toEqual(['matches']);
    },
  );

  behaviour(
    {
      id: 'motorcal.encoder-silent',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run in which the encoder did not count either way',
      expect: {
        'silent-reported': 'the encoder is reported as not counting, as an error naming the coupling and wiring to check',
        'no-ratio': 'no measured ratio or implied steps/mm is given',
      },
    },
    () => {
      const a = assessCalibration(done(2400, 0), MATCHED);
      expect(ids(a)).toEqual(['encoder-silent']);
      expect(a.findings[0].message).toMatch(/coupled/);
      expect(a.measuredCountsPerPulse).toBeNull();
      expect(a.impliedServoStepsPerMM).toBeNull();
    },
  );

  behaviour(
    {
      id: 'motorcal.one-way-silent',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run in which the encoder counted driving forward but not driving back',
      expect: { 'one-way-reported': 'the encoder is reported as counting in one direction only, naming that direction' },
    },
    () => {
      const a = assessCalibration(done(2400, 1, 0), MATCHED);
      expect(ids(a)).toEqual(['one-direction-silent']);
      expect(a.findings[0].message).toContain('forward');
    },
  );

  behaviour(
    {
      id: 'motorcal.direction-reversed',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run in which the encoder counted down while driving forward and up while driving back',
      expect: {
        'reversed-reported': 'the encoder is reported as counting against the motion, as an error that says to swap A and B',
      },
      why: { 'reversed-reported': 'a servo loop closed on a backwards encoder drives away from its target' },
    },
    () => {
      const a = assessCalibration(done(2400, -1), MATCHED);
      expect(ids(a)).toEqual(['direction-reversed']);
      expect(a.findings[0].message).toMatch(/Swap the encoder A and B/);
    },
  );

  behaviour(
    {
      id: 'motorcal.direction-inconsistent',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run in which the encoder counted up both when driving forward and when driving back',
      expect: { 'inconsistent-reported': 'the direction is reported as inconsistent, as an error' },
    },
    () => {
      expect(ids(assessCalibration(done(2400, 1, -1), MATCHED))).toEqual(['direction-inconsistent']);
    },
  );

  behaviour(
    {
      id: 'motorcal.asymmetric',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run that counted the expected amount forward but ten percent less driving back',
      expect: { 'asymmetry-warned': 'a difference between the two directions is reported as a warning' },
    },
    () => {
      const a = assessCalibration(done(2400, 1, 0.9), MATCHED);
      expect(a.findings.find((f) => f.id === 'asymmetric')?.severity).toBe('warning');
    },
  );

  behaviour(
    {
      id: 'motorcal.loop-needs-equal-scales',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run that matches a profile whose encoder and servo steps/mm differ',
      expect: {
        'still-matches': 'the measurement is reported as matching the profile',
        'equal-scales-warned': 'a warning says the servo loop needs encoder and servo steps/mm to be equal',
        'drive-setting-named': "the warning says to set the drive's pulses per revolution to the encoder's counts per revolution",
      },
      why: {
        'equal-scales-warned': 'the servo loop in this firmware sends one drive pulse per encoder count',
      },
    },
    () => {
      const profile = { encoderStepsPerMM: 2400, servoStepsPerMM: 6400 };
      const a = assessCalibration(done(6400, 2400 / 6400), profile);
      expect(ids(a)).toEqual(['matches', 'loop-needs-one-to-one']);
      expect(a.findings[1].severity).toBe('warning');
      expect(a.findings[1].message).toMatch(/pulses per revolution/);
    },
  );

  behaviour(
    {
      id: 'motorcal.outcome-from-wire',
      covers: 'src/domain/motorCalibration.ts#calibrationResultFromWire',
      given: 'a calibration result from the machine that was abandoned for overtravel',
      expect: { 'outcome-named': 'it reads as abandoned for overtravel, with the counts carried unchanged' },
    },
    () => {
      const r = calibrationResultFromWire({
        state: MotorCalibrationState.ABORTED_OVERTRAVEL,
        pulsesForward: 10,
        countsForward: 99,
        pulsesReverse: 0,
        countsReverse: 0,
      });
      expect(r.outcome).toBe('aborted-overtravel');
      expect(r.countsForward).toBe(99);
    },
  );

  behaviour(
    {
      id: 'motorcal.restricted-and-jog-outcomes-from-wire',
      covers: 'src/domain/motorCalibration.ts#calibrationResultFromWire',
      given: 'calibration results from the machine refused for restricted speed, abandoned for restricted speed, and abandoned for a jog',
      expect: {
        'outcomes-named': 'each reads as its own outcome, never as idle',
        'operator-told': 'each has a line for the operator naming the restriction or the jog',
      },
    },
    () => {
      const read = (state: MotorCalibrationState) =>
        calibrationResultFromWire({ state, pulsesForward: 0, countsForward: 0, pulsesReverse: 0, countsReverse: 0 })
          .outcome;
      expect(read(MotorCalibrationState.REFUSED_RESTRICTED)).toBe('refused-restricted');
      expect(read(MotorCalibrationState.ABORTED_RESTRICTED)).toBe('aborted-restricted');
      expect(read(MotorCalibrationState.ABORTED_JOG)).toBe('aborted-jog');
      expect(OUTCOME_TEXT['refused-restricted']).toMatch(/restricted/);
      expect(OUTCOME_TEXT['aborted-restricted']).toMatch(/restricted/);
      expect(OUTCOME_TEXT['aborted-jog']).toMatch(/jog/);
    },
  );
});

describe('motor calibration run', () => {
  function fakeRunner(results: CalibrationResult[], accept = true) {
    let t = 0;
    const reads: CalibrationResult[] = [...results];
    return {
      runner: {
        start: () => Promise.resolve(accept),
        read: () => Promise.resolve(reads.length > 1 ? reads.shift()! : reads[0]),
        sleep: (ms: number) => {
          t += ms;
          return Promise.resolve();
        },
        now: () => t,
      },
    };
  }
  const req = { pulses: 2400, frequency: 2400, maxCounts: 7200 };
  const progress = (outcome: CalibrationResult['outcome']): CalibrationResult => ({
    outcome,
    pulsesForward: 0,
    pulsesReverse: 0,
    countsForward: 0,
    countsReverse: 0,
  });

  behaviour(
    {
      id: 'motorcal.run-polls-to-end',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a calibration the machine accepts and finishes after a few progress reports',
      expect: {
        'final-result': 'the finished result is returned',
        'progress-shown': 'every report on the way is passed on as progress',
      },
    },
    async () => {
      const { runner } = fakeRunner([progress('starting'), progress('forward'), progress('reverse'), done(2400, 1)]);
      const seen: string[] = [];
      const run = await runCalibration(runner, req, (r) => seen.push(r.outcome));
      expect(run.ok && run.result.outcome).toBe('done');
      expect(seen).toEqual(['starting', 'forward', 'reverse', 'done']);
    },
  );

  behaviour(
    {
      id: 'motorcal.run-refused-request',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a calibration request the machine does not accept',
      expect: { 'not-accepted': 'the run fails at once, saying the machine did not accept it' },
    },
    async () => {
      const { runner } = fakeRunner([progress('idle')], false);
      const run = await runCalibration(runner, req);
      expect(run.ok).toBe(false);
      if (!run.ok) expect(run.reason).toMatch(/did not accept/);
    },
  );

  behaviour(
    {
      id: 'motorcal.run-deadline',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a calibration that the machine keeps reporting as in progress',
      expect: {
        'gives-up': 'the run fails once the longest time the machine could legitimately take has passed',
      },
    },
    async () => {
      const { runner } = fakeRunner([progress('forward')]);
      const run = await runCalibration(runner, req);
      expect(run.ok).toBe(false);
      expect(runner.now()).toBeGreaterThan(calibrationDeadlineMs(req));
      expect(runner.now()).toBeLessThanOrEqual(calibrationDeadlineMs(req) + 2 * CALIBRATION_POLL_MS);
    },
  );
});
