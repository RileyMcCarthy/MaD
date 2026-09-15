/**
 * The 1 µm delay-fit matcher, against synthetic records.
 *
 * A delayed perfect trapezoid or sine must pass. A rate error or an amplitude
 * error must still fail after the delay is fitted — that is the whole point
 * of allowing a phase shift.
 */
import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  SHIPPED_ACCEL_MM_S2,
  assertArrivedAtUm,
  assertFollowsLinearUm,
  assertFollowsSineWindowUm,
  trapezoidTravelUm,
  trapezoidTimes,
} from '../../e2e/motion-accuracy.mjs';

const silent = { log: () => {} };

type Series = { time: number[]; pos: number[]; setpoint: number[] };

function seriesFrom(
  fn: (t: number) => number,
  { tEndS, dtS = 0.01, startUm = 0 }: { tEndS: number; dtS?: number; startUm?: number },
): Series {
  const time: number[] = [];
  const pos: number[] = [];
  const setpoint: number[] = [];
  for (let t = 0; t <= tEndS + 1e-12; t += dtS) {
    const um = startUm + fn(t);
    time.push(Math.round(t * 1e6));
    setpoint.push(um);
    pos.push(um);
  }
  return { time, pos, setpoint };
}

describe('motion accuracy matcher', () => {
  behaviour(
    {
      id: 'motion.linear-follows-trapezoid-after-delay',
      covers: 'e2e/motion-accuracy.mjs#assertFollowsLinearUm',
      given: 'a recorded linear move whose commanded profile is the trapezoid of the request, shifted by a few milliseconds',
      expect: {
        'follows-profile':
          'after a time delay the commanded profile stays on that trapezoid through the cruise',
        'arrives': 'the gantry ends on the commanded position within 0.001 mm',
      },
    },
    () => {
      const distanceMm = 10;
      const velocityMmS = 10;
      const distUm = distanceMm * 1000;
      const vUmS = velocityMmS * 1000;
      const aUmS2 = SHIPPED_ACCEL_MM_S2 * 1000;
      const { tTotal } = trapezoidTimes(distUm, vUmS, aUmS2);
      const delayS = 0.008;
      const s = seriesFrom(
        (t) => trapezoidTravelUm(distUm, vUmS, aUmS2, t - delayS),
        { tEndS: tTotal + 0.25 },
      );
      expect(() =>
        assertFollowsLinearUm(s, { velocityMmS, distanceMm, label: 'delayed-trap', ...silent }),
      ).not.toThrow();
    },
  );

  behaviour(
    {
      id: 'motion.linear-rate-error-is-visible',
      covers: 'e2e/motion-accuracy.mjs#assertFollowsLinearUm',
      given: 'a recorded linear move whose commanded profile travels 1 percent faster than the request',
      expect: {
        'residual-grows': 'aligning by delay still leaves more than 0.001 mm of error',
      },
    },
    () => {
      const distanceMm = 50;
      const velocityMmS = 10;
      const distUm = distanceMm * 1000;
      const vUmS = velocityMmS * 1000;
      const aUmS2 = SHIPPED_ACCEL_MM_S2 * 1000;
      const { tTotal } = trapezoidTimes(distUm, vUmS, aUmS2);
      const s = seriesFrom(
        (t) => trapezoidTravelUm(distUm, vUmS * 1.01, aUmS2, t),
        { tEndS: tTotal + 0.25 },
      );
      expect(() =>
        assertFollowsLinearUm(s, { velocityMmS, distanceMm, label: 'fast-trap', ...silent }),
      ).toThrow(/of the trapezoid/);
    },
  );

  behaviour(
    {
      id: 'motion.arrival-rejects-a-missed-target',
      covers: 'e2e/motion-accuracy.mjs#assertArrivedAtUm',
      given: 'a recorded move that comes to rest 0.003 mm from the commanded position',
      expect: {
        rejected: 'the arrival check does not accept that rest position',
      },
    },
    () => {
      const time: number[] = [];
      const pos: number[] = [];
      const setpoint: number[] = [];
      for (let i = 0; i < 30; i++) {
        time.push(i * 10_000);
        setpoint.push(8000);
        pos.push(8003);
      }
      expect(() => assertArrivedAtUm({ time, pos, setpoint }, 8000, 'miss', silent)).toThrow(
        /gantry ends on the target/,
      );
    },
  );

  behaviour(
    {
      id: 'motion.sine-follows-after-phase',
      covers: 'e2e/motion-accuracy.mjs#assertFollowsSineWindowUm',
      given: 'a recorded sine whose commanded profile is the request, shifted in phase',
      expect: {
        'follows-profile':
          'after a phase delay the commanded waveform stays within 0.001 mm of the request',
      },
    },
    () => {
      const amplitudeMm = 5;
      const frequencyHz = 1;
      const centreMm = 6;
      const delayS = 0.12;
      const w = 2 * Math.PI * frequencyHz;
      const s = seriesFrom(
        (t) => centreMm * 1000 + amplitudeMm * 1000 * Math.cos(w * (t - delayS)),
        { tEndS: 2.2, dtS: 0.01, startUm: 0 },
      );
      // seriesFrom adds startUm to fn(t); fn already includes centre.
      const shifted = {
        time: s.time,
        pos: s.pos.map((p) => p),
        setpoint: s.setpoint.map((p) => p),
      };
      expect(() =>
        assertFollowsSineWindowUm(shifted, {
          amplitudeMm,
          frequencyHz,
          centreMm,
          tMinS: 0.05,
          tMaxS: 2.05,
          label: 'delayed-sine',
          ...silent,
        }),
      ).not.toThrow();
    },
  );

  behaviour(
    {
      id: 'motion.sine-amplitude-error-is-visible',
      covers: 'e2e/motion-accuracy.mjs#assertFollowsSineWindowUm',
      given: 'a recorded sine whose commanded profile is 0.002 mm larger than the request',
      expect: {
        'residual-stays': 'aligning by phase still leaves more than 0.001 mm of error',
      },
    },
    () => {
      const amplitudeMm = 5;
      const frequencyHz = 1;
      const centreMm = 6;
      const w = 2 * Math.PI * frequencyHz;
      const s = seriesFrom(
        (t) => (amplitudeMm + 0.002) * 1000 * Math.cos(w * t),
        { tEndS: 2.2, dtS: 0.01, startUm: centreMm * 1000 },
      );
      expect(() =>
        assertFollowsSineWindowUm(s, {
          amplitudeMm,
          frequencyHz,
          centreMm,
          tMinS: 0.05,
          tMaxS: 2.05,
          label: 'fat-sine',
          ...silent,
        }),
      ).toThrow(/of the request/);
    },
  );
});
