import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  CALIBRATION_MAX_PULSES,
  CALIBRATION_SETTLE_MS,
  OUTCOME_TEXT,
  assessCalibration,
  planCalibration,
  runCalibration,
  type CalibrationProfile,
  type CalibrationRequest,
  type CalibrationResult,
  type CalibrationRunner,
} from './motorCalibration';
import type { MotionSample } from './motionBenchmark';

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
      given:
        'servo 6400 and encoder 2400 steps/mm being edited, 8192 and 8192 saved on the machine, and 1 mm each way at 1 mm/s',
      expect: {
        'sized-by-edited-servo': 'the run is sized in pulses from the servo steps/mm being edited',
        'machine-millimetres':
          'the open-loop move is given in the machine millimetres its saved servo steps/mm turn into those pulses, to the micrometre',
        'pulses-as-sent': 'the pulses reported are the ones the machine turns that rounded distance into',
        'rate-from-edited': 'the pulse rate is the speed times the servo steps/mm being edited',
        'bound-from-encoder':
          'the run gives up once the encoder has moved three times what the edited values predict, in machine millimetres',
      },
      why: {
        'machine-millimetres': 'the machine converts G-code millimetres with the steps/mm it has saved',
      },
    },
    () => {
      const plan = planCalibration({
        encoderStepsPerMM: 2400,
        servoStepsPerMM: 6400,
        distanceMm: 1,
        speedMmPerS: 1,
        device: { encoderStepsPerMM: 8192, servoStepsPerMM: 8192 },
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.request.moveMm).toBe(0.781); // 6400 pulses / 8192, to the micrometre
      expect(plan.request.pulses).toBe(6397); // trunc(781 um * 8192 / 1000)
      expect(plan.request.speedMmPerS * 8192).toBeCloseTo(6400, 6);
      expect(plan.request.maxTravelMm * 8192).toBeCloseTo(3 * 6397 * (2400 / 6400), 6);
      expect(plan.request.nominalMs).toBeCloseTo((6397 / 6400) * 1000, 6);
    },
  );

  behaviour(
    {
      id: 'motorcal.plan-limits',
      covers: 'src/domain/motorCalibration.ts#planCalibration',
      given: 'calibration settings that cannot be run',
      expect: {
        'unset-profile': 'zero steps/mm being edited cannot be planned',
        'unsaved-device': 'a machine with no saved steps/mm cannot be planned, and the reason says to write a configuration first',
        'zero-distance': 'a zero distance or speed cannot be planned',
        'too-far': 'a distance needing more pulses than the calibration allows cannot be planned, and the reason names the limit',
      },
    },
    () => {
      const device = { encoderStepsPerMM: 8192, servoStepsPerMM: 8192 };
      const base = { encoderStepsPerMM: 8192, servoStepsPerMM: 8192, distanceMm: 1, speedMmPerS: 1, device };
      expect(planCalibration({ ...base, servoStepsPerMM: 0 }).ok).toBe(false);
      const unsaved = planCalibration({ ...base, device: { encoderStepsPerMM: 0, servoStepsPerMM: 0 } });
      expect(unsaved.ok).toBe(false);
      if (!unsaved.ok) expect(unsaved.reason).toMatch(/Write a configuration/);
      expect(planCalibration({ ...base, distanceMm: 0 }).ok).toBe(false);
      expect(planCalibration({ ...base, speedMmPerS: 0 }).ok).toBe(false);
      const far = planCalibration({ ...base, distanceMm: 100 });
      expect(far.ok).toBe(false);
      if (!far.ok) expect(far.reason).toContain(String(CALIBRATION_MAX_PULSES));
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
        'how-far-off': 'the mismatch says how far off, in percent, the entered values are',
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
      const msg = a.findings.find((f) => f.id === 'ratio-mismatch')?.message ?? '';
      expect(msg).toContain('62.5% off');
    },
  );

  behaviour(
    {
      id: 'motorcal.measured-vs-expected-counts',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run of 6400 pulses each way on a 2400 counts per revolution encoder and a 6400 pulses per revolution drive',
      expect: {
        'pulses-sent': 'the pulses sent each way are reported',
        'counts-measured': 'the encoder counts that came back are reported as the average of the two directions',
        'counts-expected': 'the counts the entered steps/mm predict for those pulses are reported beside them',
        'reversed-negative': 'an encoder counting against the motion reads as negative counts',
      },
      why: { 'counts-measured': 'encoder counts for the pulses sent are the only thing the run measures' },
    },
    () => {
      const a = assessCalibration(done(6400, 2400 / 6400, 2380 / 6400), { encoderStepsPerMM: 8192, servoStepsPerMM: 8192 });
      expect(a.pulsesSent).toBe(6400);
      expect(a.countsMeasured).toBe(2390);
      expect(a.countsExpected).toBe(6400);
      const reversed = assessCalibration(done(6400, -2400 / 6400), { encoderStepsPerMM: 2400, servoStepsPerMM: 6400 });
      expect(reversed.countsMeasured).toBe(-2400);
      expect(reversed.countsExpected).toBe(2400);
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
      id: 'motorcal.unequal-scales-pass',
      covers: 'src/domain/motorCalibration.ts#assessCalibration',
      given: 'a run that matches a profile whose encoder and servo steps/mm differ',
      expect: {
        'only-matches': 'the only finding is that the profile matches the hardware',
      },
      why: { 'only-matches': 'the servo pulses the drive at the ratio of the two values, so they need not be equal' },
    },
    () => {
      const a = assessCalibration(done(6400, 2400 / 6400), { encoderStepsPerMM: 2400, servoStepsPerMM: 6400 });
      expect(ids(a)).toEqual(['matches']);
    },
  );

});

describe('motor calibration run', () => {
  const DEVICE: CalibrationProfile = { encoderStepsPerMM: 8192, servoStepsPerMM: 8192 };

  /**
   * A machine for the runner to drive: each accepted move carries the encoder
   * `countsPerPulse` per pulse over the move's nominal time, `lagMs` behind the
   * trajectory, then creeps on by `lateCounts` over the next 200 ms, as a
   * lagging drive does. A move that reverses the last one loses `slackCounts`
   * first. Every poll records a live sample.
   */
  function fakeMachine(opts: {
    countsPerPulse: number;
    lateCounts?: number;
    slackCounts?: number;
    lagMs?: number;
    acceptMoves?: boolean;
    disableAtMs?: number;
    neverSettles?: boolean;
  }) {
    let t = 0;
    let base = 0; // mm, where the last move started
    let cmdBase = 0; // mm, where the last move was commanded from
    let moveMm = 0;
    let moveStart = 0;
    let moveCountsTotal = 0;
    let moveMs = 1;
    let lastDir = -1;
    let enabled = true;
    let stopped = false;
    const samples: MotionSample[] = [];
    const frac = (ms: number) => Math.min(1, Math.max(0, ms / moveMs));
    const position = () => {
      if (opts.disableAtMs !== undefined && t >= opts.disableAtMs) enabled = false;
      const late = opts.lateCounts ?? 0;
      const into = t - moveStart;
      const lateFrac = Math.min(1, Math.max(0, (into - moveMs) / 200));
      const creep = opts.neverSettles ? Math.max(0, into - moveMs) / 50 : 0;
      return base + (moveCountsTotal * frac(into - (opts.lagMs ?? 0)) + late * lateFrac + creep) / DEVICE.encoderStepsPerMM;
    };
    const record = () =>
      samples.push({
        t: t / 1000,
        position: position(),
        commanded: cmdBase + moveMm * frac(t - moveStart),
        setpoint: cmdBase + moveMm,
      });
    const runner: CalibrationRunner = {
      move: (mm, speed) => {
        if (opts.acceptMoves === false) return Promise.resolve(false);
        base = position();
        cmdBase += moveMm;
        moveMm = mm;
        moveStart = t;
        const dir = Math.sign(mm);
        const pulses = Math.trunc((Math.round(mm * 1000) * DEVICE.servoStepsPerMM) / 1000);
        const slack = dir !== lastDir ? (opts.slackCounts ?? 0) : 0;
        lastDir = dir;
        moveCountsTotal = pulses * opts.countsPerPulse - dir * slack;
        moveMs = (Math.abs(mm) / speed) * 1000;
        return Promise.resolve(true);
      },
      position,
      samplesSince: (since) => samples.filter((s) => s.t >= since),
      clock: () => t / 1000,
      motionEnabled: () => {
        position();
        return enabled && !stopped;
      },
      testRunning: () => false,
      stop: () => {
        stopped = true;
        return Promise.resolve();
      },
      sleep: (ms) => {
        t += ms;
        record();
        return Promise.resolve();
      },
      now: () => t,
    };
    return { runner, wasStopped: () => stopped };
  }

  const plan = (distanceMm = 1): CalibrationRequest => {
    const p = planCalibration({ ...DEVICE, distanceMm, speedMmPerS: 1, device: DEVICE });
    if (!p.ok) throw new Error(p.reason);
    return p.request;
  };

  behaviour(
    {
      id: 'motorcal.run-measures-both-ways',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a machine whose encoder counts 0.375 per pulse, run 1 mm each way',
      expect: {
        'completes': 'the calibration completes',
        'pulses-both-ways': 'the pulses sent are reported, positive forward and negative back',
        'counts-both-ways': 'the encoder change each way is reported in counts, with the direction it moved',
      },
    },
    async () => {
      const { runner } = fakeMachine({ countsPerPulse: 0.375 });
      const run = await runCalibration(runner, plan(), DEVICE);
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.result.outcome).toBe('done');
      expect(run.result.pulsesForward).toBe(8192);
      expect(run.result.pulsesReverse).toBe(-8192);
      expect(run.result.countsForward).toBe(3072);
      expect(run.result.countsReverse).toBe(-3072);
    },
  );

  behaviour(
    {
      id: 'motorcal.run-reads-after-settling',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a drive that keeps moving the carriage for a moment after its last pulse',
      expect: {
        'late-movement-counted': 'the encoder is read only once the carriage has held still, so the late movement is counted',
      },
      why: { 'late-movement-counted': `a step and direction drive lags the pulses it is sent; the run waits ${CALIBRATION_SETTLE_MS} ms of stillness` },
    },
    async () => {
      const { runner } = fakeMachine({ countsPerPulse: 1, lateCounts: 40 });
      const run = await runCalibration(runner, plan(), DEVICE);
      expect(run.ok && run.result.countsForward).toBe(8192 + 40);
    },
  );

  behaviour(
    {
      id: 'motorcal.run-refusals',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a calibration asked for while motion is off, or while the machine turns the move down',
      expect: {
        'motion-off': 'with motion off the calibration does not run and says to enable motion',
        'move-refused': 'a move the machine turns down ends the calibration as busy',
      },
    },
    async () => {
      const off = fakeMachine({ countsPerPulse: 1 });
      await off.runner.stop();
      const r1 = await runCalibration(off.runner, plan(), DEVICE);
      expect(r1.ok && r1.result.outcome).toBe('refused-motion-disabled');
      expect(OUTCOME_TEXT['refused-motion-disabled']).toMatch(/enable motion/);
      const busy = fakeMachine({ countsPerPulse: 1, acceptMoves: false });
      const r2 = await runCalibration(busy.runner, plan(), DEVICE);
      expect(r2.ok && r2.result.outcome).toBe('refused-busy');
    },
  );

  behaviour(
    {
      id: 'motorcal.run-stops-on-overtravel',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a drive that carries the encoder five times further than the profile predicts',
      expect: {
        'abandoned': 'the calibration is abandoned as overtravelled',
        'motion-disabled': 'motion is disabled to stop the carriage',
      },
      why: { 'abandoned': 'a drive set far finer than the profile claims carries the carriage much further than asked' },
    },
    async () => {
      const m = fakeMachine({ countsPerPulse: 5 });
      const run = await runCalibration(m.runner, plan(), DEVICE);
      expect(run.ok && run.result.outcome).toBe('aborted-overtravel');
      expect(m.wasStopped()).toBe(true);
    },
  );

  behaviour(
    {
      id: 'motorcal.run-motion-disabled-midway',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'motion disabled part way through the forward move',
      expect: { 'abandoned': 'the calibration ends, saying motion was disabled' },
    },
    async () => {
      const m = fakeMachine({ countsPerPulse: 1, disableAtMs: 300 });
      const run = await runCalibration(m.runner, plan(), DEVICE);
      expect(run.ok && run.result.outcome).toBe('aborted-motion-disabled');
    },
  );

  behaviour(
    {
      id: 'motorcal.run-timeout',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a carriage that never comes to rest after its move',
      expect: {
        'abandoned': 'the calibration gives up after twice the move time plus three seconds, saying the carriage kept moving',
        'motion-disabled': 'motion is disabled to stop the carriage',
      },
    },
    async () => {
      const m = fakeMachine({ countsPerPulse: 1, neverSettles: true });
      const run = await runCalibration(m.runner, plan(), DEVICE);
      expect(run.ok && run.result.outcome).toBe('aborted-timeout');
      expect(m.wasStopped()).toBe(true);
      expect(m.runner.now()).toBeLessThanOrEqual(2 * 1000 + 3000 + 200);
    },
  );

  behaviour(
    {
      id: 'motorcal.run-takes-up-slack',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a drive that loses 13 encoder counts of motion every time it reverses, counting one count per pulse',
      expect: {
        'ratio-clean': 'the measured legs count exactly one per pulse, because a take-up move in the same direction comes first',
        'lost-motion-reported': 'the motion lost on reversal is reported as 13 counts',
      },
      why: { 'ratio-clean': 'slack taken up on a reversal is not part of the drive-to-encoder ratio' },
    },
    async () => {
      const { runner } = fakeMachine({ countsPerPulse: 1, slackCounts: 13 });
      const run = await runCalibration(runner, plan(), DEVICE);
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.result.countsForward).toBe(8192);
      expect(run.result.countsReverse).toBe(-8192);
      expect(run.result.lostMotionCounts).toBe(13);
    },
  );

  behaviour(
    {
      id: 'motorcal.run-measures-drive-lag',
      covers: 'src/domain/motorCalibration.ts#runCalibration',
      given: 'a drive whose encoder follows the pulses 5 ms late',
      expect: { 'lag-reported': 'the drive lag is reported as 5 ms' },
    },
    async () => {
      const { runner } = fakeMachine({ countsPerPulse: 1, lagMs: 5 });
      const run = await runCalibration(runner, plan(), DEVICE);
      expect(run.ok && run.result.lagSeconds).toBeCloseTo(0.005, 3);
    },
  );
});
