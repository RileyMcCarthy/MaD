/**
 * E2E parity suite runner.
 *
 * Drives the real app against the live SIL emulator and an OPFS data folder —
 * see fixtures.mjs and docs/TEST_PLAN.md.
 *
 * There are exactly TWO valid configurations, and each pairs a firmware backend
 * with a way of providing serial. Do not mix them: the cross pairings either
 * cannot start (native + QEMU is refused by the emulator) or silently measure
 * the host rather than the machine (the ISS behind the bridge).
 *
 * (a) NATIVE + BRIDGE — host Chrome, fake serial over the WS bridge:
 *   cd SIL && make e2e-emulator        # emulator on /tmp/tty.rpi (unpaced virtual time)
 *   npm run sil:bridge                 # ws://localhost:9999
 *   npm run dev                        # app on http://localhost:5174
 *   npm run e2e
 *
 * (b) ISS + COMPUTER NODE — the shipped P2 image interpreted instruction by
 * instruction, and Chrome inside a QEMU guest the board's clock meters, talking
 * real Web Serial to the emulated FTDI. The browser cannot outrun the board,
 * because the board decides when the browser's vCPU runs at all:
 *   cd SIL && make playground-cosim    # DevTools on 9222, control on 9223
 *   npm run dev -- --host              # the guest fetches from 10.0.2.2:5174
 *   CDP_URL=http://127.0.0.1:9222 npm run e2e
 *
 * In (b) every budget here is multiplied by E2E_TIMEOUT_SCALE (10 by default).
 * The three link-drop scenarios run in both: fixtures' dropLink() uses the
 * fake serial's `__silDropLink` under the bridge and, in computer-node mode,
 * asks the board to unplug its emulated FTDI for a few seconds -- a genuine
 * USB detach the guest kernel and Chrome both see. That needs mad-emulator
 * started with --trace-port (CONTROL_URL, default http://127.0.0.1:9223).
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
  recoverMachine,
  chooseDataFolder,
  dumpFailureArtifacts,
  setCurrentScenario,
  installFakeBootRom,
  installOpfsDataDir,
  OPFS_DIR,
  APP_URL,
  APP_URL_HOST,
  dropLink,
  CDP_URL,
  T,
  boardGrantedPort,
  chromium,
} from './fixtures.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CONTRACT_UM,
  assertFollowsLinearUm,
  assertFollowsSineWindowUm,
} from './motion-accuracy.mjs';

import {
  interpolateAtUs,
  motionStartTimeUs,
  resampledPathMm,
  assertSineMatch,
  assertWaveformExcursion,
} from './waveformMetrics.mjs';

/** Sprint C parameterized matrices (M8–M12). */
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
//
// On the ISS the multiplier is not a slow host but the execution model: the
// board interprets every P2 instruction, and the browser is inside a VM the
// board's clock meters, so a simulated second costs far more than a second of
// wall time. `T()` carries that factor (E2E_TIMEOUT_SCALE, 10x under CDP) so
// both SIL configurations share one set of budgets instead of two.
const DEVICE_WAIT_MS = T(60_000);

// Budget for a whole TEST PROGRAM: upload, execute every move, complete, and
// come to rest — or for pulling the recorded data back off the device. The
// longest profiles here are several seconds of SIMULATED motion, and the same
// pacing that makes DEVICE_WAIT_MS generous applies to all of it at once, so
// this is minutes of wall time on a slow host. Same reasoning: it bounds a
// hang, it never paces a passing run.
const RUN_WAIT_MS = T(180_000);

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
    const ti = hdr.indexOf('time_us');
    const pi = hdr.indexOf('position_nm');
    const si = hdr.indexOf('setpoint_nm');
    const time = [], pos = [], setpoint = [];
    for (const l of lines.slice(1)) {
      const c = l.split(',');
      const t = Number(c[ti]), p = Number(c[pi]);
      const sp = si >= 0 ? Number(c[si]) : NaN;
      // The CSV is in NANOMETRES; `pos` stays in micrometres so every existing
      // µm-based threshold and `/1000` to mm keeps working — but FRACTIONAL,
      // so the sub-micron detail the column now carries is not thrown away
      // here. Rounding to integer µm at this boundary would undo the whole
      // point of widening the record.
      if (Number.isFinite(t) && Number.isFinite(p)) {
        time.push(t);
        pos.push(p / 1000);
        setpoint.push(Number.isFinite(sp) ? sp / 1000 : NaN);
      }
    }
    // A header-only CSV is a failed recording, and it must LOOK like one.
    // Returning {time: [], pos: []} here let every truthiness guard pass and
    // pushed the failure into whichever assertion happened to trip first on
    // empty arrays — or, worse, into none: Math.max(...[]) is -Infinity, and
    // G-limit's "stayed under the limit" check is satisfied by -Infinity, so
    // it reported PASS on CI while the device was returning zero bytes.
    if (pos.length === 0) return null;
    return { time, pos, setpoint };
  });
}

/** SIL plant: 2048-line encoder × 4× quadrature. Position_um in the CSV is this encoder. */
const SIL_ENCODER_STEPS_PER_MM = 4 * 2048;

/** dev_servo's positionDeadband (8 counts) in micrometres — a commanded
 *  position is reached inside 1 um. */
const DEADBAND_UM = (8 / SIL_ENCODER_STEPS_PER_MM) * 1000;

function assertFollowsSineUm(series, { amplitudeMm, frequencyHz, cycles, centreMm }, label) {
  // Start once the commanded profile has LEFT the peak. The approach parks on
  // the peak for hundreds of milliseconds, and a cosine fitted through that
  // plateau lands 180° out. End a tenth of a cycle before the return move.
  const spMm = series.setpoint.map((p) => p / 1000);
  const tS = series.time.map((t) => t / 1e6);
  const peak = Math.max(...spMm.filter(Number.isFinite));
  const trough = Math.min(...spMm.filter(Number.isFinite));
  const leftPeak = peak - 0.2 * (peak - trough);
  let i = 0;
  while (i < spMm.length && spMm[i] < peak - 0.05) i += 1;
  while (i < spMm.length && spMm[i] > leftPeak) i += 1;
  const tMinS = tS[Math.min(i, tS.length - 1)];
  const tMaxS = tMinS + cycles / frequencyHz - 0.5 / frequencyHz;
  const peakVelMmS = 2 * Math.PI * frequencyHz * amplitudeMm;
  assertFollowsSineWindowUm(series, {
    amplitudeMm,
    frequencyHz,
    centreMm,
    tMinS,
    tMaxS,
    label,
    followBoundUm: Math.max(CONTRACT_UM, 15 * peakVelMmS),
  });
}

/* What the recorded data must show for EVERY move type.
 *
 * Three claims, and they are deliberately different in kind:
 *
 * 1. RESOLUTION. The chain carries nanometres. A position column that only
 *    ever lands on multiples of 1000 nm is a micrometre column wearing a
 *    nanometre label -- which is exactly what it was until the record was
 *    widened, and the failure is silent.
 *
 * 2. THE SETPOINT IS THE TRAJECTORY. It must MOVE during the move. Until
 *    recently a linear move recorded its destination, so the column was a flat
 *    line through the middle of its own ramp and `position - setpoint` was
 *    remaining distance rather than tracking error.
 *
 * 3. SETTLED ACCURACY. Once the machine is at rest on a commanded position,
 *    the two agree to 1 um (the servo parks inside an 8-count deadband).
 *
 * Shape-follow while moving lives in assertFollowsLinearUm / assertFollowsSineUm:
 * after a fitted delay the commanded profile matches the request to 1 um.
 * Encoder-while-moving is not the same claim — the SIL plant is a first-order
 * lag, so a sine's amplitude droops and accel corners leave a residual a delay
 * cannot absorb. Linear cruise after that lag has settled is checked there.
 */
function assertRecordedMotion(series, { label, expectMotion = true, settledTolUm = CONTRACT_UM }) {
  assert(series && series.pos.length > 40, `${label}: enough samples (${series?.pos.length})`);
  const n = Math.min(series.pos.length, series.setpoint.length);
  assert(n > 40, `${label}: the setpoint column is populated (${n} rows)`);

  // 1. Resolution: the column must carry detail finer than a micrometre.
  let subMicron = 0;
  for (let i = 0; i < n; i++) {
    const nm = Math.round(series.pos[i] * 1000);
    if (nm % 1000 !== 0) subMicron += 1;
  }
  assert(
    subMicron > n / 20,
    `${label}: the position column carries sub-micron detail (only ${subMicron} of ${n} rows ` +
      `were not whole micrometres — a micrometre-quantised column would give 0)`,
  );

  // 2. The setpoint is the trajectory, not the destination.
  //
  // Counted as DISTINCT VALUES, not as a span. A destination-only setpoint
  // still jumps from one move to the next, so it spans the whole programme and
  // a range check passes it happily — while taking only a handful of values in
  // the entire run. A trajectory sweeps, so it takes hundreds.
  if (expectMotion) {
    const distinct = new Set();
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(series.setpoint[i])) distinct.add(Math.round(series.setpoint[i]));
    }
    assert(
      distinct.size > 50,
      `${label}: the recorded setpoint traces the move — it took ${distinct.size} distinct ` +
        `values over ${n} rows; a destination-only setpoint takes about one per move`,
    );
  }

  // 3. Settled: the last samples, where the machine is at rest.
  let rest = n - 1;
  let restCount = 0;
  while (rest > 1 && restCount < 20) {
    if (Math.abs(series.pos[rest] - series.pos[rest - 1]) > 0.5) break;
    rest -= 1;
    restCount += 1;
  }
  if (restCount >= 5 && Number.isFinite(series.setpoint[rest])) {
    const settled = Math.abs(series.pos[rest] - series.setpoint[rest]);
    assert(
      settled <= settledTolUm,
      `${label}: at rest the machine sits on its commanded position ` +
        `(off by ${settled.toFixed(2)} um, tol ${settledTolUm})`,
    );
  }
}
// Run the currently-selected profiles and wait for the run to auto-complete + download.
// Returns the run row locator. Assumes profiles are seeded + selected by the caller.
async function runAndDownload(page, { completeTimeout = RUN_WAIT_MS } = {}) {
  const runner = page.locator('.panel', { hasText: 'New Test' });
  await page.getByTestId('run-test').click();
  await runner.getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
  const row = page.locator('tbody tr').first();
  // A run the firmware abandons never gets a completed badge, so waiting for
  // one burns the whole budget and then reports "timeout" instead of the
  // reason. The firmware does say why, as a warning notification the app
  // surfaces as a toast — race the badge against it and fail immediately with
  // the board's own words.
  const abortToast = page.locator('.toast').getByText(/Test aborted/i).first();
  const completed = row.locator('.badge.completed').waitFor({ timeout: completeTimeout });
  const abortReason = abortToast.waitFor({ timeout: completeTimeout }).then(
    async () => `the firmware ended the run early: ${((await abortToast.textContent()) ?? '').trim()}`,
    // No abort inside the budget: let the completion wait decide the outcome.
    () => null,
  );
  const early = await Promise.race([completed.then(() => null), abortReason]);
  if (early) throw new Error(early);
  await completed;
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
    timeoutMs = T(90_000), // generous: bounds a hang, never paces a healthy move
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
async function ensureTestIdle(page, { graceMs = T(75_000), timeoutMs = T(150_000) } = {}) {
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

// Bring the Live screen to a KNOWN, idle, motion-enabled machine before any
// manual control is touched.
//
// Every step waits on device truth, and the order is the point:
//
//   1. State is KNOWN. The Motion badge renders '—' until the first state
//      frame arrives — unknown is no longer rendered as "disabled"/"idle" —
//      so this step cannot be satisfied by the app's ignorance. It used to
//      be: ensureTestIdle synchronised on the placeholder "Test: idle" of a
//      null state, D2 then jogged a machine that was still executing a 40 mm
//      move a predecessor left behind, and a 4 mm jog "landed" 37.231 mm away.
//   2. No test is running (ensureTestIdle stops one if a predecessor leaked
//      it, and throws if the machine will not go idle).
//   3. Motion is enabled.
//   4. The gantry is AT REST — a test going idle does not by itself mean the
//      axis has finished moving. Rest means still, not "on setpoint": a parked
//      machine can legitimately hold position away from a stale setpoint.
// Wait until the axis is simply NOT MOVING. Deliberately not |pos - setpoint|:
// at rest after boot or homing the machine can legitimately sit away from the
// last commanded setpoint (observed parked at 8.1 mm against a stale setpoint),
// and demanding arrival where no move was commanded turned a precondition into
// a 90 s timeout, nine scenarios over. Arrival-on-setpoint is settleMotion's
// job, and only meaningful directly after a commanded move.
async function awaitRest(page, { stillMm = 0.02, stableTicks = 4, pollMs = 250, timeoutMs = DEVICE_WAIT_MS } = {}) {
  const pos = async () =>
    parseFloat(await page.locator('.readout', { hasText: 'Machine Position' }).locator('.value').first().innerText());
  const deadline = Date.now() + timeoutMs;
  let last = NaN;
  let stable = 0;
  while (Date.now() < deadline) {
    const p = await pos();
    if (Number.isFinite(p) && Number.isFinite(last) && Math.abs(p - last) <= stillMm) {
      if (++stable >= stableTicks) return p;
    } else {
      stable = 0;
    }
    last = p;
    await page.waitForTimeout(pollMs);
  }
  throw new Error(`the axis never came to rest within ${timeoutMs}ms (last position ${last})`);
}

/** Status-bar `Responding` plus a firmware version: the session is up.
 *
 * One sample lights `Responding` for two seconds, so the badge alone is not
 * "the opening reads have finished". Starting a test while config / profile /
 * firmware-version still own the wire is the CI failure mode behind WAVE / TC11
 * / VT-linear: `proto/timeout`, then a CSV whose first second is idle.
 * `fw <version>` in the status bar is that handshake completing. */
async function awaitResponding(page, { timeoutMs = DEVICE_WAIT_MS } = {}) {
  const resp = page.getByTestId('responding');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = (await resp.textContent()) || '';
    if (t.includes('Responding') && !t.includes('Not')) break;
    await page.waitForTimeout(150);
  }
  const left = deadline - Date.now();
  if (left <= 0) throw new Error('device never started responding (no sample stream)');
  try {
    await page.locator('.statusbar').getByText(/fw /).waitFor({ timeout: left });
  } catch {
    throw new Error('device responded but the opening handshake never published a firmware version');
  }
}

async function readoutNum(page, label) {
  return parseFloat(
    await page.locator('.readout', { hasText: label }).locator('.value').first().innerText(),
  );
}

async function awaitReadoutNear(page, label, target, { eps = 1, timeoutMs = DEVICE_WAIT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = NaN;
  while (Date.now() < deadline) {
    last = await readoutNum(page, label);
    if (Number.isFinite(last) && Math.abs(last - target) <= eps) return last;
    await page.waitForTimeout(120);
  }
  throw new Error(`${label} never reached ${target}±${eps} (last ${last})`);
}

/**
 * Reconnect after `__silDropLink()`. The bridge can still hold the PTY for a
 * beat of wall time; retry the click until `.dot.connected` lands rather than
 * sleeping a guessed 1.2 s.
 */
async function clickReconnect(page, { timeoutMs = DEVICE_WAIT_MS } = {}) {
  const btn = page.getByTestId('reconnect');
  await btn.waitFor({ timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator('.dot.connected').count()) return;
    try {
      await btn.click({ timeout: T(2000) });
    } catch {
      /* button not ready, or a previous click already started the session */
    }
    try {
      await page.locator('.dot.connected').waitFor({ timeout: T(2000) });
      return;
    } catch {
      /* PTY still held — retry */
    }
  }
  throw new Error('reconnect never restored .dot.connected');
}

async function prepareManualControl(page) {
  await page.goto(`${APP_URL}#/live`);
  await page.getByRole('button', { name: /Home/ }).waitFor({ timeout: DEVICE_WAIT_MS });
  await page.getByText(/Motion: (enabled|disabled)/).waitFor({ timeout: DEVICE_WAIT_MS });
  await ensureTestIdle(page);
  const enable = page.getByRole('button', { name: 'Enable motion' });
  if (await enable.count()) await enable.click();
  await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });
  await awaitRest(page);
}

// Return the gantry to absolute machine zero and re-zero the gauge length.
// The emulator is long-lived and shared by every scenario (and every suite
// run): without this, machine position — and therefore real sample tension —
// accumulates until moves get restricted. The sample is anchored at the
// gantry's boot position with 15 mm of physical slack above it
// (embsim gantry.rs baseline), so machine 0 is the only safe starting point.
async function zeroLength(page) {
  await prepareManualControl(page);
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
  if (!Number.isFinite(p) || Math.abs(p) > 0.5) {
    throw new Error(`zeroLength: gantry never reached machine 0 (got ${p})`);
  }
  await page.getByRole('button', { name: 'Zero length' }).click();
  await awaitReadoutNear(page, 'Sample Position', 0, { eps: 1 });
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
    // The column is NANOMETRES; report micrometres (fractional) so every
    // downstream /1000-to-mm and µm threshold keeps working unchanged.
    const pi = lines[0].split(',').indexOf('position_nm');
    const pos = lines
      .slice(1)
      .map((l) => Number(l.split(',')[pi]) / 1000)
      .filter(Number.isFinite);
    if (pos.length === 0) return null; // header-only CSV = failed recording — see readDownloadedCsvSeries
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
        await page.goto(APP_URL_HOST);
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
        await awaitResponding(page);
        const forceText = (await page.locator('.readout', { hasText: 'Machine Force' }).locator('.value').textContent())?.trim() || '';
        assert(/^-?\d/.test(forceText), `live readout never populated (got ${forceText})`);
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
        await boardGrantedPort(page).click();
        await page.locator('.dot.connected').waitFor({ timeout: DEVICE_WAIT_MS });
        // B4: responding indicator turns to "Responding" once samples flow.
        await awaitResponding(page);
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
        const csvRows = ['time_us,force_mN,position_nm,setpoint_nm'];
        for (let i = 0; i <= 50; i++) {
          const t = i * 100000; // 0.1 s steps (µs)
          const force = i * 8000; // 0..400 N (mN)
          const pos = 10000000 + i * 40000; // 10..12 mm (nm)
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
          await write('E2EEXP.csv', 'time_us,force_mN,position_nm,setpoint_nm\n0,0,0,0\n');
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
        const settledValue = async (loc, { ticks = 3, pollMs = 200, timeoutMs = T(20000) } = {}) => {
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
        // Wait for the state to be KNOWN before reading the toggle: while it is
        // unknown the button says 'Motion …' and is disabled, so counting for
        // 'Enable motion' too early would skip the click and this scenario
        // would then wait forever for a transition nobody requested.
        await page.getByText(/Motion: (enabled|disabled)/).waitFor({ timeout: DEVICE_WAIT_MS });
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
        const nameField = fieldInput(motionPanel, 'Name').first();
        const importDeadline = Date.now() + DEVICE_WAIT_MS;
        let nameVal = '';
        while (Date.now() < importDeadline) {
          nameVal = await nameField.inputValue();
          if (nameVal === 'Imported-MP') break;
          await page.waitForTimeout(100);
        }
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
        await awaitResponding(page);
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
        assert(stats, 'the downloaded CSV contains data — empty means the device recorded nothing, or the download returned zero bytes');
        assert(stats.header === 'time_us,force_mN,position_nm,setpoint_nm', `CSV header: ${stats.header}`);
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
        await awaitResponding(page);
        // Zero the gauge length so sample displacement starts at 0 — prior scenarios
        // may leave the gantry past the 8 mm limit, which would trip the limit instantly
        // (sub-1 s test → the 1 s testRunning poll misses it → no completion detected).
        await page.goto(`${APP_URL}#/live`);
        await page.getByRole('button', { name: 'Zero length' }).click();
        await awaitReadoutNear(page, 'Sample Position', 0, { eps: 1 });
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
        assert(stats, 'the downloaded CSV contains data — empty means the device recorded nothing, or the download returned zero bytes');
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
        await awaitResponding(page);
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
        const pathMm = resampledPathMm(s.time, s.pos);
        assert(pathMm > 35 && pathMm < 50, `total path ~42mm (2 sets + executions); got ${pathMm.toFixed(1)}mm`);
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  // M13 — MANUAL moves, checked in the LIVE stream.
  //
  // A jog and a home go through MSG_WRITE_MANUAL_MOVE, so they never enter a
  // recorded test and no downloaded CSV can carry them. The live sample stream
  // is the only source, and it is ungated in firmware (ProtoEmb_onRead_sample
  // has no test-running check), so it runs whenever the device is connected.
  //
  // Read through `globalThis.__madLive`, not the DOM: the on-screen readout is
  // `value.toFixed(3)` in millimetres — one micrometre — which would throw away
  // the three digits this whole exercise was about.
  {
    id: 'M13-jog-endpoint',
    name: 'M13 manual jog lands on its commanded position (live stream)',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        await page.getByRole('button', { name: /Home/ }).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.getByText(/Motion: (enabled|disabled)/).waitFor({ timeout: DEVICE_WAIT_MS });
        const enableBtn = page.getByRole('button', { name: 'Enable motion' });
        if (await enableBtn.count()) await enableBtn.click();
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });

        const live = () => page.evaluate(() => globalThis.__madLive?.latest() ?? null);
        assert(await live(), 'the live sample ring is exposed (dev build)');

        await page.getByLabel('Jog (mm)').fill('2');
        await page.getByLabel('Speed (mm/s)').fill('5');
        const before = await live();
        await page.getByRole('button', { name: '+ Jog up' }).click();
        // Sample the ring WHILE the carriage moves. One reading at rest proves
        // nothing: a stream quantised to micrometres still lands off a whole
        // micrometre 0 times in 1000, but a single nanometre reading lands on
        // one 1 time in 1000 by luck, so a lone sample cannot tell the two
        // apart. A run of them can.
        const nmDuringMove = await page.evaluate(async (durMs) => {
          const out = [];
          const t0 = performance.now();
          while (performance.now() - t0 < durMs) {
            const s = globalThis.__madLive?.latest();
            if (s && Number.isFinite(s.machinePosition)) {
              out.push(Math.round(s.machinePosition * 1e6));
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          return out;
        }, 700);
        await awaitRest(page);
        const after = await live();

        const movedMm = after.machinePosition - before.machinePosition;
        assert(Math.abs(movedMm - 2) < 0.3, `jogged 2 mm (moved ${movedMm.toFixed(4)} mm)`);

        // The live stream carries SUB-MICRON detail. A DOM scrape would land on
        // a whole micrometre every time; the wire carries nanometres. This is
        // the live twin of the CSV column check in assertRecordedMotion -- the
        // recorded path would fail 17 scenarios if the wire went back to
        // micrometres, and until now the live path would have failed none,
        // though M8, M9, M13, D2 and TC14 all measure accuracy with it.
        const nm = Math.round(after.machinePosition * 1e6);
        // Just "it moved". The real claim is the sub-micron one below; this
        // only guards against asserting resolution on a stream that never
        // advanced. Five was an arbitrary choice made against the cosim, and
        // the bridge delivers fewer distinct positions for the same jog (3 in
        // 70 samples) because its plant and sampling differ -- a number tuned
        // on one configuration should not fail the other.
        const distinct = new Set(nmDuringMove).size;
        assert(
          distinct >= 2,
          `the live ring advanced during the jog (${distinct} distinct positions in ${nmDuringMove.length} samples)`,
        );
        const subMicron = nmDuringMove.filter((v) => v % 1000 !== 0).length;
        assert(
          subMicron > nmDuringMove.length / 20,
          `the live position carries sub-micron detail (only ${subMicron} of ` +
            `${nmDuringMove.length} samples were off a whole micrometre)`,
        );

        // Endpoint accuracy. The servo parks as soon as it is inside
        // positionDeadband (8 counts = 0.977 um) and stops correcting there,
        // so a commanded move lands one deadband out BY CONSTRUCTION.
        // Sub-micron is the RESOLUTION of the reading; 1 um is the accuracy
        // of the stop. The two are separate claims.
        const offUm = Math.abs(after.machinePosition - after.machineSetpoint) * 1000;
        assert(offUm <= DEADBAND_UM * 1.5, `parked within the servo's deadband (off by ${offUm.toFixed(2)} um, deadband ${DEADBAND_UM})`);
        console.log(`    [manual] jog: moved ${movedMm.toFixed(4)} mm, parked ${offUm.toFixed(2)} um from setpoint, position ${nm} nm`);

        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },
  {
    id: 'M13-home-endpoint',
    name: 'M13 homing lands on its commanded position (live stream)',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        await page.getByRole('button', { name: /Home/ }).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.getByText(/Motion: (enabled|disabled)/).waitFor({ timeout: DEVICE_WAIT_MS });
        const enableBtn = page.getByRole('button', { name: 'Enable motion' });
        if (await enableBtn.count()) await enableBtn.click();
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });

        const live = () => page.evaluate(() => globalThis.__madLive?.latest() ?? null);
        const before = await live();
        assert(before, 'the live sample ring is exposed (dev build)');
        await page.getByRole('button', { name: 'Home (G28)' }).click();

        // Wait for the seek to actually START before waiting for it to finish.
        // awaitRest on its own returns immediately: the axis is still at rest
        // from before the click, which reads as "settled" and hands back the
        // pre-home position — 87 mm from where homing ends.
        const moveDeadline = Date.now() + DEVICE_WAIT_MS;
        let moving = false;
        while (Date.now() < moveDeadline) {
          const now = await live();
          if (now && Math.abs(now.machinePosition - before.machinePosition) > 10) { moving = true; break; }
          await page.waitForTimeout(100);
        }
        assert(moving, 'homing started moving the axis');
        // Home's setpoint jumps to machine 0 immediately, so "position equals
        // setpoint" is reached long before the gantry stops -- and an exit
        // condition of "within X" makes any later assertion of "within X"
        // vacuous, because the loop can only leave by satisfying it. Waiting
        // for STILLNESS instead keeps the wait and the claim independent: the
        // carriage has to stop moving, and only then is asked where it
        // stopped. It also makes the reported number mean something. The old
        // loop exited on the first sample inside 150 um and reported whatever
        // that happened to be (64 um on CI) -- a fact about the poll interval,
        // not about homing.
        // Two stages, because neither alone is enough. Stillness on its own
        // fires DURING homing: HOME_ENDSTOP calls actuator_stop() and dwells
        // on a timer before backing off, so the carriage genuinely stops on
        // the endstop with the setpoint still 87 mm away. And convergence on
        // its own is what made the old check vacuous -- it exited on "within
        // X" and then asserted "within X".
        //
        // So: wait for a LOOSE convergence to get past the endstop dwell,
        // then wait for stillness, then assert a TIGHT bound. The wait
        // threshold (0.5 mm) and the claim (~1.5 um) are 340x apart, so the
        // assertion can fail without the wait having timed out.
        const settleDeadline = Date.now() + RUN_WAIT_MS;
        let after = null;
        let converged = false;
        let prevMm = NaN;
        let stillTicks = 0;
        while (Date.now() < settleDeadline) {
          after = await live();
          if (after && Number.isFinite(after.machinePosition) && Number.isFinite(after.machineSetpoint)) {
            if (!converged && Math.abs(after.machinePosition - after.machineSetpoint) < 0.5) {
              converged = true;
            }
            if (converged) {
              if (Number.isFinite(prevMm) && Math.abs(after.machinePosition - prevMm) <= 0.001) {
                if (++stillTicks >= 4) break;
              } else {
                stillTicks = 0;
              }
              prevMm = after.machinePosition;
            }
          }
          await page.waitForTimeout(100);
        }
        assert(after, 'the live stream reported a sample after homing');
        assert(converged, 'homing brought the gantry onto its setpoint');
        assert(stillTicks >= 4, 'the axis came to rest after homing');
        // Homing ends with an ordinary profiled backoff move and app_motion
        // only leaves HOME_BACKOFF on atTarget -- the servo's own "encoder
        // settled on target", inside positionDeadband -- so on the ISS it
        // lands exactly as a jog does: measured 0.98 um, against the same
        // bound M13-jog-endpoint uses.
        //
        // The bridge's plant is a different machine: a 20 ms first-order
        // velocity lag with a 15 percent viscous loss (SIL/MaDSim/src/
        // wiring.rs), sampled by DOM polling rather than the live ring. It
        // settles 201 um out on the same sequence. Both numbers are true of
        // their own configuration, so the bound is per-configuration -- one
        // number would have to be false somewhere.
        //
        // What is asserted identically in both: the wait is for STILLNESS,
        // not for the bound. That is what stops this being the tautology it
        // was, where the loop exited on "within X" and then checked "within
        // X" and could only fail by timing out.
        const offUm = Math.abs(after.machinePosition - after.machineSetpoint) * 1000;
        const homeTolUm = CDP_URL ? DEADBAND_UM * 1.5 : 400;
        assert(
          offUm <= homeTolUm,
          `homing parked on its setpoint (off by ${offUm.toFixed(2)} um, tolerance ${homeTolUm.toFixed(2)} um` +
            `${CDP_URL ? `, deadband ${DEADBAND_UM}` : ' — bridge plant lag'})`,
        );
        console.log(`    [manual] home: parked ${offUm.toFixed(2)} um from setpoint at ${(after.machinePosition * 1e6).toFixed(0)} nm`);

        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  },

  // M12 — every move type a motion PROFILE can author, checked in the data that
  // comes back. Note what is NOT here: G0 rapid and G28 homing go through
  // MSG_WRITE_MANUAL_MOVE (DeviceSession.worker.ts) and can never appear inside
  // a recorded test, so no downloaded CSV can carry them. "Every move type"
  // genuinely splits into profile moves, which are recorded, and manual moves,
  // which are not.
  //
  // Linear cells come from the catalog: each one is delay-aligned to the
  // trapezoid of the request and held to 1 um (arrival + profile follow).
  ...MATRIX.M12_linear_um.map((cell) => ({
    id: cell.id,
    name: `M12 recorded motion — ${cell.label}`,
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await awaitResponding(page);
        await zeroLength(page);
        if (cell.setupJogMm) {
          await page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input')
            .fill(String(Math.abs(cell.setupJogMm)));
          await page.locator('label.field', { hasText: 'Speed (mm/s)' }).locator('input').fill('20');
          const setWas = parseFloat(
            await page.locator('.readout', { hasText: 'Machine Setpoint' }).locator('.value').first().innerText(),
          );
          await page.getByRole('button', {
            name: cell.setupJogMm > 0 ? '+ Jog up' : '− Jog down',
          }).click();
          await settleMotion(page, { setpointWas: Number.isFinite(setWas) ? setWas : null });
        }
        const maxDisp = cell.maxDisplacement
          ?? Math.max(40, Math.abs(cell.distanceMm ?? cell.targetMm ?? 0) + Math.abs(cell.setupJogMm ?? 0) + 10);
        const moves = cell.absolute
          ? [{ moveType: 'linear', absoluteOrRelative: 'absolute',
               moveParameters: { position: cell.targetMm, velocity: cell.velocityMmS, distance: 0, time: 0 } }]
          : [{ moveType: 'linear', absoluteOrRelative: 'relative',
               moveParameters: { position: 0, velocity: cell.velocityMmS, distance: cell.distanceMm, time: 0 } }];
        await seedProfiles(page, {
          sample: { serial: `Rec-${cell.id}`, maxForce: 500, maxVelocity: 60, maxDisplacement: maxDisp,
                    sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: cell.id, moves },
        });
        await selectSeeded(page);
        await runAndDownload(page);
        const s = await readDownloadedCsvSeries(page);
        assertRecordedMotion(s, { label: cell.id });
        assertFollowsLinearUm(s, {
          velocityMmS: cell.velocityMmS,
          distanceMm: cell.distanceMm,
          targetMm: cell.absolute ? cell.targetMm : undefined,
          label: cell.id,
        });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  })),
  ...[
    {
      id: 'M12-dwell',
      label: 'linear then dwell then linear',
      expectMotion: true,
      moves: [
        { moveType: 'linear', absoluteOrRelative: 'absolute',
          moveParameters: { position: 5, velocity: 5, distance: 0, time: 0 } },
        { moveType: 'dwell', absoluteOrRelative: 'absolute',
          moveParameters: { position: 0, velocity: 0, distance: 0, time: 400 } },
        { moveType: 'linear', absoluteOrRelative: 'absolute',
          moveParameters: { position: 9, velocity: 5, distance: 0, time: 0 } },
      ],
    },
    {
      id: 'M12-wave-hold',
      label: 'waveform holding at peak tension only',
      moves: [{ moveType: 'math', absoluteOrRelative: 'relative',
                moveParameters: { position: 0, velocity: 0, distance: 6, time: 0,
                                  waveform: 'sine', amplitude: 4, frequency: 0.5, cycles: 2,
                                  dwellHigh: 0.6, dwellLow: 0 } }],
    },
    {
      id: 'M12-wave-skew',
      label: 'waveform loading slower than it unloads',
      moves: [{ moveType: 'math', absoluteOrRelative: 'relative',
                moveParameters: { position: 0, velocity: 0, distance: 6, time: 0,
                                  waveform: 'sine', amplitude: 4, frequency: 0.5, cycles: 2,
                                  skew: 0.75 } }],
    },
  ].map((mv) => ({
    id: mv.id,
    name: `M12 recorded motion — ${mv.label}`,
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await awaitResponding(page);
        await zeroLength(page);
        await seedProfiles(page, {
          sample: { serial: `Rec-${mv.id}`, maxForce: 500, maxVelocity: 60, maxDisplacement: 40,
                    sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: mv.id, moves: mv.moves },
        });
        await selectSeeded(page);
        await runAndDownload(page);
        const s = await readDownloadedCsvSeries(page);
        assertRecordedMotion(s, { label: mv.id });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally { await browser.close(); }
    },
  })),

  // M10 — firmware-native G123 waveform matrix (sine + triangle from catalog).
  ...MATRIX.M10_waveform.map((wf) => ({
    id: wf.id,
    name: `M10 waveform G123 — ${wf.shape} (${wf.label})`,
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await awaitResponding(page);
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
        // Linear arrival is 1 um; a waveform's closing settle is a profiled
        // return from the peak, and the record's tail is teardown timing.
        assertRecordedMotion(s, { label: wf.id, settledTolUm: 5 });
        if (wf.shape === 'sine') {
          assertSineMatch(s, { amplitudeMm: wf.amplitude, frequencyHz: wf.frequency, cycles: wf.cycles, centreMm: wf.distance }, wf.id);
          assertFollowsSineUm(s, { amplitudeMm: wf.amplitude, frequencyHz: wf.frequency, cycles: wf.cycles, centreMm: wf.distance }, wf.id);
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
        await awaitResponding(page);
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
        await awaitResponding(page);
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
        await awaitResponding(page);
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
        const t0 = motionStartTimeUs(s.time, s.pos);
        assert(t0 != null, 'motion start is visible on the virtual clock');
        const p0 = interpolateAtUs(s.time, s.pos, t0);
        assert(p0 != null, 'position at motion start');
        // At t0+1s and t0+2s the displacement should be ~V*t (within tolerance).
        // Clock from motion start, not the first logged sample: logging begins
        // when testRunning goes true, which is before the axis moves.
        const at = (targetS) => {
          const um = interpolateAtUs(s.time, s.pos, t0 + targetS * 1e6);
          assert(um != null, `series covers t0+${targetS}s`);
          return (um - p0) / 1000;
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
        await awaitResponding(page);
        await zeroLength(page);
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
        await prepareManualControl(page);
        const posValue = () => page.locator('.readout', { hasText: 'Machine Position' }).locator('.value').first().innerText();
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
        await prepareManualControl(page);
        const num = async (label) =>
          parseFloat(await page.locator('.readout', { hasText: label }).locator('.value').first().innerText());
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
        await awaitResponding(page);
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
        await awaitResponding(page);
        // Sever the link (simulates USB unplug / emulator death).
        await dropLink(page);
        await page.locator('.dot.disconnected').waitFor({ timeout: DEVICE_WAIT_MS });
        await page.locator('.toast').getByText(/disconnected/i).first().waitFor({ timeout: DEVICE_WAIT_MS });
        await clickReconnect(page);
        await awaitResponding(page);
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
        await awaitResponding(page);
        await dropLink(page);
        await page.locator('.dot.disconnected').waitFor({ timeout: DEVICE_WAIT_MS });
        await clickReconnect(page);
        await awaitResponding(page);
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
        await awaitResponding(page);
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
        await dropLink(page);
        await page.locator('.dot.disconnected').waitFor({ timeout: DEVICE_WAIT_MS });
        await clickReconnect(page);
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
        await prepareManualControl(page);
        const num = async (label) =>
          parseFloat(await page.locator('.readout', { hasText: label }).locator('.value').first().innerText());
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
        await awaitReadoutNear(page, 'Sample Force', 0, { eps: 1 });
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
        await awaitReadoutNear(page, 'Sample Force', 0, { eps: 1 });
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
        await awaitResponding(page);
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
          const si = lines[0].split(',').indexOf('setpoint_nm');
          const set = lines
            .slice(1)
            .map((l) => Number(l.split(',')[si]) / 1000)
            .filter(Number.isFinite);
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
        await awaitResponding(page);
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
        await awaitResponding(page);
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
        await page.getByText('Test: running').waitFor({ timeout: T(20000) });
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
        await awaitResponding(page);
        await zeroLength(page);
        // Idle baseline: jog enabled.
        await prepareManualControl(page);
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

        await page.goto(`${APP_URL_HOST}#/firmware`);
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
          .waitFor({ timeout: T(30000) });

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

        await page.goto(`${APP_URL_HOST}#/firmware`);
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

        await page.goto(`${APP_URL_HOST}#/firmware`);
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
        await page.goto(`${APP_URL_HOST}#/firmware`);
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

        await page.goto(`${APP_URL_HOST}#/firmware`);
        await page.getByTestId('flash-target').filter({ hasText: /USB/ }).waitFor();
        await page.getByTestId('firmware-file').setInputFiles({
          name: 'program', mimeType: 'application/octet-stream', buffer: Buffer.alloc(4096),
        });
        await page.getByTestId('flash-firmware').click();

        await page.getByTestId('flash-status').filter({ hasText: /Uploading… \d+%/ }).waitFor({ timeout: T(20000) });
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
        await page.goto(`${APP_URL_HOST}#/firmware`);
        await page.getByTestId('flash-target').filter({ hasText: /No serial device yet/i }).waitFor();
        assert(await page.getByTestId('flash-firmware').isDisabled(), 'armed with no port');
        await browser.close();

        // A getPorts() that rejects must not break the screen either.
        const b2 = await chromium.launch({ channel: 'chrome', headless: true });
        const p2 = await b2.newPage();
        p2.on('pageerror', (e) => errors.push(e.message));
        await p2.addInitScript(installFakeBootRom, { getPortsFails: true });
        await p2.addInitScript(installOpfsDataDir, OPFS_DIR);
        await p2.goto(`${APP_URL_HOST}#/firmware`);
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

        await page.goto(`${APP_URL_HOST}#/firmware`);
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

        await page.goto(`${APP_URL_HOST}#/firmware`);
        await page.getByTestId('firmware-file').setInputFiles({
          name: 'program.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from([1, 2, 3, 4]),
        });
        await page.getByTestId('flash-firmware').click();
        await page.getByTestId('flash-status').filter({ hasText: /No response from the Propeller 2/ })
          .waitFor({ timeout: T(30000) });
      } finally { await browser.close(); }
    },
  },
];

async function main() {
  // Fail fast with guidance if the dev server isn't up.
  try {
    const res = await fetch(APP_URL_HOST);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(
      `✗ App not reachable at ${APP_URL_HOST}. Start: ${
        CDP_URL
          ? 'npm run dev -- --host (and make playground-cosim)'
          : 'npm run dev (and make e2e-emulator + npm run sil:bridge)'
      }.`,
    );
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
  // Three scenarios sever the link mid-test to prove the app's reconnect path.
  // They used to be skipped in computer-node mode -- they did it through
  // `window.__silDropLink()`, which the fake serial installs, and a real port
  // has nothing to reach in and sever. They now go through fixtures'
  // dropLink(), which unplugs the board's emulated FTDI for a few seconds and
  // plugs it back: a genuine USB detach that the guest kernel and Chrome both
  // see. Both configurations run all of them, so nothing is skipped here.
  const skipped = 0;
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
      // Leave the machine idle for the next scenario. Without this one hung run
      // cascades: the firmware keeps reporting testRunning, the app keeps the
      // jog and speed controls gated, and every later scenario fails on a
      // disabled field rather than on whatever it was testing.
      // eslint-disable-next-line no-await-in-loop
      await recoverMachine().catch(() => {});
    }
    // Settle: let the previous client fully release the serial before the next
    // connects (only one app may hold the stream at a time).
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, T(800)));
  }

  console.log(`\n${pass}/${selected.length - skipped} scenarios passed${skipped ? `, ${skipped} skipped` : ''}${only ? ' (filtered)' : ''}`);
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
