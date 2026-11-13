/**
 * Unit coverage for density-independent waveform / path metrics.
 *
 * The fixtures are records shaped like the board's: a clean ~600 Hz record,
 * the same decimated to the ~40 Hz a contended CI runner records, and an idle
 * teardown tail of a parked gantry wobbling between samples.
 */
import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  waveformWindow,
  resampledPathMm,
  assertSineMatch,
  assertWaveformExcursion,
  sineFollowWindow,
} from './waveformMetrics.mjs';

/** WAVE-sine-fast catalog geometry (M10). */
const WAVE = {
  amplitudeMm: 3,
  frequencyHz: 2,
  cycles: 3,
  centreMm: 5,
} as const;

const WAVE_DUR_S = WAVE.cycles / WAVE.frequencyHz; // 1.5 s

type Series = { time: number[]; pos: number[] }; // µs, µm

/**
 * A waveform move as the board records it, in WAVE's geometry: rest at 0, a
 * straight approach to the bottom of the stroke, a 0.3 s park, whole cycles
 * rising from rest there about the centre, then parked where the wave ended,
 * wobbling between samples, for 0.1 s plus `idleTailS`. `amplitudeMm` is the
 * swing the machine actually made, which a test may set short of WAVE's.
 */
function synthWave(
  sampleHz: number,
  shape: 'sine' | 'triangle',
  { idleTailS = 0, amplitudeMm = WAVE.amplitudeMm as number } = {},
): Series {
  const dtUs = Math.round(1e6 / sampleHz);
  const bottomUm = (WAVE.centreMm - amplitudeMm) * 1000;
  const approachStart = 200_000;
  const waveStart = approachStart + 500_000 + 300_000;
  const waveEnd = waveStart + WAVE_DUR_S * 1e6;
  const at = (t: number): number => {
    if (t < approachStart) return 0;
    if (t < waveStart - 300_000) return (bottomUm * (t - approachStart)) / 500_000;
    if (t < waveStart) return bottomUm;
    if (t <= waveEnd) {
      // Both rise from the bottom: -cos, and the triangle in phase with it.
      const theta = 2 * Math.PI * WAVE.frequencyHz * ((t - waveStart) / 1e6);
      const unit = shape === 'sine' ? -Math.cos(theta) : (2 / Math.PI) * Math.asin(Math.sin(theta - Math.PI / 2));
      return WAVE.centreMm * 1000 + amplitudeMm * 1000 * unit;
    }
    // A wobble big enough that a consecutive-sample "parked" test would read
    // motion at sparse rates, while staying within 60 µm of the rest position.
    return bottomUm + ((t / dtUs) % 3) * 30;
  };
  const time: number[] = [];
  const pos: number[] = [];
  for (let t = 0; t <= waveEnd + 100_000 + idleTailS * 1e6; t += dtUs) {
    time.push(t);
    pos.push(at(t));
  }
  return { time, pos };
}

/** Decimate a dense series to ~targetHz (keeps endpoints). */
function decimate(series: Series, targetHz: number): Series {
  const dtUs = Math.round(1e6 / targetHz);
  const time: number[] = [];
  const pos: number[] = [];
  let next = series.time[0];
  for (let i = 0; i < series.time.length; i++) {
    if (series.time[i] >= next || i === series.time.length - 1) {
      time.push(series.time[i]);
      pos.push(series.pos[i]);
      next = series.time[i] + dtUs;
    }
  }
  return { time, pos };
}

/**
 * Parked-gantry wobble on the idle teardown tail: 0, 60, 120, 180 µm in turn.
 * Big enough that neighbouring sparse samples differ by far more than the old
 * consecutive-sample 50 µm rule, and enough idle path to matter (the CI case
 * reported 42 mm as 62.8 mm), yet every sample stays inside the 200 µm
 * rest band that resampledPathMm trims by.
 */
const TAIL_DRIFT_STEP_UM = 60;
const TAIL_DRIFT_PHASES = 4;

/** Commanded travel of synthMultiSetPath: (+8,-8)×2 + (+5,-5). */
const MULTI_SET_COMMANDED_MM = 42;
/** How close the measured path must land to the commanded travel. */
const PATH_TOLERANCE_MM = 1.5;

/** Append a parked idle tail at the final position. */
function appendIdleTail(series: Series, tailS: number, sampleHz: number): Series {
  const dtUs = Math.round(1e6 / sampleHz);
  const time = series.time.slice();
  const pos = series.pos.slice();
  const rest = pos[pos.length - 1];
  let t = time[time.length - 1] + dtUs;
  const end = time[time.length - 1] + tailS * 1e6;
  while (t <= end) {
    const driftUm = (Math.round(t / dtUs) % TAIL_DRIFT_PHASES) * TAIL_DRIFT_STEP_UM;
    time.push(t);
    pos.push(rest + driftUm);
    t += dtUs;
  }
  return { time, pos };
}

/** Multi-set TC1-style path: (+8,-8)×2 + (+5,-5) = 42 mm commanded travel. */
function synthMultiSetPath(sampleHz: number, { idleTailS = 0 } = {}): Series {
  const dtUs = Math.round(1e6 / sampleHz);
  const segments = [8, -8, 8, -8, 5, -5]; // mm
  const vel = 10; // mm/s
  const time: number[] = [];
  const pos: number[] = [];
  let t = 0;
  let p = 0;
  // Brief rest prefix.
  for (; t < 100_000; t += dtUs) {
    time.push(t);
    pos.push(0);
  }
  for (const dist of segments) {
    const durS = Math.abs(dist) / vel;
    const startT = t;
    const startP = p;
    const endT = startT + durS * 1e6;
    for (; t <= endT; t += dtUs) {
      const frac = (t - startT) / (durS * 1e6);
      time.push(t);
      pos.push((startP + dist * frac) * 1000);
    }
    p = startP + dist;
  }
  const parkEnd = t + 50_000 + idleTailS * 1e6;
  for (; t <= parkEnd; t += dtUs) {
    const driftUm = ((t / dtUs) % 3) * 40;
    time.push(t);
    pos.push(p * 1000 + driftUm);
  }
  return { time, pos };
}

/**
 * WAVE-sine-small catalog geometry (M10), set off from the TOP: the mirror of
 * the bottom start a positive amplitude makes, approached at the wave's own
 * peak speed, so the approach is as fast as anything in the wave.
 */
const FROM_TOP = { amplitudeMm: 2, frequencyHz: 0.5, cycles: 2, centreMm: 4 } as const;
/** Where the synthetic record below leaves the top, and returns to it. */
const FROM_TOP_WAVE_START_S = 0.2 + (FROM_TOP.centreMm + FROM_TOP.amplitudeMm) /
  (2 * Math.PI * FROM_TOP.frequencyHz * FROM_TOP.amplitudeMm) + 0.4;
const FROM_TOP_WAVE_END_S = FROM_TOP_WAVE_START_S + FROM_TOP.cycles / FROM_TOP.frequencyHz;

/**
 * A waveform move as the board records it: rest at 0, a straight approach to
 * the TOP of the stroke at the wave's own peak speed, a 0.4 s park while that
 * move settles, the cosine falling first from rest for whole cycles, a park,
 * and the return to the centre. A micrometre of servo jitter throughout.
 */
function synthWaveFromTop(sampleHz: number): Series {
  const dtUs = Math.round(1e6 / sampleHz);
  const { amplitudeMm: A, frequencyHz: f, cycles, centreMm } = FROM_TOP;
  const top = centreMm + A;
  const speed = 2 * Math.PI * f * A; // mm/s
  const approachEnd = 0.2 + top / speed;
  const returnEnd = FROM_TOP_WAVE_END_S + 0.4 + A / speed;
  const at = (s: number): number => {
    if (s < 0.2) return 0;
    if (s < approachEnd) return speed * (s - 0.2);
    if (s < FROM_TOP_WAVE_START_S) return top;
    if (s < FROM_TOP_WAVE_END_S) return centreMm + A * Math.cos(2 * Math.PI * f * (s - FROM_TOP_WAVE_START_S));
    if (s < FROM_TOP_WAVE_END_S + 0.4) return top;
    if (s < returnEnd) return top - speed * (s - FROM_TOP_WAVE_END_S - 0.4);
    return centreMm;
  };
  const time: number[] = [];
  const pos: number[] = [];
  for (let t = 0, k = 0; t <= (returnEnd + 0.5) * 1e6; t += dtUs, k++) {
    time.push(t);
    pos.push(at(t / 1e6) * 1000 + (k % 2 === 0 ? 1 : -1));
  }
  return { time, pos };
}

function toMmSeries(series: Series) {
  return {
    posMm: series.pos.map((p) => p / 1000),
    tS: series.time.map((t) => t / 1e6),
  };
}

describe('waveformWindow', () => {
  behaviour(
    {
      id: 'motion.window-same-at-any-sample-rate',
      covers: 'e2e/waveformMetrics.mjs#waveformWindow',
      given: 'the same 3 mm, 2 Hz, three-cycle sine recorded at about 600 Hz and again at about 40 Hz',
      expect: {
        'same-span': 'both records give a wave window 1.5 s long, within 0.05 s of each other',
        'same-excursion': 'both windows span 6 mm peak to peak, within 0.15 mm of each other',
      },
    },
    () => {
      const dense = synthWave(600, 'sine');
      const sparse = decimate(dense, 40);

      const d = toMmSeries(dense);
      const s = toMmSeries(sparse);
      const winD = waveformWindow(d.posMm, d.tS, WAVE);
      const winS = waveformWindow(s.posMm, s.tS, WAVE);

      const spanD = winD.t[winD.t.length - 1] - winD.t[0];
      const spanS = winS.t[winS.t.length - 1] - winS.t[0];
      expect(spanD).toBeCloseTo(WAVE_DUR_S, 1);
      expect(spanS).toBeCloseTo(WAVE_DUR_S, 1);
      expect(Math.abs(spanD - spanS)).toBeLessThan(0.05);

      const excD = Math.max(...winD.p) - Math.min(...winD.p);
      const excS = Math.max(...winS.p) - Math.min(...winS.p);
      expect(excD).toBeCloseTo(2 * WAVE.amplitudeMm, 1);
      expect(excS).toBeCloseTo(2 * WAVE.amplitudeMm, 1);
      expect(Math.abs(excD - excS)).toBeLessThan(0.15);
    },
  );

  behaviour(
    {
      id: 'motion.window-ignores-parked-teardown',
      covers: 'e2e/waveformMetrics.mjs#waveformWindow',
      given: 'a 40 Hz sine record followed by 2 s of the gantry parked and wobbling where the wave ended',
      expect: {
        'measures-the-wave': 'the wave window still covers the 1.5 s of sine and spans the 6 mm of the wave',
      },
    },
    () => {
      const dense = synthWave(600, 'sine');
      const sparse = decimate(dense, 40);
      const withTail = appendIdleTail(sparse, 2.0, 40); // long idle like CI teardown

      const { posMm, tS } = toMmSeries(withTail);
      const win = waveformWindow(posMm, tS, WAVE);
      const span = win.t[win.t.length - 1] - win.t[0];
      expect(span).toBeCloseTo(WAVE_DUR_S, 1);

      const excursion = Math.max(...win.p) - Math.min(...win.p);
      // Must measure the wave (6 mm), not the approach plus part of it (up to 8 mm).
      expect(excursion).toBeCloseTo(2 * WAVE.amplitudeMm, 1);
      expect(excursion).toBeLessThan(WAVE.centreMm + WAVE.amplitudeMm);

      // The window's mean sits on the wave's centre, not pulled toward the approach.
      const mean = win.p.reduce((a, b) => a + b, 0) / win.p.length;
      expect(mean).toBeGreaterThan(WAVE.centreMm - 1);
    },
  );
});

describe('waveformWindow, a wave run from rest at the top', () => {
  behaviour(
    {
      id: 'motion.window-skips-approach-into-park',
      covers: 'e2e/waveformMetrics.mjs#waveformWindow',
      given:
        'a 2 mm, 0.5 Hz, two-cycle sine from rest at the top, approached at its peak speed with a 0.4 s park, sampled at 600 Hz and 40 Hz',
      expect: {
        'window-on-wave': 'the measured stretch starts and ends within a twentieth of a cycle of the wave itself',
        'sine-check-passes': 'the sine check accepts the record as the commanded wave about its commanded centre',
      },
      why: {
        'window-on-wave':
          'an approach as fast as the wave carries more travel per second than the final rise of the wave as it brakes into the top, so the stretch with the most travel can begin inside the approach; whole cycles start at rest and end where they began, and the approach does neither',
      },
    },
    () => {
      const dense = synthWaveFromTop(600);
      const tolS = 0.05 / FROM_TOP.frequencyHz;
      for (const series of [dense, decimate(dense, 40)]) {
        const { posMm, tS } = toMmSeries(series);
        const win = waveformWindow(posMm, tS, FROM_TOP);
        expect(Math.abs(win.t[0] - FROM_TOP_WAVE_START_S)).toBeLessThan(tolS);
        expect(Math.abs(win.t[win.t.length - 1] - FROM_TOP_WAVE_END_S)).toBeLessThan(tolS);
        expect(() => assertSineMatch(series, FROM_TOP, 'from-top')).not.toThrow();
      }
    },
  );
});

/** WAVE-sine catalog geometry (M10), for the commanded setpoint. */
const FOLLOW = { amplitudeMm: 5, frequencyHz: 1, cycles: 2, centreMm: 6 } as const;

/**
 * The commanded setpoint of a waveform move, 1 kHz: rest at 0, a 10 mm/s
 * approach to the peak the wave sets off from (the bottom, or the top when
 * `fromTop`), a 0.4 s park, the cosine away from that peak for whole cycles,
 * then rest on it.
 */
function synthSetpoint(fromTop: boolean) {
  const { amplitudeMm: A, frequencyHz: f, cycles, centreMm } = FOLLOW;
  const startPeak = fromTop ? centreMm + A : centreMm - A;
  const approachEndS = 0.2 + startPeak / 10;
  const waveStartS = approachEndS + 0.4;
  const waveEndS = waveStartS + cycles / f;
  const at = (s: number): number => {
    if (s < 0.2) return 0;
    if (s < approachEndS) return 10 * (s - 0.2);
    if (s < waveStartS) return startPeak;
    if (s < waveEndS) return centreMm + (fromTop ? A : -A) * Math.cos(2 * Math.PI * f * (s - waveStartS));
    return startPeak;
  };
  const time: number[] = [];
  const setpoint: number[] = [];
  for (let t = 0; t <= (waveEndS + 0.5) * 1e6; t += 1000) {
    time.push(t);
    setpoint.push(at(t / 1e6) * 1000);
  }
  return { time, setpoint, waveStartS, waveEndS };
}

describe('sineFollowWindow', () => {
  behaviour(
    {
      id: 'motion.sine-follow-window-inside-the-wave',
      covers: 'e2e/waveformMetrics.mjs#sineFollowWindow',
      given:
        'a commanded 5 mm, 1 Hz, two-cycle sine set off from rest at the bottom of the stroke, and the same wave set off from the top',
      expect: {
        'starts-after-leaving-peak':
          'the comparison starts once the wave has moved a fifth of its swing away from the peak it set off from',
        'ends-inside-wave': 'the comparison ends half a cycle before the wave does, give or take where it started',
      },
    },
    () => {
      // A cosine is 0.4·A from its peak 0.1476 of a cycle in.
      const leaveS = Math.acos(0.6) / (2 * Math.PI * FOLLOW.frequencyHz);
      for (const fromTop of [false, true]) {
        const { time, setpoint, waveStartS, waveEndS } = synthSetpoint(fromTop);
        const { tMinS, tMaxS } = sineFollowWindow(time, setpoint, FOLLOW);
        expect(Math.abs(tMinS - (waveStartS + leaveS))).toBeLessThan(0.02);
        expect(Math.abs(tMaxS - (waveEndS - 0.5 / FOLLOW.frequencyHz + leaveS))).toBeLessThan(0.02);
        expect(tMaxS).toBeLessThan(waveEndS);
      }
    },
  );
});

describe('resampledPathMm', () => {
  behaviour(
    {
      id: 'motion.path-same-at-any-sample-rate',
      covers: 'e2e/waveformMetrics.mjs#resampledPathMm',
      given: 'the same 42 mm of back-and-forth travel recorded at about 600 Hz and again at about 40 Hz',
      expect: {
        'same-path': 'both records measure between 35 mm and 50 mm of path and agree within 1 mm',
      },
    },
    () => {
      const dense = synthMultiSetPath(600);
      const sparse = decimate(dense, 40);
      const pathD = resampledPathMm(dense.time, dense.pos);
      const pathS = resampledPathMm(sparse.time, sparse.pos);
      expect(pathD).toBeGreaterThan(35);
      expect(pathD).toBeLessThan(50);
      expect(pathS).toBeGreaterThan(35);
      expect(pathS).toBeLessThan(50);
      expect(Math.abs(pathD - pathS)).toBeLessThan(1.0);
    },
  );

  behaviour(
    {
      id: 'motion.path-ignores-parked-teardown',
      covers: 'e2e/waveformMetrics.mjs#resampledPathMm',
      given: 'a 40 Hz record of 42 mm of travel followed by 2.5 s of the gantry parked and wobbling up to 0.18 mm',
      expect: {
        'commanded-travel': 'the measured path stays within 1.5 mm of the 42 mm commanded',
      },
    },
    () => {
      const dense = synthMultiSetPath(600);
      const sparse = decimate(dense, 40);
      const withTail = appendIdleTail(sparse, 2.5, 40);
      const path = resampledPathMm(withTail.time, withTail.pos);
      // Without the displacement-from-rest trim the idle tail adds its wobble to
      // the path, the way CI reported 42 mm of travel as 62.8 mm.
      expect(Math.abs(path - MULTI_SET_COMMANDED_MM)).toBeLessThan(PATH_TOLERANCE_MM);
    },
  );
});

describe('assertSineMatch / assertWaveformExcursion negative controls', () => {
  const label = 'neg';

  behaviour(
    {
      id: 'motion.sine-match-rejects-no-motion',
      covers: 'e2e/waveformMetrics.mjs#assertSineMatch',
      given: 'a record where the gantry sits still at 5 mm for the whole wave',
      expect: {
        'rejected': 'the sine check fails it',
      },
    },
    () => {
      const time: number[] = [];
      const pos: number[] = [];
      for (let i = 0; i < 500; i++) {
        time.push(i * 2500);
        pos.push(5000); // flat 5 mm
      }
      expect(() =>
        assertSineMatch({ time, pos }, { ...WAVE, amplitudeMm: WAVE.amplitudeMm }, label),
      ).toThrow();
    },
  );

  behaviour(
    {
      id: 'motion.sine-match-rejects-a-ramp',
      covers: 'e2e/waveformMetrics.mjs#assertSineMatch',
      given: 'a record that only ramps steadily from 0 to 5 mm with no wave',
      expect: {
        'rejected': 'the sine check fails it',
      },
    },
    () => {
      const time: number[] = [];
      const pos: number[] = [];
      for (let i = 0; i < 500; i++) {
        const t = i * 5000;
        time.push(t);
        pos.push((WAVE.centreMm * 1000 * t) / (500 * 5000)); // monotonic 0→5 mm
      }
      expect(() =>
        assertSineMatch({ time, pos }, { ...WAVE, amplitudeMm: WAVE.amplitudeMm }, label),
      ).toThrow();
    },
  );

  behaviour(
    {
      id: 'motion.sine-match-rejects-half-amplitude',
      covers: 'e2e/waveformMetrics.mjs#assertSineMatch',
      given: 'a record of a 1.5 mm sine where 3 mm was commanded, with the right timing',
      expect: {
        'rejected': 'the sine check fails it',
      },
    },
    () => {
      // Same timing as a good wave, but A = 1.5 mm against commanded 3 mm.
      const { time, pos } = synthWave(500, 'sine', { amplitudeMm: WAVE.amplitudeMm / 2 });
      expect(() => assertSineMatch({ time, pos }, WAVE, label)).toThrow();
    },
  );

  behaviour(
    {
      id: 'motion.excursion-rejects-no-motion',
      covers: 'e2e/waveformMetrics.mjs#assertWaveformExcursion',
      given: 'a record where the gantry sits still at 5 mm while a 4 mm wave was commanded',
      expect: {
        'rejected': 'the excursion check fails it',
      },
    },
    () => {
      const time: number[] = [];
      const pos: number[] = [];
      for (let i = 0; i < 500; i++) {
        time.push(i * 2500);
        pos.push(5000);
      }
      expect(() =>
        assertWaveformExcursion(
          { time, pos },
          { amplitudeMm: 4, cycles: 2, frequencyHz: 1 },
          label,
        ),
      ).toThrow();
    },
  );

  behaviour(
    {
      id: 'motion.sine-match-accepts-a-good-wave',
      covers: 'e2e/waveformMetrics.mjs#assertSineMatch',
      given: 'a clean 3 mm, 2 Hz, three-cycle sine recorded at about 600 Hz, and the same wave at about 40 Hz with 2 s parked afterwards',
      expect: {
        'accepted': 'the sine check passes both records',
      },
    },
    () => {
      const dense = synthWave(600, 'sine');
      const sparseTail = appendIdleTail(decimate(dense, 40), 2.0, 40);
      expect(() =>
        assertSineMatch(dense, { ...WAVE, amplitudeMm: WAVE.amplitudeMm }, 'dense'),
      ).not.toThrow();
      expect(() =>
        assertSineMatch(sparseTail, { ...WAVE, amplitudeMm: WAVE.amplitudeMm }, 'sparse+tail'),
      ).not.toThrow();
    },
  );
});

describe('assertSineMatch shape gate (triangle vs sine)', () => {
  const params = { amplitudeMm: WAVE.amplitudeMm, frequencyHz: WAVE.frequencyHz, cycles: WAVE.cycles };

  behaviour(
    {
      id: 'motion.sine-match-rejects-a-triangle',
      covers: 'e2e/waveformMetrics.mjs#assertSineMatch',
      given: 'a 600 Hz record of a triangle wave with the commanded amplitude, frequency and cycle count',
      expect: {
        'rejected-for-shape': 'the sine check fails it and the failure names the wave shape',
      },
    },
    () => {
      const tri = synthWave(600, 'triangle');
      expect(() => assertSineMatch(tri, params, 'tri')).toThrow(/sine shape|harmonic|triangle/i);
    },
  );

  behaviour(
    {
      id: 'motion.sine-match-rejects-a-sparse-triangle',
      covers: 'e2e/waveformMetrics.mjs#assertSineMatch',
      given: 'the same triangle wave recorded at about 40 Hz with 1 s parked afterwards',
      expect: {
        'rejected-for-shape': 'the sine check still fails it and the failure names the wave shape',
      },
    },
    () => {
      const tri = appendIdleTail(decimate(synthWave(600, 'triangle'), 40), 1.0, 40);
      expect(() => assertSineMatch(tri, params, 'tri-sparse')).toThrow(/sine shape|harmonic|triangle/i);
    },
  );

  behaviour(
    {
      id: 'motion.sine-match-accepts-a-sine-of-the-same-geometry',
      covers: 'e2e/waveformMetrics.mjs#assertSineMatch',
      given: 'a 600 Hz record of a sine with the same amplitude, frequency and cycle count as the rejected triangle',
      expect: {
        'accepted': 'the sine check passes it',
      },
    },
    () => {
      const sine = synthWave(600, 'sine');
      expect(() => assertSineMatch(sine, params, 'sine')).not.toThrow();
    },
  );
});
