/** Density-independent waveform / path metrics for SIL e2e measuring.
 *
 * Extracted from run-all.mjs so unit tests can exercise them without starting
 * Playwright. Used by control-e2e-sil scenarios (WAVE-*, TC1 path length).
 *
 * waveformWindow: widest-oscillation window (max total variation on a fixed
 * time grid) of duration cycles/frequency.
 * resampledPathMm: path length on a 50 ms grid, trimming teardown by
 * displacement from the resting position.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Linear interpolation of `values` at virtual time `tUs`. Same contract as src/domain/sample.ts. */
export function interpolateAtUs(timesUs, values, tUs) {
  const n = timesUs.length;
  if (n === 0 || n !== values.length) return undefined;
  if (tUs < timesUs[0] || tUs > timesUs[n - 1]) return undefined;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timesUs[mid] < tUs) lo = mid + 1;
    else hi = mid;
  }
  if (timesUs[lo] === tUs) return values[lo];
  const i0 = lo - 1;
  if (i0 < 0) return values[lo];
  const span = timesUs[lo] - timesUs[i0];
  if (span === 0) return values[i0];
  const w = (tUs - timesUs[i0]) / span;
  return values[i0] + w * (values[lo] - values[i0]);
}

/** First sample time at which position has moved ≥ `minDeltaUm` from the opening sample.
 *
 * Default 500 µm, not an encoder LSB: logging starts when `testRunning` goes
 * true, which is before the axis moves, and a parked gantry still twitches.
 * 80 µm treated that twitch as t0, so VT-linear's t0+400 ms landed 200 ms into
 * a move that had not started yet (2.2 mm of a commanded 4 mm). */
export function motionStartTimeUs(timesUs, positionsUm, minDeltaUm = 500) {
  if (timesUs.length < 2 || timesUs.length !== positionsUm.length) return undefined;
  const p0 = positionsUm[0];
  for (let i = 1; i < timesUs.length; i++) {
    if (Math.abs(positionsUm[i] - p0) >= minDeltaUm) return timesUs[i];
  }
  return undefined;
}

/** Path length ignoring high-frequency hunting and the leading rest prefix.
 *
 * Raw Σ|Δ| at 100 Hz counts encoder jitter as travel: a 42 mm multi-set move
 * reported 86 mm of "path" on a loaded CI runner. Resampling onto a 50 ms
 * virtual grid keeps the commanded reversals and drops the jitter. */
export function resampledPathMm(timeUs, posUm, { dtUs = 50_000, minDeltaUm = 500 } = {}) {
  if (!timeUs.length || timeUs.length !== posUm.length) return 0;
  const tStart = motionStartTimeUs(timeUs, posUm, minDeltaUm) ?? timeUs[0];
  // Trim the teardown tail by DISPLACEMENT from where the gantry finally came to
  // rest, not by how far it moved between two neighbouring samples. The old
  // consecutive-sample test (< 50 µm) meant something different at every sample
  // density: at the ~600 Hz a healthy emulator records it trims correctly, but at
  // the ~40 Hz a contended runner records, a parked gantry drifts more than 50 µm
  // between neighbours, nothing is trimmed, and the integral below accumulates
  // the whole idle tail as path — 42 mm of commanded travel reported as 62.8 mm.
  // Distance from the resting position is the same quantity at any density.
  const restUm = posUm[posUm.length - 1];
  let lastMoving = timeUs.length - 1;
  while (lastMoving > 0 && Math.abs(posUm[lastMoving] - restUm) < 200) lastMoving -= 1;
  if (lastMoving < 1) lastMoving = timeUs.length - 1;
  const tEnd = timeUs[lastMoving];
  let path = 0;
  let lastP = interpolateAtUs(timeUs, posUm, tStart);
  for (let t = tStart + dtUs; t <= tEnd && lastP != null; t += dtUs) {
    const p = interpolateAtUs(timeUs, posUm, t);
    if (p == null) break;
    path += Math.abs(p - lastP) / 1000;
    lastP = p;
  }
  return path;
}


// Rigorously assert a recorded position series actually traces the COMMANDED sine
// waveform — not merely that it oscillates. Checks: peak-to-peak ≈ 2·amplitude;
// a least-squares sinusoid fit at the commanded frequency explains the motion
// (R² high — a ramp/wrong-frequency would fail); a 3rd/1st harmonic ratio gate
// rejects triangle-like shapes that still clear R²>0.8; the fitted amplitude
// matches; and the number of midline crossings matches the commanded cycles.
// This is the end-to-end proof that the firmware-native waveform = f(t).
// Narrow a recorded run down to the COMMANDED WAVEFORM.
//
// A waveform run records more than the wave. The wave starts at rest where the
// gantry is (a peak) and each whole cycle ends at rest back at that peak; around
// it sit any moves the program makes before and after, and a flat tail until
// teardown.
//
// None of that is the commanded shape, and it is not a small effect: a move
// before the wave can be as large as the wave itself, and a properly homed
// gantry once reported 14.49 mm of "waveform" — failing the assertion precisely
// BECAUSE homing had worked.
//
// E2E_WAVE_DUMP=1 writes the raw recorded series beside the artifacts, so the
// windowing and the fit can be worked on offline instead of by re-running the
// suite (a waveform scenario costs about a minute of emulator time).
function dumpWaveSeries(label, posMm, tS, meta) {
  if (!process.env.E2E_WAVE_DUMP) return;
  try {
    writeFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'artifacts', `${label}-series.json`),
      JSON.stringify({ meta, posMm, tS }),
    );
  } catch { /* diagnostics must never fail a run */ }
}

// The commanded wave, found in a recorded position series.
//
// The firmware runs a G123 from rest on a peak for whole cycles, so the wave
// is a cycles/frequency-long stretch that STARTS with the gantry still, ENDS
// where it started, and carries the travel whole cycles make: 4·A per cycle,
// whatever the traverse, holds or skew. Of the stretches that do, the one with
// the most travel is the wave. Each condition rules out something else a
// record holds:
//
//  - The moves before and after the wave are moving where it starts at rest,
//    so no stretch starts inside them. Most travel alone cannot see this: an
//    approach as fast as the wave, then a park, out-travels the wave's own
//    slow final run into its peak, and a window shifted onto them fits the
//    wrong shape about the wrong centre.
//  - A stretch from the rest before an approach ends partway into the wave,
//    nowhere near where it began.
//  - A parked tail carries next to no travel: at least half the commanded
//    travel is required.
//
// All of it is measured on a fixed time grid, never between neighbouring
// samples. A distance between neighbours means something different at every
// sample density: at the ~40 Hz a contended CI runner records, a parked gantry
// drifts further between samples than a moving one does at ~600 Hz, and
// summing raw |Δ| counts sensor noise once per sample.
//
// A record that holds no such stretch has no commanded wave in it. The whole
// record is handed back, and the caller's assertions say what is wrong with it.
export function waveformWindow(posMm, tS, { cycles, frequencyHz, amplitudeMm }) {
  const waveDurS = cycles / frequencyHz;
  const n = posMm.length;
  const t0 = tS[0];
  const tEnd = tS[n - 1];

  // Fixed grid, ~100 points per commanded cycle — fine enough to follow the
  // wave, coarse enough not to chase noise.
  const dt = waveDurS / (100 * cycles);
  const grid = [];
  const gval = [];
  let j = 0;
  for (let t = t0; t <= tEnd; t += dt) {
    while (j + 1 < n && tS[j + 1] < t) j += 1;
    const k = Math.min(j, n - 2);
    const span = tS[k + 1] - tS[k];
    const frac = span > 0 ? (t - tS[k]) / span : 0;
    grid.push(t);
    gval.push(posMm[k] + (posMm[k + 1] - posMm[k]) * frac);
  }
  // Prefix sums of |Δ| so each candidate stretch costs O(1).
  const tv = [0];
  for (let i = 1; i < gval.length; i++) tv.push(tv[i - 1] + Math.abs(gval[i] - gval[i - 1]));

  const steps = Math.round(waveDurS / dt);
  // Still: under 1% of the amplitude per grid step, a sixth of a sine's peak
  // speed (2πfA·dt = 0.063·A per step). A sine is that slow only within a grid
  // step or two of a peak.
  const stillMm = 0.01 * amplitudeMm;
  const closeMm = 0.2 * amplitudeMm;
  const minTravelMm = 0.5 * 4 * amplitudeMm * cycles;
  let bestStart = -1;
  let bestTravel = -1;
  for (let i = 0; i + steps < tv.length; i++) {
    const travel = tv[i + steps] - tv[i];
    if (
      travel > bestTravel &&
      travel >= minTravelMm &&
      Math.abs(gval[i + 1] - gval[i]) < stillMm &&
      Math.abs(gval[i + steps] - gval[i]) < closeMm
    ) {
      bestTravel = travel;
      bestStart = i;
    }
  }
  if (bestStart < 0) return { p: posMm, t: tS, waveDurS };

  const startT = grid[bestStart];
  const endT = grid[bestStart + steps];
  let a = 0;
  while (a < n - 1 && tS[a] < startT) a += 1;
  let b = a;
  while (b + 1 < n && tS[b + 1] <= endT) b += 1;
  return { p: posMm.slice(a, b + 1), t: tS.slice(a, b + 1), waveDurS };
}

export function assertSineMatch(series, { amplitudeMm, frequencyHz, cycles, centreMm }, label) {
  assert(series && series.pos.length > 40, `${label}: enough samples (${series?.pos.length})`);
  const posMm = series.pos.map((p) => p / 1000);
  const tS = series.time.map((t) => t / 1e6);
  dumpWaveSeries(label, posMm, tS, { amplitudeMm, frequencyHz, cycles, centreMm });

  // Fit exactly the WAVEFORM, not the whole record. The record also contains the
  // program's moves before and after the wave, and a flat tail that lasts
  // until the run is torn down. Neither is the commanded
  // sine, and the tail's length is teardown timing (0.1–0.4 s observed), so
  // including it penalises a perfectly tracked wave in proportion to how slow
  // the shutdown happened to be. That is what made the short 2 Hz case flaky:
  // R² 0.67–0.70 over the whole record vs 0.99 over the wave itself, on motion
  // that measured 2.85 mm of the commanded 3 mm at exactly 2 Hz every run.
  //
  // The wave's extent is known, not guessed: it runs for cycles/frequency
  // seconds, starting and ending at rest on the peak it set off from (whole
  // cycles end where they began). Take that window.
  const { p, t, waveDurS } = waveformWindow(posMm, tS, { cycles, frequencyHz, amplitudeMm });
  // A run where the gantry never moved collapses this window — it must still be
  // long enough to hold the commanded cycles, or the fit below is meaningless.
  assert(
    p.length > 40 && t[t.length - 1] - t[0] > waveDurS * 0.8,
    `${label}: recorded a full ${waveDurS.toFixed(2)}s of waveform motion (got ${(t[t.length - 1] - t[0]).toFixed(2)}s over ${p.length} samples; whole record ${posMm.length} samples spanning ${(tS[tS.length - 1] - tS[0]).toFixed(2)}s)`,
  );
  const n = p.length;
  const t0 = t[0];

  const maxP = Math.max(...p);
  const minP = Math.min(...p);
  const excursion = maxP - minP;
  assert(
    Math.abs(excursion - 2 * amplitudeMm) < Math.max(2, amplitudeMm * 0.4),
    `${label}: peak-to-peak ≈ 2A=${(2 * amplitudeMm).toFixed(1)}mm (got ${excursion.toFixed(2)}; ` +
      `window ${p.length} of ${posMm.length} samples, whole record spans ${(tS[tS.length - 1] - tS[0]).toFixed(2)}s)`,
  );

  // Least-squares fit  x(t) ≈ a·cos(ω t') + b·sin(ω t')  about the mean, ω=2πf.
  const w = 2 * Math.PI * frequencyHz;
  const mean = p.reduce((s, v) => s + v, 0) / n;
  let Scc = 0, Sss = 0, Scs = 0, Sxc = 0, Sxs = 0, SStot = 0;
  for (let i = 0; i < n; i++) {
    const c = Math.cos(w * (t[i] - t0));
    const s = Math.sin(w * (t[i] - t0));
    const x = p[i] - mean;
    Scc += c * c; Sss += s * s; Scs += c * s; Sxc += x * c; Sxs += x * s; SStot += x * x;
  }
  const det = Scc * Sss - Scs * Scs;
  const a = (Sxc * Sss - Scs * Sxs) / det;
  const b = (Scc * Sxs - Scs * Sxc) / det;
  let SSres = 0;
  for (let i = 0; i < n; i++) {
    const fit = a * Math.cos(w * (t[i] - t0)) + b * Math.sin(w * (t[i] - t0));
    const x = p[i] - mean;
    SSres += (x - fit) * (x - fit);
  }
  const r2 = 1 - SSres / SStot;
  const fitAmp = Math.sqrt(a * a + b * b);
  assert(r2 > 0.8, `${label}: sinusoid fit R²>0.8 at ${frequencyHz}Hz (got ${r2.toFixed(3)})`);
  assert(
    Math.abs(fitAmp - amplitudeMm) < Math.max(1.5, amplitudeMm * 0.3),
    `${label}: fitted amplitude ≈ ${amplitudeMm}mm (got ${fitAmp.toFixed(2)})`,
  );

  // Shape gate: 3rd/1st harmonic amplitude ratio. A pure sinusoid has ~0; a
  // triangle's Fourier series has |c3/c1| = 1/9 ≈ 0.111, and R² alone cannot
  // separate them (triangle-vs-fundamental R² ≈ 0.986 >> 0.8). Threshold 0.06
  // sits between SIL-noisy sines (≪ 0.05) and triangles (~0.11) with margin —
  // raising R² would be flaky; this odd-harmonic residual is not.
  let Scc3 = 0, Sss3 = 0, Scs3 = 0, Sxc3 = 0, Sxs3 = 0;
  for (let i = 0; i < n; i++) {
    const c3 = Math.cos(3 * w * (t[i] - t0));
    const s3 = Math.sin(3 * w * (t[i] - t0));
    const x = p[i] - mean;
    Scc3 += c3 * c3; Sss3 += s3 * s3; Scs3 += c3 * s3; Sxc3 += x * c3; Sxs3 += x * s3;
  }
  const det3 = Scc3 * Sss3 - Scs3 * Scs3;
  const a3 = (Sxc3 * Sss3 - Scs3 * Sxs3) / det3;
  const b3 = (Scc3 * Sxs3 - Scs3 * Sxc3) / det3;
  const h3Amp = Math.sqrt(a3 * a3 + b3 * b3);
  const h3ratio = fitAmp > 1e-9 ? h3Amp / fitAmp : 0;
  assert(
    h3ratio < 0.06,
    `${label}: sine shape (3rd/1st harmonic ratio < 0.06; got ${h3ratio.toFixed(3)} — ` +
      `a triangle at this A/f has ≈0.111; catalog mix-up or wrong waveform)`,
  );

  // Midline crossings over the WAVE WINDOW ≈ 2 per cycle (deadband = 0.3A).
  // Counting over the whole record made this density-dependent too: a long
  // parked tail pulls the mean toward the park value, so the wave's own
  // excursions stop straddling it and the crossings vanish — "≥ 3 midline
  // crossings (got 1)" on a correctly tracked triangle.
  const fullMean = p.reduce((s, v) => s + v, 0) / p.length;
  let crossings = 0;
  let dir = 0;
  for (const v of p) {
    if (v > fullMean + 0.3 * amplitudeMm) { if (dir === -1) crossings++; dir = 1; }
    else if (v < fullMean - 0.3 * amplitudeMm) { if (dir === 1) crossings++; dir = -1; }
  }
  assert(
    crossings >= 2 * cycles - 1,
    `${label}: ≥ ${2 * cycles - 1} midline crossings for ${cycles} cycle(s) (got ${crossings})`,
  );

  // Where the wave actually sat, not just what shape it was. Every check above
  // this line is mean-centred by construction — the fit subtracts `mean`, the
  // peak-to-peak is a difference, and the crossing count is about the series'
  // own midline — so a waveform displaced bodily off the centre it was
  // commanded about scores a perfect R² and passes all of them. That is exactly
  // how a 0.82 mm systematic sag rode along unnoticed until it pushed the
  // bottom of the stroke into the lower limit switch.
  if (typeof centreMm === 'number') {
    const offset = mean - centreMm;

    // A wave starts from rest on a peak, where its own velocity is zero, so
    // nothing in how it starts offsets its centre: across this matrix on the
    // board the centres sit 1-34 um from where they were commanded. 0.35 mm
    // leaves a sparse CI recording room to shift the window mean, and is well
    // short of the millimetre that puts the bottom of a stroke into the lower
    // limit switch.
    const tol = 0.35;
    assert(
      Math.abs(offset) < tol,
      `${label}: wave centred on the commanded ${centreMm}mm (sat at ${mean.toFixed(2)}mm, ` +
        `off by ${offset.toFixed(3)}mm, tol ${tol.toFixed(2)}mm)`,
    );
  }
}

/** Where to hold a recorded setpoint to the commanded sine.
 *
 * From once the wave has LEFT the peak it set off from, for all but its last
 * half cycle. A wave starts at rest where the gantry stands and sets off in
 * the direction of its amplitude's sign, so that peak is the bottom of the
 * stroke for a positive amplitude and the top for a negative one. Either end
 * of the wave borders a park: a cosine fitted through the plateau before it
 * lands 180° out, and past its end the setpoint rests while the ideal cosine
 * carries on.
 *
 * The wave is found in the commanded setpoint, which carries no encoder noise,
 * by the same window the shape checks use. */
export function sineFollowWindow(timeUs, setpointUm, { cycles, frequencyHz, amplitudeMm }) {
  const tS = [];
  const spMm = [];
  for (let i = 0; i < timeUs.length; i++) {
    if (Number.isFinite(setpointUm[i])) {
      tS.push(timeUs[i] / 1e6);
      spMm.push(setpointUm[i] / 1000);
    }
  }
  const { p, t } = waveformWindow(spMm, tS, { cycles, frequencyHz, amplitudeMm });
  // Left the peak: a fifth of the swing (2A) away from where the wave began.
  let i = 0;
  while (i < p.length - 1 && Math.abs(p[i] - p[0]) < 0.4 * amplitudeMm) i += 1;
  const tMinS = t[i];
  return { tMinS, tMaxS: tMinS + (cycles - 0.5) / frequencyHz };
}

/** Peak-to-peak + cycle count for triangle (and other non-sine) waveforms. */
export function assertWaveformExcursion(series, { amplitudeMm, cycles, frequencyHz }, label) {
  assert(series && series.pos.length > 40, `${label}: enough samples (${series?.pos.length})`);
  const allPosMm = series.pos.map((v) => v / 1000);
  const tS = series.time.map((v) => v / 1e6);
  dumpWaveSeries(label, allPosMm, tS, { amplitudeMm, frequencyHz, cycles });
  // Same window as the sine case: measure the wave, not the approach to it.
  const { p: posMm, t, waveDurS } = waveformWindow(allPosMm, tS, { cycles, frequencyHz, amplitudeMm });
  assert(
    posMm.length > 40 && t[t.length - 1] - t[0] > waveDurS * 0.8,
    `${label}: recorded a full ${waveDurS.toFixed(2)}s of waveform motion ` +
      `(got ${(t[t.length - 1] - t[0]).toFixed(2)}s over ${posMm.length} samples)`,
  );
  const maxP = Math.max(...posMm);
  const minP = Math.min(...posMm);
  const excursion = maxP - minP;
  assert(
    Math.abs(excursion - 2 * amplitudeMm) < Math.max(2.5, amplitudeMm * 0.45),
    `${label}: peak-to-peak ≈ 2A=${(2 * amplitudeMm).toFixed(1)}mm (got ${excursion.toFixed(2)}; ` +
      `min ${minP.toFixed(2)} max ${maxP.toFixed(2)} first ${posMm[0].toFixed(2)} ` +
      `last ${posMm[posMm.length - 1].toFixed(2)} n=${posMm.length})`,
  );
  const mean = posMm.reduce((s, v) => s + v, 0) / posMm.length;
  let crossings = 0;
  let dir = 0;
  for (const v of posMm) {
    if (v > mean + 0.25 * amplitudeMm) {
      if (dir === -1) crossings += 1;
      dir = 1;
    } else if (v < mean - 0.25 * amplitudeMm) {
      if (dir === 1) crossings += 1;
      dir = -1;
    }
  }
  assert(
    crossings >= 2 * cycles - 1,
    `${label}: ≥ ${2 * cycles - 1} midline crossings for ${cycles} cycle(s) (got ${crossings})`,
  );

  // The traverse is TRIANGULAR, not sinusoidal — proven from the recorded
  // motion rather than from the bytes that were sent.
  //
  // Fit the fundamental and compare its amplitude to the commanded peak. That
  // ratio is a property of the SHAPE and of nothing else: 8/pi^2 = 0.811 for a
  // triangle, 1.000 for a sine, 4/pi = 1.273 for a square. Amplitude,
  // frequency, centre and cycle count are all identical between a sine and a
  // triangle, so every other assertion in this file passes either way — which
  // is exactly how the shape bit came to be masked off in app_motion and
  // ignored for as long as it was, with every test still green.
  //
  // Measured here: 0.845 and 0.831. Slightly above the ideal 0.811 because the
  // deliverable traverse is a TRAPEZOID — its corners are rounded by the
  // acceleration limit, which moves it a little toward a sine.
  const w = 2 * Math.PI * frequencyHz;
  const t0 = t[0];
  const wMean = posMm.reduce((s2, v) => s2 + v, 0) / posMm.length;
  let Sc = 0;
  let Ss = 0;
  let Scc2 = 0;
  let Sss2 = 0;
  for (let i = 0; i < posMm.length; i++) {
    const c = Math.cos(w * (t[i] - t0));
    const sn = Math.sin(w * (t[i] - t0));
    const x = posMm[i] - wMean;
    Sc += x * c;
    Ss += x * sn;
    Scc2 += c * c;
    Sss2 += sn * sn;
  }
  const fundamental = Math.hypot(Sc / Scc2, Ss / Sss2);
  const ratio = fundamental / amplitudeMm;
  assert(
    ratio > 0.7 && ratio < 0.92,
    `${label}: fundamental/peak = ${ratio.toFixed(3)} — a triangle traverse is 8/pi²=0.811, ` +
      `a sine would be 1.000, so this says the shape reached the machine`,
  );
}
