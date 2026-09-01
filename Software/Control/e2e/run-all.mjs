/**
 * E2E parity suite runner.
 *
 * Drives the real app in system Chrome against the live SIL emulator (via the
 * WS bridge) and an OPFS data folder — see fixtures.mjs and docs/TEST_PLAN.md.
 *
 * Preconditions (each in its own terminal):
 *   cd SIL && make playground          # emulator on /tmp/tty.rpi
 *   npm run sil:bridge                 # ws://localhost:9999
 *   npm run dev                        # app on http://localhost:5174
 * Then: npm run e2e
 *
 * Covers the parity-critical scenarios of docs/TEST_PLAN.md §4: A1, B1–B5, C1/C3/C4, D1/D2/D3,
 * E1, F1/F2/F4/F6/F7, G1/G2/G3 + G-limit, H1–H5, I1–I4, J1 (in G-limit), K1 (in B2+B3+B4) — plus
 * regressions ported from the desktop SIL suite (NAV, settled-jog, slack→tension, fractional
 * precision, back-to-back runs, TC1/TC4/TC6/TC11/TC14, TM-busy-restart / TM-manual-gate for
 * testManagement isBusy lifecycle, WAVE-sine for the waveform/math move that replaced arcs,
 * and VT-linear for virtual-time position/encoder at t0+100_000 µs).
 * §4 IDs without a dedicated scenario (C2 tooltips, F3 .sp import, F5 set save/load) are
 * unit/presence-covered.
 */

import {
  newSilPage,
  connectToSil,
  chooseDataFolder,
  dumpFailureArtifacts,
  setCurrentScenario,
  installFakeBootRom,
  installOpfsDataDir,
  OPFS_DIR,
  APP_URL,
  chromium,
} from './fixtures.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Sprint C parameterized matrices (M8–M11). */
const MATRIX = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'matrix-catalog.json'), 'utf8'),
);

// Budget for any wait that depends on the DEVICE making progress.
//
// Generous on purpose. The emulator simulates at a FRACTION of real time — its
// free-running pacing sleeps a wall microsecond per virtual microsecond, so the
// real-time factor is bounded above by 1.0 and lands nearer 0.25 on a CI runner
// that is also hosting Chrome, Vite and the bridge. Every protocol round trip
// and every millimetre of motion therefore costs several times its nominal wall
// duration, and an 8-second budget that is ample on a dev box is not on CI.
//
// A healthy run never spends this: these bound a hang, they do not pace a
// passing test. No wait in this suite is used to prove something is ABSENT, so
// raising the ceiling cannot weaken an assertion — it only stops a slow host
// from being reported as a broken one.
const DEVICE_WAIT_MS = 60_000;

// Budget for a whole TEST PROGRAM: upload, execute every move, complete, and
// come to rest — or for pulling the recorded data back off the device. The
// longest profiles here are several seconds of SIMULATED motion, and the same
// pacing that makes DEVICE_WAIT_MS generous applies to all of it at once, so
// this is minutes of wall time on a slow host. Same reasoning: it bounds a
// hang, it never paces a passing run.
const RUN_WAIT_MS = 180_000;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const fieldInput = (scope, label) =>
  scope.locator('label.field', { hasText: label }).locator('input');

// Seed a saved sample profile + a single-set motion profile into the OPFS data
// folder so the Test Runner's dropdowns are populated. `motion.moves` is the
// list of move objects for the one set.
async function seedProfiles(page, { sample, motion }) {
  await page.evaluate(async ({ sample, motion }) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('mad-e2e', { create: true });
    const write = async (sub, name, obj) => {
      const d = await dir.getDirectoryHandle(sub, { create: true });
      const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(obj));
      await w.close();
    };
    await write('sampleProfiles', `${sample.serial}.json`, {
      id: `s-${sample.serial}`, name: sample.serial, createdAt: new Date().toISOString(), profile: sample,
    });
    const sets = motion.sets || [{ name: 'Set', executions: motion.executions ?? 1, moves: motion.moves }];
    await write('motionProfiles', `${motion.name}.json`, {
      id: `m-${motion.name}`, name: motion.name, description: '', createdAt: new Date().toISOString(),
      profile: { name: motion.name, description: '', sets },
    });
  }, { sample, motion });
}

// Read the single downloaded run CSV from OPFS as parallel time(us)/position(um) arrays.
async function readDownloadedCsvSeries(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('mad-e2e');
    const tr = await dir.getDirectoryHandle('testRuns');
    let text = null;
    for await (const [n, h] of tr.entries()) {
      if (h.kind === 'file' && n.endsWith('.csv')) text = await (await h.getFile()).text();
    }
    if (!text) return null;
    const lines = text.trim().split('\n');
    const hdr = lines[0].split(',');
    const ti = hdr.indexOf('time_us'), pi = hdr.indexOf('position_um');
    const time = [], pos = [];
    for (const l of lines.slice(1)) {
      const c = l.split(',');
      const t = Number(c[ti]), p = Number(c[pi]);
      if (Number.isFinite(t) && Number.isFinite(p)) { time.push(t); pos.push(p); }
    }
    return { time, pos };
  });
}

/** Linear interpolation of `values` at virtual time `tUs`. Same contract as src/domain/sample.ts. */
function interpolateAtUs(timesUs, values, tUs) {
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

/** First sample time at which position has moved ≥ `minDeltaUm` from the opening sample. */
function motionStartTimeUs(timesUs, positionsUm, minDeltaUm = 80) {
  if (timesUs.length < 2 || timesUs.length !== positionsUm.length) return undefined;
  const p0 = positionsUm[0];
  for (let i = 1; i < timesUs.length; i++) {
    if (Math.abs(positionsUm[i] - p0) >= minDeltaUm) return timesUs[i];
  }
  return undefined;
}

/** SIL plant: 2048-line encoder × 4× quadrature. Position_um in the CSV is this encoder. */
const SIL_ENCODER_STEPS_PER_MM = 4 * 2048;

// Rigorously assert a recorded position series actually traces the COMMANDED sine
// waveform — not merely that it oscillates. Checks: peak-to-peak ≈ 2·amplitude;
// a least-squares sinusoid fit at the commanded frequency explains the motion
// (R² high — a ramp/triangle/wrong-frequency would fail); the fitted amplitude
// matches; and the number of midline crossings matches the commanded cycles.
// This is the end-to-end proof that the firmware-native waveform = f(t).
// Narrow a recorded run down to the COMMANDED WAVEFORM.
//
// A waveform run records more than its wave: a leading ramp that travels the
// move's `distance` to the wave's base, and — after the closing settle parks the
// gantry — a flat tail lasting until teardown. Neither is the commanded shape,
// so any statistic taken over the whole record measures the approach as much as
// the wave. That is not a small effect: for WAVE-tri the ramp is 5 mm against an
// 8 mm peak-to-peak, and a properly homed gantry therefore reported 14.49 mm of
// "waveform" — failing the assertion precisely BECAUSE homing had worked, and
// passing when drift happened to leave it already near the base.
//
// The wave's extent is known rather than guessed: it lasts cycles/frequency
// seconds and ends where the gantry stops moving (whole cycles end on the
// centre, so the closing settle is negligible). Take that window.
function waveformWindow(posMm, tS, { cycles, frequencyHz }) {
  const parkedEps = 0.005; // mm between samples; wave motion is >=10x this
  let lastMoving = posMm.length - 1;
  while (lastMoving > 0 && Math.abs(posMm[lastMoving] - posMm[lastMoving - 1]) < parkedEps) lastMoving--;
  const waveDurS = cycles / frequencyHz;
  const startT = tS[lastMoving] - waveDurS;
  let first = 0;
  while (first < lastMoving && tS[first] < startT) first++;
  return { p: posMm.slice(first, lastMoving + 1), t: tS.slice(first, lastMoving + 1), waveDurS };
}

function assertSineMatch(series, { amplitudeMm, frequencyHz, cycles }, label) {
  assert(series && series.pos.length > 40, `${label}: enough samples (${series?.pos.length})`);
  const posMm = series.pos.map((p) => p / 1000);
  const tS = series.time.map((t) => t / 1e6);

  // Fit exactly the WAVEFORM, not the whole record. The record also contains the
  // leading ramp-to-centre and — after the closing settle move parks the gantry —
  // a flat tail that lasts until the run is torn down. Neither is the commanded
  // sine, and the tail's length is teardown timing (0.1–0.4 s observed), so
  // including it penalises a perfectly tracked wave in proportion to how slow
  // the shutdown happened to be. That is what made the short 2 Hz case flaky:
  // R² 0.67–0.70 over the whole record vs 0.99 over the wave itself, on motion
  // that measured 2.85 mm of the commanded 3 mm at exactly 2 Hz every run.
  //
  // The wave's extent is known, not guessed: it runs for cycles/frequency
  // seconds and ends where the gantry stops moving (whole cycles end on the
  // centre, so the settle move is negligible). Take that window.
  const { p, t, waveDurS } = waveformWindow(posMm, tS, { cycles, frequencyHz });
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

  // Midline crossings over the whole series ≈ 2 per cycle (deadband = 0.3A).
  const fullMean = posMm.reduce((s, v) => s + v, 0) / posMm.length;
  let crossings = 0;
  let dir = 0;
  for (const v of posMm) {
    if (v > fullMean + 0.3 * amplitudeMm) { if (dir === -1) crossings++; dir = 1; }
    else if (v < fullMean - 0.3 * amplitudeMm) { if (dir === 1) crossings++; dir = -1; }
  }
  assert(
    crossings >= 2 * cycles - 1,
    `${label}: ≥ ${2 * cycles - 1} midline crossings for ${cycles} cycle(s) (got ${crossings})`,
  );
}

/** Peak-to-peak + cycle count for triangle (and other non-sine) waveforms. */
function assertWaveformExcursion(series, { amplitudeMm, cycles, frequencyHz }, label) {
  assert(series && series.pos.length > 40, `${label}: enough samples (${series?.pos.length})`);
  const allPosMm = series.pos.map((v) => v / 1000);
  const tS = series.time.map((v) => v / 1e6);
  // Same window as the sine case: measure the wave, not the approach to it.
  const { p: posMm, t, waveDurS } = waveformWindow(allPosMm, tS, { cycles, frequencyHz });
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
}

// Run the currently-selected profiles and wait for the run to auto-complete + download.
// Returns the run row locator. Assumes profiles are seeded + selected by the caller.
async function runAndDownload(page, { completeTimeout = RUN_WAIT_MS } = {}) {
  const runner = page.locator('.panel', { hasText: 'New Test' });
  await page.getByTestId('run-test').click();
  await runner.getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
  const row = page.locator('tbody tr').first();
  await row.locator('.badge.completed').waitFor({ timeout: completeTimeout });
  await row.getByRole('button', { name: /Download data/i }).click();
  await row.locator('.badge.downloaded').waitFor({ timeout: RUN_WAIT_MS });
  return row;
}

// Wait until the gantry has actually stopped on its commanded setpoint.
//
// The suite's fixed `waitForTimeout` settles assumed the emulator simulates at
// real time. It does not, and cannot: in free-running mode `apply_pace` sleeps
// one wall microsecond per virtual microsecond, so the real-time factor is
// bounded ABOVE by 1.0 and every bit of simulation overhead drags it under.
// Measured 0.70 on an idle 8-core Mac and 0.25 on a 4-vCPU CI runner sharing a
// box with Chrome, Vite, the bridge and the emulator. A 2500 ms sleep therefore
// buys ~625 ms of motion there, and a one-second move gets sampled mid-flight —
// which is exactly the M8 10 mm @ 10 mm/s cell landing at ~5.5 of 10 mm while
// the 50 ms and 200 ms cells pass.
//
// Waiting on the machine's own report instead is independent of how fast the
// host simulates, so the same assertion holds on any hardware. `setpointWas`
// makes the wait honest: without it, a poll that lands before the jog command
// registers sees position == setpoint (both at rest) and returns "settled"
// immediately, which is the very bug this replaces.
async function settleMotion(page, opts = {}) {
  // Required, not defaulted. Omitting it is the one way to misuse this helper —
  // phase 1 is skipped, and phase 2 can then return on the very first poll
  // because the machine is momentarily at rest ON its setpoint from the
  // PREVIOUS move, before the new command has registered. The wait silently
  // becomes a no-op and the scenario reads a stale position. Pass `null`
  // explicitly when the move is already known to be in flight.
  if (!Object.prototype.hasOwnProperty.call(opts, 'setpointWas')) {
    throw new Error('settleMotion: pass setpointWas (the setpoint read BEFORE the command), or null');
  }
  const {
    setpointWas,          // setpoint before the command, so we can see it register
    tolMm = 0.12,         // |position - setpoint| that counts as arrived
    stillMm = 0.01,       // per-poll movement that counts as stopped
    stableTicks = 3,      // consecutive arrived+still polls required
    pollMs = 120,
    timeoutMs = 90_000,   // generous: bounds a hang, never paces a healthy move
  } = opts;
  const num = async (label) =>
    parseFloat(await page.locator('.readout', { hasText: label }).locator('.value').first().innerText());

  const deadline = Date.now() + timeoutMs;
  // Phase 1 — let the command land. Advisory: some moves legitimately leave the
  // setpoint unchanged, so a timeout here just falls through to phase 2.
  if (setpointWas !== null) {
    const cmdDeadline = Math.min(deadline, Date.now() + 20_000);
    while (Date.now() < cmdDeadline) {
      const set = await num('Machine Setpoint');
      if (Number.isFinite(set) && Math.abs(set - setpointWas) > tolMm) break;
      await page.waitForTimeout(pollMs);
    }
  }

  // Phase 2 — converge onto the setpoint and hold there.
  let stable = 0;
  let last = NaN;
  let pos = NaN;
  let set = NaN;
  while (Date.now() < deadline) {
    pos = await num('Machine Position');
    set = await num('Machine Setpoint');
    const arrived = Number.isFinite(pos) && Number.isFinite(set) && Math.abs(pos - set) <= tolMm;
    const still = Number.isFinite(last) && Math.abs(pos - last) <= stillMm;
    if (arrived && still) {
      if (++stable >= stableTicks) return pos;
    } else {
      stable = 0;
    }
    last = pos;
    await page.waitForTimeout(pollMs);
  }
  throw new Error(
    `motion never settled within ${timeoutMs}ms (position ${pos}, setpoint ${set}) — ` +
    'the gantry is still moving or never reached its target',
  );
}

// Make sure no test is still running before driving the manual controls.
//
// The suite is serial and shares ONE long-lived emulator, so a scenario can
// inherit a test that an earlier one left running — and the app deliberately
// gates the manual jog controls while a test runs (the contract TM-manual-gate
// asserts). The jog inputs are then disabled, and `locator.fill` sits there
// until its 30 s timeout with a message about the input, which says nothing
// about the real cause.
//
// Whether that bites is pure timing: at real time the predecessor's run has
// finished by the time the next scenario connects; at the ~0.25x the emulator
// actually manages on a CI runner it has not. Waiting on the machine's state
// makes the scenario independent of both the host speed and what ran before.
//
// Call after navigating to /live and before enabling motion — stopping a run
// disables motion, which the callers' own "Enable motion" step then restores.
async function ensureTestIdle(page, { graceMs = 75_000, timeoutMs = 150_000 } = {}) {
  const idle = page.getByText('Test: idle');
  const deadline = Date.now() + timeoutMs;
  // A run that is genuinely finishing should be allowed to finish on its own.
  // The grace has to be generous in WALL time: the longest move any scenario
  // commands is 40 mm at 2 mm/s — 20 s of simulated time, which is ~57 s of
  // wall time at the ~0.25-0.35x the emulator manages under CI load.
  try {
    await idle.waitFor({ timeout: Math.min(graceMs, timeoutMs) });
    return;
  } catch {
    /* still running — stop it below */
  }
  // Disabling motion ends the run; TC6-disable-stops covers that contract.
  const disable = page.getByRole('button', { name: 'Disable motion' });
  if (await disable.count()) {
    await disable.click();
  }
  // Outside the `if` on purpose. An earlier revision only waited when the
  // button happened to be present, so when it was not this returned having done
  // nothing at all — the caller then drove gated controls and failed 30 s later
  // with a locator timeout naming an input, which says nothing about the cause.
  // Either the machine reaches idle or this throws saying so.
  await idle.waitFor({ timeout: Math.max(20_000, deadline - Date.now()) });
}

// Return the gantry to absolute machine zero and re-zero the gauge length.
// The emulator is long-lived and shared by every scenario (and every suite
// run): without this, machine position — and therefore real sample tension —
// accumulates until moves get restricted. The sample is anchored at the
// gantry's boot position with 15 mm of physical slack above it
// (embsim gantry.rs baseline), so machine 0 is the only safe starting point.
async function zeroLength(page) {
  await page.goto(`${APP_URL}#/live`);
  await page.getByRole('button', { name: /Home/ }).waitFor({ timeout: DEVICE_WAIT_MS });
  await ensureTestIdle(page);
  const enable = page.getByRole('button', { name: 'Enable motion' });
  if (await enable.count()) await enable.click();
  await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });
  const pos = async () =>
    parseFloat(await page.locator('.readout', { hasText: 'Machine Position' }).locator('.value').first().innerText());
  let p = NaN;
  for (let i = 0; i < 40 && !Number.isFinite(p); i++) {
    p = await pos();
    if (!Number.isFinite(p)) await page.waitForTimeout(250);
  }
  await page.locator('label.field', { hasText: 'Speed (mm/s)' }).locator('input').fill('20');
  const jog = page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input');
  for (let i = 0; i < 4 && Number.isFinite(p) && Math.abs(p) > 0.5; i++) {
    await jog.fill(Math.abs(p).toFixed(2));
    const setWas = parseFloat(
      await page.locator('.readout', { hasText: 'Machine Setpoint' }).locator('.value').first().innerText(),
    );
    await page.getByRole('button', { name: p > 0 ? '− Jog down' : '+ Jog up' }).click();
    await settleMotion(page, { setpointWas: Number.isFinite(setWas) ? setWas : null });
    p = await pos();
  }
  await page.getByRole('button', { name: 'Zero length' }).click();
  await page.waitForTimeout(800);
  return p;
}

// Go to Runs and pick the (only) seeded sample + motion profile in the runner.
async function selectSeeded(page) {
  await page.goto(`${APP_URL}#/runs`);
  const runner = page.locator('.panel', { hasText: 'New Test' });
  await runner.locator('select').nth(0).selectOption({ index: 1 });
  await runner.locator('select').nth(1).selectOption({ index: 1 });
}

// Read the single downloaded run CSV from OPFS and summarise its position column.
async function readDownloadedCsvStats(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('mad-e2e');
    const tr = await dir.getDirectoryHandle('testRuns');
    let text = null;
    for await (const [n, h] of tr.entries()) {
      if (h.kind === 'file' && n.endsWith('.csv')) text = await (await h.getFile()).text();
    }
    if (!text) return null;
    const lines = text.trim().split('\n');
    const pi = lines[0].split(',').indexOf('position_um');
    const pos = lines.slice(1).map((l) => Number(l.split(',')[pi])).filter(Number.isFinite);
    return {
      header: lines[0], rows: pos.length,
      maxUm: Math.max(...pos), minUm: Math.min(...pos), firstUm: pos[0], lastUm: pos[pos.length - 1],
    };
  });
}

// ── Scenarios (extend toward TEST_PLAN.md §4) ──
const scenarios = [
  {
    id: 'A1',
    name: 'Capability gate blocks non-Chromium-capable contexts',
    async run() {
      // Remove the required APIs so the gate triggers, then load the app.
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const page = await browser.newPage();
        await page.addInitScript(() => {
          try {
            delete Navigator.prototype.serial;
          } catch {
            /* ignore */
          }
          try {
            delete Window.prototype.showDirectoryPicker;
          } catch {
            /* ignore */
          }
        });
        await page.goto(APP_URL);
        await page.getByRole('heading', { name: /Unsupported browser/i }).waitFor({ timeout: DEVICE_WAIT_MS });
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'B1+C1',
    name: 'Connect to SIL and live readouts update',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        const force = page.locator('.readout', { hasText: 'Machine Force' }).locator('.value');
        let populated = false;
        for (let i = 0; i < 40 && !populated; i++) {
          const t = (await force.textContent())?.trim() || '';
          if (/^-?\d/.test(t)) populated = true;
          else await page.waitForTimeout(250);
        }
        assert(populated, 'live readout never populated');
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'F7',
    name: 'Create: G-code preview generates G122',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await page.goto(`${APP_URL}#/create`);
        await page.getByRole('button', { name: '+ Add Set' }).click();
        await page.getByRole('button', { name: 'Preview G-code' }).click();
        const code = await page.locator('.code-block').first().textContent();
        assert((code || '').includes('G122'), 'preview missing G122');
        assert((code || '').includes('; Test Profile:'), 'preview missing header');
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'F1+F2',
    name: 'Choose OPFS folder and persist a sample profile',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await chooseDataFolder(page);
        // Sample profiles are created on the Samples page (Create is motion-only).
        await page.goto(`${APP_URL}#/profiles`);
        await fieldInput(page, 'Max Force (N)').fill('500');
        await fieldInput(page, 'Sample name').fill('E2E-Sample');
        await page.getByRole('button', { name: 'Save to folder' }).click();
        await page.getByText(/Saved to data folder/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page
          .locator('.panel', { hasText: 'Saved profiles' })
          .getByText('E2E-Sample')
          .first()
          .waitFor({ timeout: DEVICE_WAIT_MS });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'B2+B3+B4',
    name: 'Connect: baud selector, granted-ports list, responding indicator',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await page.goto(`${APP_URL}#/connect`);
        // B2: baud selector present and selectable.
        const baud = page.locator('label.field', { hasText: 'Baud rate' }).locator('select');
        await baud.selectOption('115200');
        // B3: the fake getPorts() returns one granted device → list + Connect shown.
        await page.getByTestId('connect-granted').first().waitFor({ timeout: DEVICE_WAIT_MS });
        // Connect via the granted port at the chosen baud.
        await page.getByTestId('connect-granted').first().click();
        await page.locator('.dot.connected').waitFor({ timeout: DEVICE_WAIT_MS });
        // B4: responding indicator turns to "Responding" once samples flow.
        const resp = page.getByTestId('responding');
        let ok = false;
        for (let i = 0; i < Math.ceil(DEVICE_WAIT_MS / 250) && !ok; i++) {
          if (((await resp.textContent()) || '').includes('Responding') &&
              !((await resp.textContent()) || '').includes('Not')) ok = true;
          else await page.waitForTimeout(250);
        }
        assert(ok, 'responding indicator never turned to Responding');
        // K1: the firmware version appears in the status bar once read.
        await page.locator('.statusbar').getByText(/fw /).waitFor({ timeout: DEVICE_WAIT_MS });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'C3+C4',
    name: 'Live combined chart (toggle + canvas) and live stress–strain render',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        const combined = page.locator('[data-testid="live-combined-chart"]');
        await combined.locator('canvas').first().waitFor({ timeout: DEVICE_WAIT_MS });
        // Coordinate toggle: switch to Sample and back; chart must survive.
        await combined.getByRole('button', { name: 'Sample' }).click();
        await page.waitForTimeout(300);
        await combined.locator('canvas').first().waitFor({ timeout: DEVICE_WAIT_MS });
        await combined.getByRole('button', { name: 'Machine' }).click();
        await page
          .locator('[data-testid="live-stress-strain"] canvas')
          .first()
          .waitFor({ timeout: DEVICE_WAIT_MS });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'I1-I4',
    name: 'Run viewer renders info + force/position/expected + stress–strain',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        // Choose the OPFS folder (sets DataStore.root), then seed a downloaded run.
        await chooseDataFolder(page);
        const csvRows = ['time_us,force_mN,position_um,setpoint_um'];
        for (let i = 0; i <= 50; i++) {
          const t = i * 100000; // 0.1 s steps (µs)
          const force = i * 8000; // 0..400 N (mN)
          const pos = 10000 + i * 40; // 10..12 mm (µm)
          csvRows.push(`${t},${force},${pos},${pos}`);
        }
        const run = {
          id: 'view-1',
          testName: 'E2EVIEW',
          sampleProfileId: '',
          motionProfileId: '',
          sampleProfile: {
            maxForce: 500,
            maxVelocity: 0,
            maxDisplacement: 20,
            sampleWidth: 2,
            sampleThickness: 1,
            serial: 's',
          },
          motionProfile: { name: 'M', description: '', sets: [] },
          gcode: ['G90', 'G1 X12 F5', 'G122'],
          gaugeLengthMm: 10,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: 'downloaded',
          dataFilePath: 'testRuns/E2EVIEW.csv',
        };
        await page.evaluate(
          async ({ run: r, csv }) => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('mad-e2e', { create: true });
            const runs = await dir.getDirectoryHandle('testRuns', { create: true });
            const write = async (name, content) => {
              const fh = await runs.getFileHandle(name, { create: true });
              const w = await fh.createWritable();
              await w.write(content);
              await w.close();
            };
            await write('E2EVIEW.json', JSON.stringify(r));
            await write('E2EVIEW.csv', csv);
          },
          { run, csv: csvRows.join('\n') },
        );

        await page.goto(`${APP_URL}#/view/E2EVIEW`);
        await page.getByRole('heading', { name: 'E2EVIEW' }).waitFor({ timeout: DEVICE_WAIT_MS });
        for (const id of ['chart-force', 'chart-position', 'chart-stress-strain']) {
          // eslint-disable-next-line no-await-in-loop
          await page.locator(`[data-testid="${id}"] canvas`).first().waitFor({ timeout: DEVICE_WAIT_MS });
        }
        const canvases = await page.locator('canvas').count();
        assert(canvases >= 3, `expected >=3 chart canvases, got ${canvases}`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'H1+H3+H4+H5',
    name: 'Run history: profile columns, pagination, delete-confirm, export',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await chooseDataFolder(page);
        await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('mad-e2e', { create: true });
          const runs = await dir.getDirectoryHandle('testRuns', { create: true });
          const write = async (name, content) => {
            const fh = await runs.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(content);
            await w.close();
          };
          const mkRun = (testName, status) => ({
            id: testName,
            testName,
            sampleProfileId: '',
            motionProfileId: '',
            sampleProfile: { maxForce: 100, maxVelocity: 0, maxDisplacement: 10, sampleWidth: 2, sampleThickness: 1, serial: `Smp-${testName}` },
            motionProfile: { name: `Mot-${testName}`, description: '', sets: [] },
            gcode: ['G90', 'G1 X1 F1', 'G122'],
            startedAt: new Date().toISOString(),
            status,
          });
          const index = [];
          // one downloaded run (export/view), then 11 completed (pagination).
          const exp = mkRun('E2EEXP', 'downloaded');
          await write('E2EEXP.json', JSON.stringify(exp));
          await write('E2EEXP.csv', 'time_us,force_mN,position_um,setpoint_um\n0,0,0,0\n');
          index.push({ id: exp.id, testName: exp.testName, startedAt: exp.startedAt, status: 'downloaded', sampleProfileName: exp.sampleProfile.serial, motionProfileName: exp.motionProfile.name, dataFilePath: 'testRuns/E2EEXP.csv' });
          for (let i = 1; i <= 11; i++) {
            const name = `RUN${String(i).padStart(2, '0')}`;
            const r = mkRun(name, 'completed');
            await write(`${name}.json`, JSON.stringify(r));
            index.push({ id: r.id, testName: name, startedAt: r.startedAt, status: 'completed', sampleProfileName: r.sampleProfile.serial, motionProfileName: r.motionProfile.name });
          }
          await write('index.json', JSON.stringify(index));
        });

        await page.goto(`${APP_URL}#/runs`);
        // H1: profile-name columns
        await page.getByText('Smp-RUN01').first().waitFor({ timeout: DEVICE_WAIT_MS });
        await page.getByText('Mot-E2EEXP').first().waitFor({ timeout: DEVICE_WAIT_MS });
        // H3: pagination (12 rows > page size 10)
        await page.getByRole('button', { name: /Load older runs/ }).waitFor({ timeout: DEVICE_WAIT_MS });
        // H5: export triggers a CSV download
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: DEVICE_WAIT_MS }),
          page.getByRole('button', { name: 'Export' }).first().click(),
        ]);
        assert(download.suggestedFilename().includes('_export.csv'), `bad export filename: ${download.suggestedFilename()}`);
        // H4: delete with confirm
        const row = page.locator('tr', { hasText: 'RUN01' });
        await row.getByRole('button', { name: 'Delete' }).click();
        await page.getByTestId('confirm-delete').click();
        await page.getByText('RUN01').first().waitFor({ state: 'detached', timeout: DEVICE_WAIT_MS });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'E1',
    name: 'Machine config round-trips (edit → save → reload)',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/settings`); // machine config now lives under Settings
        // Trigger a fresh read (deterministic), then wait for the field.
        await page.getByRole('button', { name: 'Reload from device' }).click().catch(() => {});
        const field = page.locator('label.field', { hasText: 'Jaw Offset (mm)' }).locator('input');
        await field.waitFor({ timeout: DEVICE_WAIT_MS });
        const target = '13'; // jaw offset is integer-scaled on the wire — use a whole number
        // Wait for the form to stop repainting before typing. The Reload click
        // above starts an async device read, and if its response lands AFTER the
        // fill it repaints the form and silently discards the edit — the save
        // then goes out with changedCount 0 and this scenario asserts a
        // round-trip against a value nobody ever wrote. Whether the response
        // wins that race is pure timing, which is why it only shows on a slow
        // host (the emulator manages ~0.25x real time on a CI runner).
        const settledValue = async (loc, { ticks = 3, pollMs = 200, timeoutMs = 20000 } = {}) => {
          const deadline = Date.now() + timeoutMs;
          let last = null;
          let n = 0;
          while (Date.now() < deadline) {
            const v = await loc.inputValue();
            if (v === last) {
              if (++n >= ticks) return v;
            } else {
              n = 0;
            }
            last = v;
            await page.waitForTimeout(pollMs);
          }
          return last;
        };
        await settledValue(field);
        await field.fill(target);
        // And confirm the edit actually stuck — a late repaint would have wiped
        // it, and saving an unchanged form proves nothing.
        for (let i = 0; i < 5 && (await field.inputValue()) !== target; i++) {
          await page.waitForTimeout(200);
          await field.fill(target);
        }
        assert(
          (await field.inputValue()) === target,
          'the jaw offset edit did not stick before saving — the form was repainted mid-edit',
        );
        await page.getByRole('button', { name: 'Save to device' }).click();
        await page.getByText(/Saved to device/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.getByRole('button', { name: 'Reload from device' }).click();
        const val = await settledValue(field);
        assert(Number(val) === Number(target), `jaw offset did not round-trip: got ${val}`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'D1',
    name: 'Manual control: enable motion reflects in machine state',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        // Confirm the Live controls are present (i.e. connected).
        await page.getByRole('button', { name: /Home/ }).waitFor({ timeout: DEVICE_WAIT_MS });
        const enableBtn = page.getByRole('button', { name: 'Enable motion' });
        if (await enableBtn.count()) await enableBtn.click();
        // State poll should report motion enabled (badge text flips).
        await page
          .getByText('Motion: enabled')
          .waitFor({ timeout: DEVICE_WAIT_MS })
          .catch(() => {
            throw new Error('motion did not report enabled');
          });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'F4+F6',
    name: 'Create: build motion profile (dwell), save, import .mp',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await chooseDataFolder(page);
        await page.goto(`${APP_URL}#/create`);
        const motionPanel = page.locator('.panel', { hasText: 'Motion Profile' });
        await fieldInput(motionPanel, 'Name').first().fill('E2E-Motion-Build');
        // change the default move to a dwell of 1500 ms
        await page.locator('.move-row select').first().selectOption('dwell');
        await page.locator('.move-row label.field', { hasText: 'Time (ms)' }).locator('input').fill('1500');
        await page.getByRole('button', { name: 'Save Motion Profile' }).click();
        await page.getByText(/Motion profile .* saved/i).waitFor({ timeout: DEVICE_WAIT_MS });
        const opts = await motionPanel.locator('select').last().locator('option').allTextContents();
        assert(opts.some((o) => o.includes('E2E-Motion-Build')), 'saved motion profile not listed');
        // preview reflects the dwell + trailing G122
        await page.getByRole('button', { name: 'Preview G-code' }).click();
        const code = await page.locator('.code-block').first().textContent();
        assert((code || '').includes('G4 P1500'), 'preview missing dwell');
        assert((code || '').includes('G122'), 'preview missing G122');
        await page.getByRole('button', { name: '✕' }).first().click().catch(() => {});
        // F6: import a .mp file populates the editor
        const mp = JSON.stringify({ name: 'Imported-MP', description: 'imp', sets: [] });
        await page.locator('input[accept*=".mp"]').setInputFiles({
          name: 'x.mp',
          mimeType: 'application/json',
          buffer: Buffer.from(mp),
        });
        await page.waitForTimeout(300);
        const nameVal = await fieldInput(motionPanel, 'Name').first().inputValue();
        assert(nameVal === 'Imported-MP', `import did not populate name: ${nameVal}`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    // NOTE: SIL does not faithfully simulate the full run lifecycle — it never
    // observably toggles `testRunning` (the simulated dwell completes between
    // 1 s state polls) and FILE_DOWNLOAD returns "not ready" (no SD test-data
    // logging in the emulator). So this asserts run-START (the part SIL supports:
    // sample-profile write + move upload + TEST_RUN ACK). Auto-completion and
    // data download match the desktop and require real hardware. See docs/PARITY.md §9.
    id: 'G1',
    name: 'Run start on SIL (profile→firmware, G-code upload, TEST_RUN)',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        // Seed a sample + motion profile (a 2 s dwell so the run is observable).
        await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('mad-e2e', { create: true });
          const write = async (sub, name, obj) => {
            const d = await dir.getDirectoryHandle(sub, { create: true });
            const fh = await d.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(JSON.stringify(obj));
            await w.close();
          };
          await write('sampleProfiles', 'G-Sample.json', {
            id: 'gs', name: 'G-Sample', createdAt: new Date().toISOString(),
            profile: { maxForce: 500, maxVelocity: 5, maxDisplacement: 20, sampleWidth: 2, sampleThickness: 1, serial: 'G-Sample' },
          });
          await write('motionProfiles', 'G-Motion.json', {
            id: 'gm', name: 'G-Motion', description: 'dwell', createdAt: new Date().toISOString(),
            profile: { name: 'G-Motion', description: 'dwell', sets: [
              { name: 'S', executions: 1, moves: [
                { moveType: 'dwell', absoluteOrRelative: 'absolute', moveParameters: { position: 0, velocity: 0, distance: 0, time: 2000, circularOffset: 0 } },
              ] },
            ] },
          });
        });

        await page.goto(`${APP_URL}#/runs`);
        const runnerPanel = page.locator('.panel', { hasText: 'New Test' });
        await runnerPanel.locator('select').nth(0).selectOption({ index: 1 });
        await runnerPanel.locator('select').nth(1).selectOption({ index: 1 });
        await page.getByTestId('run-test').click();

        // The run record is created and the device accepts the test (status running).
        await page.locator('.panel', { hasText: 'New Test' }).getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.locator('tbody .badge', { hasText: 'running' }).first().waitFor({ timeout: DEVICE_WAIT_MS });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'G2+G3+H2+I',
    name: 'Full lifecycle: run → auto-complete → download → CSV matches motion → view',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500); // let samples flow (gauge capture)
        const PEAK_MM = 15;
        await seedProfiles(page, {
          sample: { serial: 'Life-Sample', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Life-Motion', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 5, distance: PEAK_MM, time: 0, circularOffset: 0 } },
            { moveType: 'dwell', absoluteOrRelative: 'absolute', moveParameters: { position: 0, velocity: 0, distance: 0, time: 300, circularOffset: 0 } },
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: -PEAK_MM, time: 0, circularOffset: 0 } },
          ] },
        });
        await page.goto(`${APP_URL}#/runs`);
        const runner = page.locator('.panel', { hasText: 'New Test' });
        await runner.locator('select').nth(0).selectOption({ index: 1 });
        await runner.locator('select').nth(1).selectOption({ index: 1 });
        await page.getByTestId('run-test').click();
        await runner.getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        const row = page.locator('tbody tr').first();
        // G3: firmware runs the test and testRunning toggles → run auto-marks completed.
        await row.locator('.badge.completed').waitFor({ timeout: RUN_WAIT_MS });
        // H2: pull the data file from the device → CSV.
        await row.getByRole('button', { name: /Download data/i }).click();
        await row.locator('.badge.downloaded').waitFor({ timeout: RUN_WAIT_MS });
        const stats = await readDownloadedCsvStats(page);
        assert(stats, 'a downloaded CSV exists');
        assert(stats.header === 'time_us,force_mN,position_um,setpoint_um', `CSV header: ${stats.header}`);
        assert(stats.rows > 50, `enough data rows: ${stats.rows}`);
        // Data matches the motion profile: the position excursion equals the commanded peak.
        const excursionMm = (stats.maxUm - stats.minUm) / 1000;
        assert(Math.abs(excursionMm - PEAK_MM) < 3, `position excursion ~${PEAK_MM}mm (got ${excursionMm.toFixed(1)}mm)`);
        // Relative up-then-down returns near the start.
        assert(Math.abs(stats.lastUm - stats.firstUm) / 1000 < 3, `returns near start (Δ ${((stats.lastUm - stats.firstUm) / 1000).toFixed(1)}mm)`);
        // I: view the downloaded run → charts render.
        await row.getByRole('button', { name: 'View' }).click();
        await page.locator('canvas').first().waitFor({ timeout: DEVICE_WAIT_MS });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'G-limit',
    name: 'Sample maxDisplacement limit stops the test (firmware enforcement)',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        // Zero the gauge length so sample displacement starts at 0 — prior scenarios
        // may leave the gantry past the 8 mm limit, which would trip the limit instantly
        // (sub-1 s test → the 1 s testRunning poll misses it → no completion detected).
        await page.goto(`${APP_URL}#/live`);
        await page.getByRole('button', { name: 'Zero length' }).click();
        await page.waitForTimeout(800);
        const LIMIT_MM = 8;
        // Command a 20mm move but cap the sample at 8mm — the firmware should stop
        // the test when sample displacement exceeds maxDisplacement. Use a slow
        // ramp (4 mm/s → trips at ~2 s) so the 1 s testRunning poll reliably sees it.
        await seedProfiles(page, {
          sample: { serial: 'Limit-Sample', maxForce: 500, maxVelocity: 25, maxDisplacement: LIMIT_MM, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Over-Motion', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 4, distance: 20, time: 0, circularOffset: 0 } },
          ] },
        });
        await page.goto(`${APP_URL}#/runs`);
        const runner = page.locator('.panel', { hasText: 'New Test' });
        await runner.locator('select').nth(0).selectOption({ index: 1 });
        await runner.locator('select').nth(1).selectOption({ index: 1 });
        await page.getByTestId('run-test').click();
        await runner.getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        const row = page.locator('tbody tr').first();
        await row.locator('.badge.completed').waitFor({ timeout: RUN_WAIT_MS });
        await row.getByRole('button', { name: /Download data/i }).click();
        await row.locator('.badge.downloaded').waitFor({ timeout: RUN_WAIT_MS });
        const stats = await readDownloadedCsvStats(page);
        assert(stats, 'a downloaded CSV exists');
        const maxMm = stats.maxUm / 1000;
        assert(maxMm < LIMIT_MM + 3, `position capped near maxDisplacement=${LIMIT_MM}mm, not the commanded 20mm (got ${maxMm.toFixed(1)}mm)`);
        // J1: the firmware's limit-exceeded warning surfaced as a toast.
        const toasts = await page.locator('.toast').count();
        assert(toasts > 0, 'limit-exceeded firmware notification surfaced as a toast');
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
    },
  },
  {
    id: 'TC1-multiset',
    name: 'Multi-set / multi-execution profile runs every move (path length)',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        await zeroLength(page);
        // Set A: (+8,-8)×2 = 32mm; Set B: (+5,-5)×1 = 10mm → 42mm total commanded path.
        await seedProfiles(page, {
          sample: { serial: 'MS-Sample', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'MultiSet', sets: [
            { name: 'A', executions: 2, moves: [
              { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: 8, time: 0, circularOffset: 0 } },
              { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: -8, time: 0, circularOffset: 0 } },
            ] },
            { name: 'B', executions: 1, moves: [
              { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: 5, time: 0, circularOffset: 0 } },
              { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: -5, time: 0, circularOffset: 0 } },
            ] },
          ] },
        });
        await selectSeeded(page);
        await runAndDownload(page);
        const s = await readDownloadedCsvSeries(page);
        assert(s && s.pos.length > 50, `enough data (${s?.pos.length} rows)`);
        let pathMm = 0;
        for (let i = 1; i < s.pos.length; i++) pathMm += Math.abs(s.pos[i] - s.pos[i - 1]) / 1000;
        assert(pathMm > 35 && pathMm < 50, `total path ~42mm (2 sets + executions); got ${pathMm.toFixed(1)}mm`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  // M10 — firmware-native G123 waveform matrix (sine + triangle from catalog).
  ...MATRIX.M10_waveform.map((wf) => ({
    id: wf.id,
    name: `M10 waveform G123 — ${wf.shape} (${wf.label})`,
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        await zeroLength(page);
        await seedProfiles(page, {
          sample: { serial: `Wave-${wf.id}`, maxForce: 500, maxVelocity: 60, maxDisplacement: wf.maxDisp, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: wf.id, moves: [
            { moveType: 'math', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 0, distance: wf.distance, time: 0, waveform: wf.shape, amplitude: wf.amplitude, frequency: wf.frequency, cycles: wf.cycles } },
          ] },
        });
        await selectSeeded(page);
        await runAndDownload(page);
        const s = await readDownloadedCsvSeries(page);
        if (wf.shape === 'sine') {
          assertSineMatch(s, { amplitudeMm: wf.amplitude, frequencyHz: wf.frequency, cycles: wf.cycles }, wf.id);
        } else {
          assertWaveformExcursion(s, { amplitudeMm: wf.amplitude, cycles: wf.cycles, frequencyHz: wf.frequency }, wf.id);
        }
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  })),
  {
    id: 'TC4-dwell',
    name: 'Dwell (G4) holds position — adds to test duration',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        await zeroLength(page);
        // +10@10 (1s) + dwell 2000ms + -10@10 (1s) ≈ 4s total (vs ~2s with no dwell).
        await seedProfiles(page, {
          sample: { serial: 'Dwell-Sample', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Dwell', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: 10, time: 0, circularOffset: 0 } },
            { moveType: 'dwell', absoluteOrRelative: 'absolute', moveParameters: { position: 0, velocity: 0, distance: 0, time: 2000, circularOffset: 0 } },
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: -10, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        await runAndDownload(page);
        const s = await readDownloadedCsvSeries(page);
        assert(s && s.pos.length > 30, 'enough data');
        const durS = (s.time[s.time.length - 1] - s.time[0]) / 1e6;
        // ~4s total; without the 2s dwell it would be ~2s.
        assert(durS > 3.2, `2s dwell is present (total duration ${durS.toFixed(1)}s)`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'TC6-disable-stops',
    name: 'Disabling motion mid-test stops the test',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        await zeroLength(page);
        // A long, slow move so the test is comfortably running when we disable.
        await seedProfiles(page, {
          sample: { serial: 'Stop-Sample', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Long', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 3, distance: 30, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        const runner = page.locator('.panel', { hasText: 'New Test' });
        await page.getByTestId('run-test').click();
        await runner.getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        // Observe the firmware actually running, then disable motion.
        await page.goto(`${APP_URL}#/live`);
        await page.getByText('Test: running').waitFor({ timeout: DEVICE_WAIT_MS });
        await page.getByRole('button', { name: 'Disable motion' }).click();
        // The firmware aborts the test (END_MOTION_DISABLED) → Test goes idle.
        await page.getByText('Test: idle').waitFor({ timeout: DEVICE_WAIT_MS });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'TC11-velocity',
    name: 'Position follows the commanded velocity (ramp shape matches)',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        await zeroLength(page);
        const V = 5; // mm/s
        await seedProfiles(page, {
          sample: { serial: 'Vel-Sample', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Ramp', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: V, distance: 15, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        await runAndDownload(page);
        const s = await readDownloadedCsvSeries(page);
        assert(s && s.pos.length > 30, 'enough data');
        const p0 = s.pos[0];
        // At t≈1s and t≈2s the displacement should be ~V*t (within tolerance).
        const at = (target) => {
          let best = 0, bestErr = Infinity;
          for (let i = 0; i < s.time.length; i++) {
            const e = Math.abs((s.time[i] - s.time[0]) / 1e6 - target);
            if (e < bestErr) { bestErr = e; best = (s.pos[i] - p0) / 1000; }
          }
          return best;
        };
        assert(Math.abs(at(1) - V * 1) < 2, `pos@1s ~${V}mm (got ${at(1).toFixed(1)})`);
        assert(Math.abs(at(2) - V * 2) < 2, `pos@2s ~${V * 2}mm (got ${at(2).toFixed(1)})`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'VT-linear',
    name: 'CSV time_us is virtual time: at t0+100_000 µs encoder matches V·Δt',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        const V = 10; // mm/s
        // ≥2 s so the 1 Hz testRunning poll cannot miss completion (see G-limit).
        const DIST_MM = 20;
        await seedProfiles(page, {
          sample: { serial: 'VT-Sample', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'VT-Ramp', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: V, distance: DIST_MM, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        await runAndDownload(page);
        const s = await readDownloadedCsvSeries(page);
        assert(s && s.time.length > 30, `enough samples (${s?.time.length})`);
        const t0 = motionStartTimeUs(s.time, s.pos);
        assert(t0 != null, 'motion start is visible on the virtual clock');
        const p0 = interpolateAtUs(s.time, s.pos, t0);
        assert(p0 != null, 'position at motion start');

        const atRelUs = (dtUs) => {
          const um = interpolateAtUs(s.time, s.pos, t0 + dtUs);
          assert(um != null, `series covers t0+${dtUs} µs (span ${s.time[0]}..${s.time[s.time.length - 1]})`);
          return (um - p0) / 1000;
        };

        // Firmware sample.time is HAL_time_getUs() = SIL virtual_us.
        const pos100 = atRelUs(100_000);
        const expect100 = V * 0.1;
        assert(
          Math.abs(pos100 - expect100) < 0.7,
          `at t0+100_000 µs position ≈ ${expect100}mm (got ${pos100.toFixed(3)}mm)`,
        );
        const enc100 = pos100 * SIL_ENCODER_STEPS_PER_MM;
        const expectEnc = expect100 * SIL_ENCODER_STEPS_PER_MM;
        assert(
          Math.abs(enc100 - expectEnc) < 0.7 * SIL_ENCODER_STEPS_PER_MM,
          `at t0+100_000 µs encoder ≈ ${expectEnc.toFixed(0)} steps (got ${enc100.toFixed(0)})`,
        );

        const pos400 = atRelUs(400_000);
        assert(
          Math.abs(pos400 - V * 0.4) < 1.0,
          `at t0+400_000 µs position ≈ ${V * 0.4}mm (got ${pos400.toFixed(3)}mm)`,
        );
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'TC14-jog',
    name: 'Manual jog moves the gantry the commanded distance',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        await page.getByRole('button', { name: /Home/ }).waitFor({ timeout: DEVICE_WAIT_MS });
        await ensureTestIdle(page);
        const enable = page.getByRole('button', { name: 'Enable motion' });
        if (await enable.count()) await enable.click();
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });
        const posValue = () => page.locator('.readout', { hasText: 'Machine Position' }).locator('.value').first().innerText();
        await page.waitForTimeout(1000);
        const before = parseFloat(await posValue());
        await page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input').fill('5');
        const setWas = parseFloat(
          await page.locator('.readout', { hasText: 'Machine Setpoint' }).locator('.value').first().innerText(),
        );
        await page.getByRole('button', { name: '+ Jog up' }).click();
        await settleMotion(page, { setpointWas: Number.isFinite(setWas) ? setWas : null });
        const after = parseFloat(await posValue());
        const delta = after - before;
        assert(Math.abs(delta - 5) < 1.5, `jog +5mm moved the gantry ~5mm (Δ ${delta.toFixed(2)}mm)`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  // M8 — motion precision jog matrix (parameterized from matrix-catalog.json).
  ...MATRIX.M8_jog.map((cell) => ({
    id: cell.id,
    name: `M8 jog Δ=${cell.mm}mm @ ${cell.speed}mm/s${cell.roundTrip ? ' (round-trip)' : ''}`,
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        await page.getByRole('button', { name: /Home/ }).waitFor({ timeout: DEVICE_WAIT_MS });
        await ensureTestIdle(page);
        const enable = page.getByRole('button', { name: 'Enable motion' });
        if (await enable.count()) await enable.click();
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });
        const num = async (label) =>
          parseFloat(await page.locator('.readout', { hasText: label }).locator('.value').first().innerText());
        await page.waitForTimeout(800);
        const start = await num('Machine Position');
        await page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input').fill(String(cell.mm));
        await page.locator('label.field', { hasText: 'Speed (mm/s)' }).locator('input').fill(String(cell.speed));
        const setBefore = await num('Machine Setpoint');
        await page.getByRole('button', { name: '+ Jog up' }).click();
        await settleMotion(page, { setpointWas: setBefore });
        const up = await num('Machine Position');
        const upSet = await num('Machine Setpoint');
        assert(Math.abs(up - start - cell.mm) < cell.epsMm, `jog +${cell.mm}mm (Δ ${(up - start).toFixed(3)})`);
        assert(Math.abs(up - upSet) < 0.15, `settled onto setpoint (|Δ| ${Math.abs(up - upSet).toFixed(3)})`);
        if (cell.roundTrip) {
          const setBeforeDown = await num('Machine Setpoint');
          await page.getByRole('button', { name: '− Jog down' }).click();
          await settleMotion(page, { setpointWas: setBeforeDown });
          const end = await num('Machine Position');
          assert(Math.abs(end - start) < cell.epsMm, `round-trip return (Δ ${(end - start).toFixed(3)})`);
        }
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  })),
  {
    id: 'NAV',
    name: 'Connection survives navigating every page',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        for (const route of ['live', 'config', 'profiles', 'create', 'runs', 'about', 'settings', 'connect']) {
          // eslint-disable-next-line no-await-in-loop
          await page.goto(`${APP_URL}#/${route}`);
          // eslint-disable-next-line no-await-in-loop
          await page.locator('.dot.connected').waitFor({ timeout: DEVICE_WAIT_MS });
        }
        // Still responding after the tour.
        const resp = page.getByTestId('responding');
        let ok = false;
        const respDeadline = Date.now() + DEVICE_WAIT_MS;
        while (!ok && Date.now() < respDeadline) {
          const t = (await resp.textContent()) || '';
          if (t.includes('Responding') && !t.includes('Not')) ok = true;
          else await page.waitForTimeout(250);
        }
        assert(ok, 'not responding after navigation tour');
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'B5-reconnect',
    name: 'Link loss → Disconnected + toast + Reconnect → session resumes',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        await page.waitForTimeout(1500); // session fully up, samples flowing
        // Sever the link (simulates USB unplug / emulator death).
        await page.evaluate(() => window.__silDropLink());
        await page.locator('.dot.disconnected').waitFor({ timeout: DEVICE_WAIT_MS });
        await page.locator('.toast').getByText(/disconnected/i).first().waitFor({ timeout: DEVICE_WAIT_MS });
        const reconnectBtn = page.getByTestId('reconnect');
        await reconnectBtn.waitFor({ timeout: DEVICE_WAIT_MS });
        await page.waitForTimeout(1200); // let the bridge release the PTY reader
        await reconnectBtn.click();
        await page.locator('.dot.connected').waitFor({ timeout: DEVICE_WAIT_MS });
        // Samples flow again → responding.
        const resp = page.getByTestId('responding');
        let ok = false;
        for (let i = 0; i < Math.ceil(DEVICE_WAIT_MS / 250) && !ok; i++) {
          const t = (await resp.textContent()) || '';
          if (t.includes('Responding') && !t.includes('Not')) ok = true;
          else await page.waitForTimeout(250);
        }
        assert(ok, 'not responding after reconnect');
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  // M11 — link-loss moments (catalog-driven; idle + mid-test).
  {
    id: 'M11-idle-drop',
    name: 'M11 idle link drop → reconnect resumes samples',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        await page.waitForTimeout(1200);
        await page.evaluate(() => window.__silDropLink());
        await page.locator('.dot.disconnected').waitFor({ timeout: DEVICE_WAIT_MS });
        await page.getByTestId('reconnect').click();
        await page.locator('.dot.connected').waitFor({ timeout: DEVICE_WAIT_MS });
        const resp = page.getByTestId('responding');
        let ok = false;
        for (let i = 0; i < Math.ceil(DEVICE_WAIT_MS / 250) && !ok; i++) {
          const t = (await resp.textContent()) || '';
          if (t.includes('Responding') && !t.includes('Not')) ok = true;
          else await page.waitForTimeout(250);
        }
        assert(ok, 'not responding after idle reconnect');
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'M11-mid-test-drop',
    name: 'M11 mid-test link drop: UI disconnects without crashing; reconnect restores monitor',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2000);
        await zeroLength(page);
        await seedProfiles(page, {
          sample: { serial: 'M11-Drop', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'LongDrop', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 2, distance: 40, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        await page.getByTestId('run-test').click();
        await page.locator('.panel', { hasText: 'New Test' }).getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.goto(`${APP_URL}#/live`);
        await page.getByText('Test: running').waitFor({ timeout: DEVICE_WAIT_MS });
        // Drop link while test is running — UI must not throw; machine keeps going.
        await page.evaluate(() => window.__silDropLink());
        await page.locator('.dot.disconnected').waitFor({ timeout: DEVICE_WAIT_MS });
        // Run status should remain running on host (machine autonomous) or at least not crash.
        await page.waitForTimeout(500);
        await page.getByTestId('reconnect').click();
        await page.locator('.dot.connected').waitFor({ timeout: DEVICE_WAIT_MS });
        // Eventually idle again (test completes or was aborted by prior state).
        await page.getByText(/Test: (running|idle)/).waitFor({ timeout: RUN_WAIT_MS });
        // Do not hand the next scenario a machine that is still mid-test. This
        // move is 40 mm at 2 mm/s — 20 s of SIMULATED time, which is ~a minute
        // of wall time on a CI runner — and the manual controls stay gated for
        // all of it.
        await ensureTestIdle(page);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'D2-settled-jog',
    name: 'Settled jog: position tracks setpoint; round trip returns to start',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        await page.getByRole('button', { name: /Home/ }).waitFor({ timeout: DEVICE_WAIT_MS });
        await ensureTestIdle(page);
        const enable = page.getByRole('button', { name: 'Enable motion' });
        if (await enable.count()) await enable.click();
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });
        const num = async (label) =>
          parseFloat(await page.locator('.readout', { hasText: label }).locator('.value').first().innerText());
        await page.waitForTimeout(1000);
        const startPos = await num('Machine Position');
        await page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input').fill('4');
        await page.locator('label.field', { hasText: 'Speed (mm/s)' }).locator('input').fill('20');
        const upSetWas = await num('Machine Setpoint');
        await page.getByRole('button', { name: '+ Jog up' }).click();
        await settleMotion(page, { setpointWas: upSetWas });
        const upPos = await num('Machine Position');
        const upSet = await num('Machine Setpoint');
        assert(Math.abs(upPos - startPos - 4) < 0.2, `jog +4mm landed (Δ ${(upPos - startPos).toFixed(3)}mm)`);
        assert(Math.abs(upPos - upSet) < 0.12, `position settles onto setpoint (|Δ| ${Math.abs(upPos - upSet).toFixed(3)}mm)`);
        const downSetWas = await num('Machine Setpoint');
        await page.getByRole('button', { name: '− Jog down' }).click();
        await settleMotion(page, { setpointWas: downSetWas });
        const endPos = await num('Machine Position');
        const endSet = await num('Machine Setpoint');
        assert(Math.abs(endPos - endSet) < 0.12, `position settles after down-jog (|Δ| ${Math.abs(endPos - endSet).toFixed(3)}mm)`);
        assert(Math.abs(endPos - startPos) < 0.2, `round trip returns to start (Δ ${(endPos - startPos).toFixed(3)}mm)`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'D3+SR-slack',
    name: 'Zero length/force calibrate; slack→tension force model',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        // zeroLength returns the gantry to machine zero (the slack-zone anchor)
        // and zeroes the gauge — both prerequisites for the model assertions.
        const restPos = await zeroLength(page);
        assert(Math.abs(restPos) < 1, `gantry returned to machine zero (got ${restPos})`);
        const num = async (label) =>
          parseFloat(await page.locator('.readout', { hasText: label }).locator('.value').first().innerText());
        const jog = page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input');
        const zeroedPos = await num('Sample Position');
        assert(Math.abs(zeroedPos) < 1, `zero length → sample position ≈ 0 (got ${zeroedPos})`);
        await page.getByRole('button', { name: 'Zero force' }).click();
        await page.waitForTimeout(800);
        const zeroedForce = await num('Sample Force');
        assert(Math.abs(zeroedForce) < 1, `zero force → sample force ≈ 0 (got ${zeroedForce})`);
        // M9 cells: mid-slack force≈0, past-slack force>min.
        for (const cell of MATRIX.M9_force_slack) {
          await jog.fill(String(cell.jogMm));
          // Return near zero between cells when needed.
          const cellSetWas = await num('Machine Setpoint');
          if (cell.jogMm >= 18) {
            // cumulative: we may already be at ~10 from prior cell — go absolute via extra jog
            await page.getByRole('button', { name: '+ Jog up' }).click();
          } else {
            await page.getByRole('button', { name: '+ Jog up' }).click();
          }
          await settleMotion(page, { setpointWas: cellSetWas });
          const pos = await num('Sample Position');
          const force = await num('Sample Force');
          assert(pos > cell.minPosMm, `${cell.id}: pos > ${cell.minPosMm} (got ${pos})`);
          if (cell.expectForceNearZero) {
            assert(Math.abs(force) < (cell.forceEpsN ?? 0.15), `${cell.id}: force≈0 (got ${force})`);
          } else {
            assert(force > (cell.minForceN ?? 0.1), `${cell.id}: tension force (got ${force})`);
          }
        }
        // Return so later scenarios start near zero.
        await jog.fill('25');
        const returnSetWas = await num('Machine Setpoint');
        await page.getByRole('button', { name: '− Jog down' }).click();
        await settleMotion(page, { setpointWas: returnSetWas });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  // M9 dedicated cells (also exercised inside D3+SR-slack for the full path).
  ...MATRIX.M9_force_slack.map((cell) => ({
    id: cell.id,
    name: `M9 force model @ +${cell.jogMm}mm sample extension`,
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await zeroLength(page);
        const num = async (label) =>
          parseFloat(await page.locator('.readout', { hasText: label }).locator('.value').first().innerText());
        await page.getByRole('button', { name: 'Zero force' }).click();
        await page.waitForTimeout(600);
        const jog = page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input');
        // Two jogs of half if past slack so we don't overshoot from boot.
        const half = cell.jogMm / 2;
        await jog.fill(String(half));
        const firstSetWas = await num('Machine Setpoint');
        await page.getByRole('button', { name: '+ Jog up' }).click();
        await settleMotion(page, { setpointWas: firstSetWas });
        const secondSetWas = await num('Machine Setpoint');
        await page.getByRole('button', { name: '+ Jog up' }).click();
        await settleMotion(page, { setpointWas: secondSetWas });
        const pos = await num('Sample Position');
        const force = await num('Sample Force');
        assert(pos > cell.minPosMm * 0.85, `${cell.id}: pos (got ${pos})`);
        if (cell.expectForceNearZero) {
          assert(Math.abs(force) < (cell.forceEpsN ?? 0.15), `${cell.id}: force≈0 (got ${force})`);
        } else {
          assert(force > (cell.minForceN ?? 0.1), `${cell.id}: tension (got ${force})`);
        }
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  })),
  {
    id: 'P1-precision',
    name: 'Fractional setpoint survives wire/decode at sub-mm precision',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        await zeroLength(page);
        const TARGET_MM = 7.503;
        await seedProfiles(page, {
          sample: { serial: 'Frac-Sample', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Frac', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 8, distance: TARGET_MM, time: 0, circularOffset: 0 } },
            { moveType: 'dwell', absoluteOrRelative: 'absolute', moveParameters: { position: 0, velocity: 0, distance: 0, time: 300, circularOffset: 0 } },
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 8, distance: -TARGET_MM, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        await runAndDownload(page);
        // Inspect the setpoint column: the commanded peak must keep its fraction.
        const sp = await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('mad-e2e');
          const tr = await dir.getDirectoryHandle('testRuns');
          let text = null;
          for await (const [n, h] of tr.entries()) {
            if (h.kind === 'file' && n.endsWith('.csv')) text = await (await h.getFile()).text();
          }
          if (!text) return null;
          const lines = text.trim().split('\n');
          const si = lines[0].split(',').indexOf('setpoint_um');
          const set = lines.slice(1).map((l) => Number(l.split(',')[si])).filter(Number.isFinite);
          return { maxUm: Math.max(...set), firstUm: set[0] };
        });
        assert(sp, 'downloaded CSV with setpoint column');
        const peakMm = (sp.maxUm - sp.firstUm) / 1000;
        assert(Math.abs(peakMm - TARGET_MM) < 0.05, `setpoint peak ${TARGET_MM}mm at sub-mm precision (got ${peakMm.toFixed(3)}mm)`);
        const fracUm = (((sp.maxUm - sp.firstUm) % 1000) + 1000) % 1000;
        assert(Math.abs(fracUm - 503) < 60, `the 0.503mm fraction survived encode/decode (got ${fracUm}µm)`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'BB-back-to-back',
    name: 'Two consecutive runs both execute and complete',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        await zeroLength(page);
        await seedProfiles(page, {
          sample: { serial: 'BB-Sample', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'BB', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: 6, time: 0, circularOffset: 0 } },
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: -6, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        // Run #1.
        await page.getByTestId('run-test').click();
        await page.locator('tbody tr').first().locator('.badge.completed').waitFor({ timeout: RUN_WAIT_MS });
        // Run #2 — same profiles, immediately after (newest run is prepended).
        await page.getByTestId('run-test').click();
        await page.locator('tbody tr').nth(1).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.locator('tbody tr').first().locator('.badge.completed').waitFor({ timeout: RUN_WAIT_MS });
        const names = await page.locator('tbody tr td:first-child').allTextContents();
        assert(new Set(names.slice(0, 2)).size === 2, `two distinct runs recorded (${names.slice(0, 2).join(', ')})`);
        const completed = await page.locator('tbody .badge.completed').count();
        assert(completed >= 2, `both runs completed (got ${completed})`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    // Port of SIL testmanagement-lifecycle: mid-flight disable must clear busy
    // so a fresh test can start and complete (isBusy race class, c081e6c8).
    id: 'TM-busy-restart',
    name: 'Mid-flight cancel recycles: fresh test starts and completes after disable-stop',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        await zeroLength(page);
        await seedProfiles(page, {
          sample: { serial: 'TM-Restart', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Long-TM', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 3, distance: 30, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        await page.getByTestId('run-test').click();
        await page.locator('.panel', { hasText: 'New Test' }).getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.goto(`${APP_URL}#/live`);
        await page.getByText('Test: running').waitFor({ timeout: DEVICE_WAIT_MS });
        await page.getByRole('button', { name: 'Disable motion' }).click();
        await page.getByText('Test: idle').waitFor({ timeout: DEVICE_WAIT_MS });
        // Re-enable and start a short second test immediately — stuck busy would block it.
        await page.getByRole('button', { name: 'Enable motion' }).click();
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });
        await seedProfiles(page, {
          sample: { serial: 'TM-Restart2', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Short-TM', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: 5, time: 0, circularOffset: 0 } },
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: -5, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        await page.getByTestId('run-test').click();
        await page.locator('.panel', { hasText: 'New Test' }).getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.goto(`${APP_URL}#/live`);
        await page.getByText('Test: running').waitFor({ timeout: 20000 });
        await page.getByText('Test: idle').waitFor({ timeout: RUN_WAIT_MS });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    // UI + firmware busy gate: jog controls disabled while testRunning; re-enabled when idle.
    id: 'TM-manual-gate',
    name: 'Manual jog controls gated while a test is running and released once idle',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await page.waitForTimeout(2500);
        await zeroLength(page);
        // Idle baseline: jog enabled.
        await page.goto(`${APP_URL}#/live`);
        await page.getByRole('button', { name: /Home/ }).waitFor({ timeout: DEVICE_WAIT_MS });
        await ensureTestIdle(page);
        const enable = page.getByRole('button', { name: 'Enable motion' });
        if (await enable.count()) await enable.click();
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });
        const jogUp = page.getByRole('button', { name: '+ Jog up' });
        assert(await jogUp.isEnabled(), 'jog enabled while idle');
        await seedProfiles(page, {
          sample: { serial: 'TM-Gate', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Gate-Long', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 3, distance: 25, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        await page.getByTestId('run-test').click();
        await page.locator('.panel', { hasText: 'New Test' }).getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.goto(`${APP_URL}#/live`);
        await page.getByText('Test: running').waitFor({ timeout: DEVICE_WAIT_MS });
        assert(await jogUp.isDisabled(), 'jog disabled while test running');
        await page.getByText('Test: idle').waitFor({ timeout: RUN_WAIT_MS });
        assert(await jogUp.isEnabled(), 'jog re-enabled once idle');
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'FW1',
    name: 'Firmware: flash a .bin through the boot ROM loader',
    async run() {
      // Uses the in-page boot-ROM fake, not SIL: the emulator has no P2 boot
      // ROM and the WS bridge carries no DTR line. See installFakeBootRom.
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.addInitScript(installFakeBootRom);
        await page.addInitScript(installOpfsDataDir, OPFS_DIR);
        // The flash confirm() must be accepted for the run to proceed.
        page.on('dialog', (d) => d.accept());

        await page.goto(`${APP_URL}#/firmware`);
        // Flash is the only mode the app offers: the P2 Edge boots from SPI
        // flash, so a RAM load would look like a successful update and then
        // vanish on the next power cycle. RAM loading lives in the CLI.
        assert(
          (await page.getByRole('radio').count()) === 0,
          'a programming-mode selector reappeared in the UI',
        );
        assert(
          (await page.getByTestId('flash-firmware').textContent())?.includes('Write to flash'),
          'flash button no longer says what it does',
        );
        // The target must be named before anything is written.
        await page.getByTestId('flash-target').filter({ hasText: /USB 0403:6015/ })
          .waitFor({ timeout: DEVICE_WAIT_MS });

        // A 2000-byte image: spans multiple 128-byte chunks with a partial tail.
        const SIZE = 2000;
        await page.getByTestId('firmware-file').setInputFiles({
          name: 'program.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 7) & 0xff)),
        });

        await page.getByTestId('flash-firmware').click();
        await page.getByTestId('flash-status').filter({ hasText: /Wrote .* bytes to flash/ })
          .waitFor({ timeout: 30000 });

        const rom = await page.evaluate(() => ({
          reset: window.__bootRom.reset,
          len: window.__bootRom.image.length,
          finished: window.__bootRom.finished,
          head: window.__bootRom.image.slice(0, 4),
          payload: window.__bootRom.image.slice(496, 496 + 8),
        }));

        assert(rom.reset >= 1, `expected a DTR reset pulse, saw ${rom.reset}`);
        assert(rom.finished, 'boot ROM never saw the end-of-download marker');
        // 496-byte flash stub + the payload.
        assert(rom.len === 496 + SIZE, `image length ${rom.len}, expected ${496 + SIZE}`);
        // Payload must follow the stub byte-for-byte.
        assert(
          JSON.stringify(rom.payload) === JSON.stringify([0, 7, 14, 21, 28, 35, 42, 49]),
          `payload after stub was ${JSON.stringify(rom.payload)}`,
        );
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'FW3',
    name: 'Firmware: refuses to guess a target when adapters are ambiguous',
    async run() {
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const page = await browser.newPage();
        // Two indistinguishable adapters and no remembered choice.
        await page.addInitScript(installFakeBootRom, { ports: 2 });
        await page.addInitScript(installOpfsDataDir, OPFS_DIR);

        await page.goto(`${APP_URL}#/firmware`);
        await page.getByTestId('flash-target').filter({ hasText: /choose which one/i })
          .waitFor({ timeout: DEVICE_WAIT_MS });

        await page.getByTestId('firmware-file').setInputFiles({
          name: 'program.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from([1, 2, 3, 4]),
        });
        // A file alone must not be enough to arm the button.
        assert(
          await page.getByTestId('flash-firmware').isDisabled(),
          'flash button was enabled without an unambiguous target',
        );
      } finally { await browser.close(); }
    },
  },
  {
    id: 'FW5',
    name: 'Firmware: declining the confirmation programs nothing',
    async run() {
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const page = await browser.newPage();
        await page.addInitScript(installFakeBootRom);
        await page.addInitScript(installOpfsDataDir, OPFS_DIR);
        page.on('dialog', (d) => d.dismiss());

        await page.goto(`${APP_URL}#/firmware`);
        await page.getByTestId('flash-target').filter({ hasText: /USB 0403:6015/ }).waitFor();
        await page.getByTestId('firmware-file').setInputFiles({
          name: 'program', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3, 4]),
        });
        await page.getByTestId('flash-firmware').click();

        // Give the click somewhere to go before asserting nothing happened.
        await page.waitForTimeout(500);
        const rom = await page.evaluate(() => ({
          reset: window.__bootRom.reset,
          bytesIn: window.__bootRom.bytesIn,
        }));
        assert(rom.reset === 0, `board was reset despite declining (${rom.reset})`);
        assert(rom.bytesIn === 0, `bytes were sent despite declining (${rom.bytesIn})`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'FW6',
    name: 'Firmware: implausible files are rejected before the chip is touched',
    async run() {
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const page = await browser.newPage();
        await page.addInitScript(installFakeBootRom);
        await page.addInitScript(installOpfsDataDir, OPFS_DIR);
        await page.goto(`${APP_URL}#/firmware`);
        await page.getByTestId('flash-target').filter({ hasText: /USB/ }).waitFor();

        // Larger than the P2's 512 KiB hub RAM.
        await page.getByTestId('firmware-file').setInputFiles({
          name: 'not-firmware.iso', mimeType: 'application/octet-stream',
          buffer: Buffer.alloc(512 * 1024 + 1),
        });
        await page.getByTestId('file-error').filter({ hasText: /hub RAM/i }).waitFor();
        assert(await page.getByTestId('flash-firmware').isDisabled(), 'oversized file armed the button');

        await page.getByTestId('firmware-file').setInputFiles({
          name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0),
        });
        await page.getByTestId('file-error').filter({ hasText: /empty/i }).waitFor();

        // An extensionless PlatformIO build must be accepted.
        await page.getByTestId('firmware-file').setInputFiles({
          name: 'program', mimeType: 'application/octet-stream', buffer: Buffer.alloc(64),
        });
        await page.waitForTimeout(200);
        assert((await page.getByTestId('file-error').count()) === 0, 'valid build was rejected');
        assert(await page.getByTestId('flash-firmware').isEnabled(), 'valid build did not arm the button');
      } finally { await browser.close(); }
    },
  },
  {
    id: 'FW7',
    name: 'Firmware: every control is locked while programming, and progress shows',
    async run() {
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const page = await browser.newPage();
        // Slow the sink so the mid-upload state is observable.
        await page.addInitScript(installFakeBootRom, { writeDelayMs: 12 });
        await page.addInitScript(installOpfsDataDir, OPFS_DIR);
        page.on('dialog', (d) => d.accept());

        await page.goto(`${APP_URL}#/firmware`);
        await page.getByTestId('flash-target').filter({ hasText: /USB/ }).waitFor();
        await page.getByTestId('firmware-file').setInputFiles({
          name: 'program', mimeType: 'application/octet-stream', buffer: Buffer.alloc(4096),
        });
        await page.getByTestId('flash-firmware').click();

        await page.getByTestId('flash-status').filter({ hasText: /Uploading… \d+%/ }).waitFor({ timeout: 20000 });
        for (const id of ['flash-firmware', 'firmware-file', 'choose-flash-port']) {
          assert(await page.getByTestId(id).isDisabled(), `${id} was still enabled mid-flash`);
        }
        await page.getByTestId('flash-status').filter({ hasText: /Wrote .* bytes to flash/ })
          .waitFor({ timeout: RUN_WAIT_MS });
      } finally { await browser.close(); }
    },
  },
  {
    id: 'FW8',
    name: 'Firmware: no granted port, and a getPorts failure, both degrade gracefully',
    async run() {
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await page.addInitScript(installFakeBootRom, { ports: 0 });
        await page.addInitScript(installOpfsDataDir, OPFS_DIR);
        await page.goto(`${APP_URL}#/firmware`);
        await page.getByTestId('flash-target').filter({ hasText: /No serial device yet/i }).waitFor();
        assert(await page.getByTestId('flash-firmware').isDisabled(), 'armed with no port');
        await browser.close();

        // A getPorts() that rejects must not break the screen either.
        const b2 = await chromium.launch({ channel: 'chrome', headless: true });
        const p2 = await b2.newPage();
        p2.on('pageerror', (e) => errors.push(e.message));
        await p2.addInitScript(installFakeBootRom, { getPortsFails: true });
        await p2.addInitScript(installOpfsDataDir, OPFS_DIR);
        await p2.goto(`${APP_URL}#/firmware`);
        await p2.getByTestId('flash-target').filter({ hasText: /No serial device yet/i }).waitFor();
        await b2.close();

        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { /* browsers closed above */ }
    },
  },
  {
    id: 'FW9',
    name: 'Firmware: an explicit port choice is remembered across reloads',
    async run() {
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const page = await browser.newPage();
        await page.addInitScript(installFakeBootRom, { ports: 2 });
        await page.addInitScript(installOpfsDataDir, OPFS_DIR);

        await page.goto(`${APP_URL}#/firmware`);
        await page.getByTestId('flash-target').filter({ hasText: /choose which one/i }).waitFor();
        await page.getByTestId('choose-flash-port').click();
        await page.getByTestId('flash-target').filter({ hasText: /USB 0403:6015/ }).waitFor();

        const pref = await page.evaluate(() => localStorage.getItem('mad.flashPort'));
        assert(pref && JSON.parse(pref).vendorId === 0x0403, `preference not stored: ${pref}`);

        // The choice must survive a reload rather than asking again.
        await page.reload();
        await page.getByTestId('flash-target').filter({ hasText: /USB 0403:6015/ }).waitFor();
      } finally { await browser.close(); }
    },
  },
  {
    id: 'FW2',
    name: 'Firmware: a silent boot ROM surfaces a readable error',
    async run() {
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const page = await browser.newPage();
        await page.addInitScript(installFakeBootRom);
        await page.addInitScript(installOpfsDataDir, OPFS_DIR);
        // Make the ROM deaf: swallow the reset so it never starts answering.
        await page.addInitScript(() => {
          window.addEventListener('load', () => {
            window.__bootRom.reset = -999;
          });
        });
        page.on('dialog', (d) => d.accept());

        await page.goto(`${APP_URL}#/firmware`);
        await page.getByTestId('firmware-file').setInputFiles({
          name: 'program.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from([1, 2, 3, 4]),
        });
        await page.getByTestId('flash-firmware').click();
        await page.getByTestId('flash-status').filter({ hasText: /No response from the Propeller 2/ })
          .waitFor({ timeout: 30000 });
      } finally { await browser.close(); }
    },
  },
];

async function main() {
  // Fail fast with guidance if the dev server isn't up.
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(`✗ App not reachable at ${APP_URL}. Start: npm run dev (and make playground + npm run sil:bridge).`);
    process.exit(2);
  }

  // Ids address scenarios — in SCENARIOS, in smoke-ids.txt, and in every failure
  // report — so a duplicate silently runs two different scenarios under one
  // name. That happened: the firmware-flash scenario shared `G1` with the
  // run-start one, so a smoke list naming `G1` ran both and the report showed
  // two lines with the same id.
  const duplicates = scenarios
    .map((s) => s.id)
    .filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicates.length) {
    console.error(`✗ duplicate scenario ids: ${[...new Set(duplicates)].join(', ')}`);
    process.exit(2);
  }

  // SCENARIOS="F1+F2,F7" npm run e2e — run a subset (exact ids, comma-separated).
  const only = process.env.SCENARIOS
    ? new Set(process.env.SCENARIOS.split(',').map((s) => s.trim()))
    : null;
  const selected = only ? scenarios.filter((s) => only.has(s.id)) : scenarios;

  // A misspelled or renamed id would otherwise just shrink the run — the suite
  // still reports "N/N passed" and nothing says the scenario never ran.
  if (only) {
    const known = new Set(scenarios.map((s) => s.id));
    const unknown = [...only].filter((id) => !known.has(id));
    if (unknown.length) {
      console.error(`✗ SCENARIOS names ids that do not exist: ${unknown.join(', ')}`);
      process.exit(2);
    }
  }

  let pass = 0;
  const failures = [];
  for (const s of selected) {
    process.stdout.write(`• ${s.id} ${s.name} … `);
    setCurrentScenario(s.id);
    try {
      // eslint-disable-next-line no-await-in-loop
      await s.run();
      console.log('✅');
      pass += 1;
    } catch (err) {
      console.log('❌');
      failures.push(`${s.id} ${s.name}: ${err.message}`);
      // Every failure carries the app's merged main+worker log, so a red CI run
      // is diagnosable without reproducing it locally.
      // eslint-disable-next-line no-await-in-loop
      await dumpFailureArtifacts(s.id, err).catch(() => {});
    }
    // Settle: let the bridge fully release the PTY before the next client connects
    // (only one app may hold the serial stream at a time).
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 800));
  }

  console.log(`\n${pass}/${selected.length} scenarios passed${only ? ' (filtered)' : ''}`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('✅ E2E seed suite green');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
