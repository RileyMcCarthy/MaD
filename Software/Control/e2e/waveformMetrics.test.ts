/**
 * Unit coverage for density-independent waveform / path metrics.
 *
 * Encodes the CI-geometry fixture from #91: a clean local-density record
 * decimated to ~40 Hz with an idle teardown tail — the combination that used
 * to slide waveformWindow onto the approach ramp and inflate resampledPathMm.
 */
import { describe, expect, it } from 'vitest';
import {
  waveformWindow,
  resampledPathMm,
  assertSineMatch,
  assertWaveformExcursion,
} from './waveformMetrics.mjs';

/** WAVE-sine-fast catalog geometry (M10). */
const WAVE = {
  amplitudeMm: 3,
  frequencyHz: 2,
  cycles: 3,
  approachMm: 5,
} as const;

const WAVE_DUR_S = WAVE.cycles / WAVE.frequencyHz; // 1.5 s

type Series = { time: number[]; pos: number[] }; // µs, µm

/** Ideal WAVE-sine-fast record: rest → approach ramp → sine → parked settle. */
function synthWaveSineFast(sampleHz: number, { idleTailS = 0 } = {}): Series {
  const dtUs = Math.round(1e6 / sampleHz);
  const time: number[] = [];
  const pos: number[] = [];

  const push = (tUs: number, posUm: number) => {
    time.push(tUs);
    pos.push(posUm);
  };

  // Rest at 0 for 0.2 s.
  for (let t = 0; t < 200_000; t += dtUs) push(t, 0);

  // Approach ramp: 0 → approachMm over 0.5 s (matches "5 mm approach").
  const rampStart = 200_000;
  const rampDur = 500_000;
  for (let t = rampStart; t < rampStart + rampDur; t += dtUs) {
    const frac = (t - rampStart) / rampDur;
    push(t, WAVE.approachMm * 1000 * frac);
  }

  // Sine about the approach base for exactly cycles/frequency seconds.
  const waveStart = rampStart + rampDur;
  const waveEnd = waveStart + WAVE_DUR_S * 1e6;
  const centreUm = WAVE.approachMm * 1000;
  for (let t = waveStart; t <= waveEnd; t += dtUs) {
    const tau = (t - waveStart) / 1e6;
    const y = WAVE.amplitudeMm * Math.sin(2 * Math.PI * WAVE.frequencyHz * tau);
    push(t, centreUm + y * 1000);
  }

  // Parked settle at centre, then optional idle teardown tail.
  const parkEnd = waveEnd + 100_000 + idleTailS * 1e6;
  for (let t = waveEnd + dtUs; t <= parkEnd; t += dtUs) {
    // Tiny density-dependent drift so a consecutive-sample "parked" test would
    // fail at sparse rates the way CI did — displacement from rest stays small.
    const driftUm = ((t / dtUs) % 3) * 30; // ≤ 60 µm wobble
    push(t, centreUm + driftUm);
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

/** Append a parked idle tail at the final position. */
function appendIdleTail(series: Series, tailS: number, sampleHz: number): Series {
  const dtUs = Math.round(1e6 / sampleHz);
  const time = series.time.slice();
  const pos = series.pos.slice();
  const rest = pos[pos.length - 1];
  let t = time[time.length - 1] + dtUs;
  const end = time[time.length - 1] + tailS * 1e6;
  while (t <= end) {
    // Sparse-rate neighbour drift > 50 µm (old parkedEps trap).
    const driftUm = ((t / dtUs) % 3) * 40;
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

function toMmSeries(series: Series) {
  return {
    posMm: series.pos.map((p) => p / 1000),
    tS: series.time.map((t) => t / 1e6),
  };
}

describe('waveformWindow', () => {
  it('dense (~600 Hz) and sparse (~40 Hz) records of the same motion agree', () => {
    const dense = synthWaveSineFast(600);
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
  });

  it('sparse record plus parked teardown tail does not slide onto the approach ramp', () => {
    const dense = synthWaveSineFast(600);
    const sparse = decimate(dense, 40);
    const withTail = appendIdleTail(sparse, 2.0, 40); // long idle like CI teardown

    const { posMm, tS } = toMmSeries(withTail);
    const win = waveformWindow(posMm, tS, WAVE);
    const span = win.t[win.t.length - 1] - win.t[0];
    expect(span).toBeCloseTo(WAVE_DUR_S, 1);

    const excursion = Math.max(...win.p) - Math.min(...win.p);
    // Must measure the wave (6 mm), not approach+crest (~8 mm) or ramp+wave (~11 mm).
    expect(excursion).toBeCloseTo(2 * WAVE.amplitudeMm, 1);
    expect(excursion).toBeLessThan(WAVE.approachMm + WAVE.amplitudeMm);

    // Window mean should sit near the approach base, not near zero (ramp).
    const mean = win.p.reduce((a, b) => a + b, 0) / win.p.length;
    expect(mean).toBeGreaterThan(WAVE.approachMm - 1);
  });
});

describe('resampledPathMm', () => {
  it('dense and sparse records of the same multi-set motion agree near commanded travel', () => {
    const dense = synthMultiSetPath(600);
    const sparse = decimate(dense, 40);
    const pathD = resampledPathMm(dense.time, dense.pos);
    const pathS = resampledPathMm(sparse.time, sparse.pos);
    expect(pathD).toBeGreaterThan(35);
    expect(pathD).toBeLessThan(50);
    expect(pathS).toBeGreaterThan(35);
    expect(pathS).toBeLessThan(50);
    expect(Math.abs(pathD - pathS)).toBeLessThan(1.0);
  });

  it('sparse record plus parked teardown tail does not inflate path length', () => {
    const dense = synthMultiSetPath(600);
    const sparse = decimate(dense, 40);
    const withTail = appendIdleTail(sparse, 2.5, 40);
    const path = resampledPathMm(withTail.time, withTail.pos);
    // Commanded 42 mm; without the displacement-from-rest trim the idle tail
    // used to push this toward ~60 mm on CI geometry.
    expect(path).toBeGreaterThan(35);
    expect(path).toBeLessThan(50);
  });
});

describe('assertSineMatch / assertWaveformExcursion negative controls', () => {
  const label = 'neg';

  it('never-moved series fails assertSineMatch', () => {
    const time: number[] = [];
    const pos: number[] = [];
    for (let i = 0; i < 500; i++) {
      time.push(i * 2500);
      pos.push(5000); // flat 5 mm
    }
    expect(() =>
      assertSineMatch({ time, pos }, { ...WAVE, amplitudeMm: WAVE.amplitudeMm }, label),
    ).toThrow();
  });

  it('pure ramp (no wave) fails assertSineMatch', () => {
    const time: number[] = [];
    const pos: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t = i * 5000;
      time.push(t);
      pos.push((WAVE.approachMm * 1000 * t) / (500 * 5000)); // monotonic 0→5 mm
    }
    expect(() =>
      assertSineMatch({ time, pos }, { ...WAVE, amplitudeMm: WAVE.amplitudeMm }, label),
    ).toThrow();
  });

  it('half-amplitude sine fails assertSineMatch peak-to-peak / fit', () => {
    // Same timing as a good wave, but A = 1.5 mm against commanded 3 mm.
    const dtUs = 2000;
    const time: number[] = [];
    const pos: number[] = [];
    const centre = WAVE.approachMm * 1000;
    const halfA = WAVE.amplitudeMm / 2;
    for (let t = 0; t < 200_000; t += dtUs) {
      time.push(t);
      pos.push(0);
    }
    for (let t = 200_000; t < 700_000; t += dtUs) {
      time.push(t);
      pos.push(centre * ((t - 200_000) / 500_000));
    }
    const waveStart = 700_000;
    for (let t = waveStart; t <= waveStart + WAVE_DUR_S * 1e6; t += dtUs) {
      const tau = (t - waveStart) / 1e6;
      time.push(t);
      pos.push(centre + halfA * 1000 * Math.sin(2 * Math.PI * WAVE.frequencyHz * tau));
    }
    for (let t = waveStart + WAVE_DUR_S * 1e6 + dtUs; t < waveStart + WAVE_DUR_S * 1e6 + 200_000; t += dtUs) {
      time.push(t);
      pos.push(centre);
    }
    expect(() =>
      assertSineMatch({ time, pos }, { ...WAVE, amplitudeMm: WAVE.amplitudeMm }, label),
    ).toThrow();
  });

  it('never-moved series fails assertWaveformExcursion', () => {
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
  });

  it('good synthetic WAVE-sine-fast still passes assertSineMatch at both densities', () => {
    const dense = synthWaveSineFast(600);
    const sparseTail = appendIdleTail(decimate(dense, 40), 2.0, 40);
    expect(() =>
      assertSineMatch(dense, { ...WAVE, amplitudeMm: WAVE.amplitudeMm }, 'dense'),
    ).not.toThrow();
    expect(() =>
      assertSineMatch(sparseTail, { ...WAVE, amplitudeMm: WAVE.amplitudeMm }, 'sparse+tail'),
    ).not.toThrow();
  });
});
