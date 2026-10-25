import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  BENCHMARK_TRAVEL_MAX_MM,
  KP_MIN,
  estimateLagSeconds,
  measureMove,
  planTrackingRun,
  runTracking,
  settleToleranceMm,
  suggestGains,
  summarizeTracking,
  type MachineLimits,
  type MotionSample,
  type MoveMeasurement,
  type TrackingMove,
  type TrackingRunner,
} from './motionBenchmark';

const LIMITS: MachineLimits = {
  maxPositionMm: 100,
  maxVelocityMmPerS: 50,
  maxAccelMmPerS2: 600,
  encoderStepsPerMM: 8192,
};

const MOVE: TrackingMove = { label: '+1 mm', deltaMm: 1, speedMmPerS: 1 };

/** Samples every 10 ms from `trace(tSeconds)` over `seconds`. */
function trace(seconds: number, f: (t: number) => { position: number; commanded: number; setpoint: number }) {
  const out: MotionSample[] = [];
  for (let i = 0; i <= seconds * 100; i++) {
    const t = i / 100;
    out.push({ t, ...f(t) });
  }
  return out;
}

describe('tracking program', () => {
  behaviour(
    {
      id: 'benchmark.program-from-profile',
      covers: 'src/domain/motionBenchmark.ts#planTrackingRun',
      given: 'a saved profile of 100 mm travel, 50 mm/s and 600 mm/s²',
      expect: {
        'largest-move': 'the largest move is a quarter of the travel, 25 mm, swung half each side of the start',
        'full-speed': 'one large move runs at the full 50 mm/s',
        'small-moves': 'there are 1 mm, 0.1 mm and 0.01 mm moves in both directions, and two 0.1 mm moves the same way',
        'returns-to-start': 'the moves add up to nothing, so the carriage ends where it started',
      },
    },
    () => {
      const plan = planTrackingRun(LIMITS);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.travelMm).toBe(25);
      expect(Math.max(...plan.moves.map((m) => Math.abs(m.deltaMm)))).toBe(25);
      expect(plan.moves.some((m) => m.speedMmPerS === 50)).toBe(true);
      for (const d of [1, 0.1, 0.01]) {
        expect(plan.moves.some((m) => m.deltaMm === d)).toBe(true);
        expect(plan.moves.some((m) => m.deltaMm === -d || m.deltaMm === -2 * d)).toBe(true);
      }
      expect(plan.moves.filter((m) => m.deltaMm === 0.1)).toHaveLength(2);
      expect(plan.moves.reduce((a, m) => a + m.deltaMm, 0)).toBeCloseTo(0, 9);
    },
  );

  behaviour(
    {
      id: 'benchmark.program-limits',
      covers: 'src/domain/motionBenchmark.ts#planTrackingRun',
      given: 'saved profiles that are long, or missing their motion envelope',
      expect: {
        'capped-travel': `on a long machine the largest move is capped at ${BENCHMARK_TRAVEL_MAX_MM} mm`,
        'needs-envelope': 'without Position Max, Velocity Max or Acceleration Max no program is planned, and the reason names them',
      },
    },
    () => {
      const long = planTrackingRun({ ...LIMITS, maxPositionMm: 1000 });
      expect(long.ok && long.travelMm).toBe(BENCHMARK_TRAVEL_MAX_MM);
      const none = planTrackingRun({ ...LIMITS, maxAccelMmPerS2: 0 });
      expect(none.ok).toBe(false);
      if (!none.ok) expect(none.reason).toMatch(/Acceleration Max/);
    },
  );
});

describe('measuring a move', () => {
  behaviour(
    {
      id: 'benchmark.measures-a-move',
      covers: 'src/domain/motionBenchmark.ts#measureMove',
      given:
        'a 1 mm move whose encoder trails the trajectory by up to 20 µm, runs 5 µm past the target, and comes to rest 0.5 µm short',
      expect: {
        'final-error': 'the stop error is the settled position minus the target: −0.5 µm',
        'following': 'the peak following error is the largest gap between trajectory and encoder',
        'overshoot': 'the overshoot is how far it went past the target: 5 µm',
        'settle': 'the settle time runs from the trajectory reaching the target to the encoder staying within tolerance',
      },
    },
    () => {
      const samples = trace(1.6, (t) => {
        const commanded = Math.min(1, t);
        let position = commanded - 0.02 * Math.min(1, t * 5);
        if (t >= 1) position = t < 1.2 ? 1.005 : t < 1.4 ? 1.0005 : 0.9995;
        return { position, commanded, setpoint: 1 };
      });
      const m = measureMove(samples, MOVE, settleToleranceMm(8192));
      expect(m).not.toBeNull();
      if (!m) return;
      expect(m.finalErrorUm).toBeCloseTo(-0.5, 6);
      expect(m.peakFollowingErrorUm).toBeCloseTo(20, 3);
      expect(m.overshootUm).toBeCloseTo(5, 6);
      expect(m.settleMs).toBeCloseTo(200, 3);
    },
  );

  behaviour(
    {
      id: 'benchmark.drive-lag',
      covers: 'src/domain/motionBenchmark.ts#estimateLagSeconds',
      given: 'an open-loop move at 2 mm/s whose encoder follows the trajectory 4 ms late and covers 1.2 times the distance',
      expect: { 'lag-found': 'the drive lag reads as 4 ms, unaffected by the encoder covering more distance' },
      why: { 'lag-found': 'a profile whose steps/mm are slightly off must not read as lag' },
    },
    () => {
      // Sampled until the encoder has caught up, as a measured leg is.
      const samples = trace(2.5, (t) => {
        const commanded = Math.min(4, 2 * t);
        return { commanded, position: 1.2 * Math.min(4, Math.max(0, 2 * (t - 0.004))), setpoint: 4 };
      });
      expect(estimateLagSeconds(samples, 2)).toBeCloseTo(0.004, 4);
    },
  );
});

function measured(finalErrorUm: number, deltaMm = 1): MoveMeasurement {
  return {
    label: '',
    deltaMm,
    speedMmPerS: 1,
    finalErrorUm,
    peakFollowingErrorUm: 0,
    overshootUm: 0,
    settleMs: 0,
  };
}

describe('gain suggestion', () => {
  behaviour(
    {
      id: 'benchmark.kp-limits',
      covers: 'src/domain/motionBenchmark.ts#suggestGains',
      given: 'a 600 mm/s², 50 mm/s profile, with a drive lag of 100 ms, then of 1 ms',
      expect: {
        'lag-cap': 'with 100 ms of lag Kp is 0.5 ÷ lag: 5 /s',
        'envelope-cap': 'with 1 ms of lag Kp is Acceleration Max ÷ Velocity Max: 12 /s',
        'floor': `Kp never goes below ${KP_MIN} /s`,
      },
      why: {
        'lag-cap': 'past about 0.5 ÷ lag the correction arrives too late and the carriage rings',
        'envelope-cap': 'a larger Kp asks for more than the acceleration limit on an ordinary error',
      },
    },
    () => {
      const summary = summarizeTracking([measured(0)]);
      expect(suggestGains({ lagSeconds: 0.1, limits: LIMITS, summary }).kp).toBe(5);
      expect(suggestGains({ lagSeconds: 0.001, limits: LIMITS, summary }).kp).toBe(12);
      expect(suggestGains({ lagSeconds: 10, limits: LIMITS, summary }).kp).toBe(KP_MIN);
    },
  );

  behaviour(
    {
      id: 'benchmark.ki-only-for-bias',
      covers: 'src/domain/motionBenchmark.ts#suggestGains',
      given: 'tracking runs whose moves end on target, and ones whose moves all end 3 µm short',
      expect: {
        'no-bias-no-ki': 'when moves end on target Ki is 0',
        'bias-ki': 'when moves end short in the direction of travel Ki is Kp² ÷ 8',
      },
      why: { 'bias-ki': 'Kp² ÷ 8 damps the integral at a ratio of about 0.7' },
    },
    () => {
      const onTarget = summarizeTracking([measured(0.2), measured(-0.3, -1)]);
      expect(suggestGains({ lagSeconds: 0.1, limits: LIMITS, summary: onTarget }).ki).toBe(0);
      const short = summarizeTracking([measured(-3), measured(3, -1)]);
      expect(short.directionalBiasUm).toBeCloseTo(-3, 6);
      const g = suggestGains({ lagSeconds: 0.1, limits: LIMITS, summary: short });
      expect(g.ki).toBeCloseTo((5 * 5) / 8, 2);
    },
  );
});

describe('tracking run', () => {
  /** A closed-loop machine: the encoder follows the trajectory with a first-order lag. */
  function fakeServo(opts: { accept?: boolean; overtravel?: boolean } = {}) {
    let t = 0;
    let pos = 0;
    let cmdFrom = 0;
    let target = 0;
    let moveStart = 0;
    let moveSec = 0;
    const samples: MotionSample[] = [];
    const commanded = () => cmdFrom + (target - cmdFrom) * Math.min(1, (t - moveStart) / Math.max(moveSec, 1e-9));
    const runner: TrackingRunner = {
      jog: (mm, speed) => {
        if (opts.accept === false) return Promise.resolve(false);
        cmdFrom = target;
        target = target + (opts.overtravel ? mm * 10 : mm);
        moveStart = t;
        moveSec = Math.abs(mm) / speed;
        return Promise.resolve(true);
      },
      samplesSince: (since) => samples.filter((s) => s.t >= since),
      clock: () => t,
      motionEnabled: () => true,
      stop: () => Promise.resolve(),
      sleep: (ms) => {
        const steps = Math.round(ms / 10);
        for (let i = 0; i < steps; i++) {
          t += 0.01;
          const c = commanded();
          pos += (c - pos) * 0.5;
          if (Math.abs(c - pos) < 1e-7) pos = c;
          samples.push({ t, position: pos, commanded: c, setpoint: target });
        }
        return Promise.resolve();
      },
      now: () => t * 1000,
    };
    return runner;
  }

  const moves: TrackingMove[] = [
    { label: 'a', deltaMm: 1, speedMmPerS: 10 },
    { label: 'b', deltaMm: -1, speedMmPerS: 10 },
  ];

  behaviour(
    {
      id: 'benchmark.run-measures-every-move',
      covers: 'src/domain/motionBenchmark.ts#runTracking',
      given: 'a servo that follows its trajectory closely and settles on each target',
      expect: {
        'completes': 'the program completes',
        'each-move': 'every move in the program is measured',
        'on-target': 'each move ends on its target',
      },
    },
    async () => {
      const run = await runTracking(fakeServo(), moves, LIMITS);
      expect(run.outcome).toBe('done');
      expect(run.measurements).toHaveLength(2);
      for (const m of run.measurements) expect(Math.abs(m.finalErrorUm)).toBeLessThan(1);
    },
  );

  behaviour(
    {
      id: 'benchmark.run-stops',
      covers: 'src/domain/motionBenchmark.ts#runTracking',
      given: 'a machine that turns a move down, and one that carries the carriage ten times further than a move asks',
      expect: {
        'refused': 'a move turned down ends the run as refused',
        'overtravel': 'a carriage going more than 2 mm past a move ends the run as overtravelled',
      },
    },
    async () => {
      expect((await runTracking(fakeServo({ accept: false }), moves, LIMITS)).outcome).toBe('move-refused');
      expect((await runTracking(fakeServo({ overtravel: true }), moves, LIMITS)).outcome).toBe('aborted-overtravel');
    },
  );
});
