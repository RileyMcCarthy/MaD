/**
 * E2E parity suite runner.
 *
 * Drives the real app against the board and an OPFS data folder — see
 * fixtures.mjs and docs/TEST_PLAN.md.
 *
 * ONE configuration touches the board: the shipped P2 image interpreted by
 * the ISS, with the app in the host's Chrome held to the board's clock by
 * embsim's `chrome-cdp` node. Every page and dedicated worker lives the
 * board's time, a 1 ms quantum at a time over DevTools, and the page's Web
 * Serial port is the node's, on the board's protocol pins. The browser
 * cannot outrun the board, because it lives only the time the board grants
 * it. The board is the machine's project, SIL/mad-cosim.toml, under `embsim
 * run` (embsim MIGRATING-MAD.md step 10): the Edge carrier and the P2-EC32MB
 * module as drawn, the production firmware booted off the module's flash,
 * and the node on the carrier's debug header J1, where the machine's Prop
 * Plug sits (USB 0403:6015). Locally:
 *   cd SIL && make e2e-emulator          # prints "DevTools at http://127.0.0.1:9222"
 *   npm run dev                          # the app, on the host
 *   CDP_URL=http://127.0.0.1:9222 npm run e2e
 * (`make e2e` in SIL/ does all three and stops what it started.)
 *
 * Every budget on that route is board time: a locator's `waitFor` timeout,
 * `waitPageTime()` and `pageClock()` all count the page's clock, which is the
 * board's. Nothing in the suite asserts on host time. The board runs at a few
 * percent of real time, so a healthy scenario costs minutes of host time; a
 * budget bounds a hang, it never paces a passing run.
 *
 * The three link-drop scenarios (B5-reconnect, M11-idle-drop,
 * M11-mid-test-drop) pull the node's cable (`__embsim.link`): the port's
 * streams error with NetworkError, `disconnect` fires, and on the plug the
 * port returns as a new SerialPort with `connect`, which the app answers by
 * reconnecting to the port whose USB ids (0403:6015) it remembers.
 *
 * What the project as drawn cannot do, the suite skips there, saying why
 * (`PROJECT_CANNOT`, below): the carriage never moves, since the isolator
 * IC14 between the processor and the drive has its secondary grounds on a
 * net of their own (SIL/mad-catalog/tests/mad.rs, "The drive"), and the
 * project's machine has no jam. Until IC14 is settled those scenarios run
 * on `mad-emulator --chrome` (the playgrounds' board): `cd SIL && make
 * e2e-motion` takes them from `--list --cannot` and runs them with
 * BOARD_ROUTE=emulator. `E2E_BOARD_ROUTE=emulator` attaches the suite there
 * by hand, where SERVO-stall jams the carriage by creating E2E_JAM_FILE, the
 * file mad-emulator watches (`--jam-file`); board-route.sh sets both.
 *
 * Without CDP_URL only the board-free scenarios run: A1 and
 * FW1/2/3/5/6/7/8/9 launch a host Chrome against in-page fakes and need no
 * emulator at all, which is what ci.yml's per-PR `control-e2e-boardless` job
 * runs:
 *   npm run dev
 *   SCENARIOS=A1,FW1,FW2,FW3,FW5,FW6,FW7,FW8,FW9 npm run e2e
 * Naming a board scenario without CDP_URL is refused.
 *
 * FW-ISS (the app flashing the ISS's mask ROM) needs the ROM board, not the
 * firmware's: `mad-emulator --boot-rom --chrome` (`cd SIL && make e2e-rom`,
 * which sets E2E_BOARD=rom and E2E_BOARD_ROUTE=emulator). On that board it
 * is the only scenario that runs; on the firmware's it is skipped.
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
  BOARD,
  CDP_URL,
  boardGrantedPort,
  chromium,
  press,
  pageClock,
  waitPageTime,
  restoreLink,
  takePageTime,
  BOARD_ROUTE,
  DEVICE_WAIT_MS,
  awaitResponding,
} from './fixtures.mjs';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// The scenarios that never touch the board: they launch a host Chrome
// against in-page fakes (the capability gate, and the flasher against a fake
// boot ROM), so they run without an emulator.
const BOARD_FREE = new Set(['A1', 'FW1', 'FW2', 'FW3', 'FW5', 'FW6', 'FW7', 'FW8', 'FW9']);

// The board is the mask ROM, not the firmware: `mad-emulator --boot-rom
// --chrome` (make e2e-rom). Only FW-ISS, the app flashing that ROM, runs.
const ROM_BOARD = process.env.E2E_BOARD === 'rom';

// The scenarios that command the carriage to move: a jog, a home, or a test
// profile with a linear or waveform move. Each asserts on that motion, or on
// a test that runs while the carriage follows its setpoint.
const MOVES = new Set([
  'G2+G3+H2+I', 'G-limit', 'TC1-multiset', 'M13-jog-endpoint', 'M13-home-endpoint',
  ...MATRIX.M12_linear_um.map((cell) => cell.id), 'M12-dwell', 'M12-wave-hold', 'M12-wave-skew',
  ...MATRIX.M10_waveform.map((wf) => wf.id), 'TC4-dwell', 'TC6-disable-stops', 'TC11-velocity',
  'VT-linear', 'TC14-jog', ...MATRIX.M8_jog.map((cell) => cell.id), 'M11-mid-test-drop',
  'D2-settled-jog', 'D3+SR-slack', ...MATRIX.M9_force_slack.map((cell) => cell.id),
  'P1-precision', 'BB-back-to-back', 'TM-busy-restart', 'TM-manual-gate', 'SERVO-stall',
]);

// What the machine's project as drawn cannot do (BOARD_ROUTE 'project':
// SIL/mad-cosim.toml), each with why. The suite skips these there, named in
// SCENARIOS or not, saying so; a run in which every scenario was skipped
// fails, since it checked nothing. E2E_PROJECT_CANNOT=run runs them anyway,
// for a change to the board, its file or the kinds that may lift the
// reason. `--list --cannot` lists them, and `make e2e-motion` runs them on
// mad-emulator's board meanwhile, so the motion coverage stays.
//
// The carriage: IC14, the isolator between the processor and the drive, has
// its secondary ground pins (9, 15) on a net of their own with only C26 on
// it, so nothing it drives reaches the drive's STEP, DIR and ENA (read:
// Hardware/EdgeBoard/KiCad; SIL/mad-catalog/tests/mad.rs, "The drive"). The
// run's summary says "0 steps commanded" with the encoder at 0 counts, and
// the firmware latches SERVO_STALL at the first move it commands
// (measured, G2+G3+H2+I on mad-cosim.toml). Whether the machine's carrier is
// bodged there is not known; the file keeps the board as drawn.
const IC14_WHY =
  'needs the carriage to move: IC14 as drawn passes nothing to the drive (SIL/mad-catalog/tests/mad.rs, "The drive")';
const PROJECT_CANNOT = new Map([...MOVES].map((id) => [id, IC14_WHY]));
// The project's machine has no jam: a lever a stepped kind cannot take from
// a file the wall clock polls (mad-catalog/src/machine.rs, "Not modelled").
PROJECT_CANNOT.set('SERVO-stall', `jams the carriage, which the project's machine cannot (SIL/mad-catalog/src/machine.rs, "Not modelled"), and ${IC14_WHY}`);
const RUN_CANNOT = process.env.E2E_PROJECT_CANNOT === 'run';
// The suite is on the project: attached to its Chrome, or listing for
// board-route.sh, which names the route before any board is up.
const ON_PROJECT = BOARD_ROUTE === 'project' && (BOARD || process.env.E2E_BOARD_ROUTE === 'project');
/** Why `id` cannot run on this board, or '' when it can. */
const cannot = (id) => (ON_PROJECT && !RUN_CANNOT && PROJECT_CANNOT.get(id)) || '';

// The app is the built bundle (board-route.sh with APP_DIST sets this), not
// the dev server. BUNDLE-live runs only then; every other scenario runs on
// either.
const APP_IS_BUNDLE = process.env.E2E_APP === 'bundle';

// Budget for a whole TEST PROGRAM: upload, execute every move, complete, and
// come to rest, or pull the recorded data back off the device. The longest
// profile here is 40 mm at 2 mm/s, 20 s of motion. Board time, as above.
const RUN_WAIT_MS = 120_000;

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

// What the History panel and the data folder say about the newest run, for
// a completion wait that ran out: a row stuck on "running" over a stored
// "completed" is the page's view going stale, a stored "running" is the
// completion never being written, and no row at all is the list itself
// lost. Read straight from the DOM and the folder, so a missing row cannot
// stall the description. Diagnostics must never fail a run.
async function describeNewestRun(page) {
  try {
    const seen = await page.evaluate(async (dirName) => {
      const panel = [...document.querySelectorAll('.panel')].find((p) => /History/.test(p.textContent ?? ''));
      const history = (panel?.innerText ?? '(no History panel)').replace(/\s+/g, ' ').trim().slice(0, 300);
      let folder;
      try {
        const root = await navigator.storage.getDirectory();
        const runs = await (await root.getDirectoryHandle(dirName)).getDirectoryHandle('testRuns');
        const read = async (name) => {
          try {
            return await (await (await runs.getFileHandle(name)).getFile()).text();
          } catch (e) {
            return `(${e.name})`;
          }
        };
        const status = (text) => {
          try {
            const v = JSON.parse(text);
            return JSON.stringify(Array.isArray(v) ? v.map((r) => [r.testName, r.status]) : [v.testName, v.status]);
          } catch {
            return text.slice(0, 80);
          }
        };
        const names = [];
        for await (const [n] of runs.entries()) names.push(n);
        const newest = names.filter((n) => /^\d+\.json$/.test(n)).sort().pop();
        folder = `holds [${names.join(', ')}], index ${status(await read('index.json'))}, ` +
          `newest run ${newest ? status(await read(newest)) : '(none)'}`;
      } catch (e) {
        folder = `could not be read (${e?.name ?? e})`;
      }
      return { route: location.hash, rows: document.querySelectorAll('tbody tr').length, history, folder };
    }, OPFS_DIR);
    return `at ${seen.route} the History panel has ${seen.rows} row(s) and reads "${seen.history}"; ` +
      `the data folder ${seen.folder}`;
  } catch (err) {
    return `(could not describe the newest run: ${err?.message ?? err})`;
  }
}

// Run the currently-selected profiles and wait for the run to auto-complete + download.
// Returns the run row locator. Assumes profiles are seeded + selected by the caller.
async function runAndDownload(page, { completeTimeout = RUN_WAIT_MS } = {}) {
  const runner = page.locator('.panel', { hasText: 'New Test' });
  await press(page.getByTestId('run-test'));
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
  let early;
  try {
    early = await Promise.race([completed.then(() => null), abortReason]);
  } catch (err) {
    throw new Error(`${err.message}; ${await describeNewestRun(page)}`);
  }
  if (early) throw new Error(early);
  await completed;
  await press(row.getByRole('button', { name: /Download data/i }));
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
    timeoutMs = 45_000, // bounds a hang, never paces a healthy move
  } = opts;
  const num = async (label) =>
    parseFloat(await page.locator('.readout', { hasText: label }).locator('.value').first().innerText());

  // Every budget here is the page's time: the board's, on the board route.
  const clock = await pageClock(page);
  // Phase 1 — let the command land. Advisory: some moves legitimately leave the
  // setpoint unchanged, so a timeout here just falls through to phase 2.
  if (setpointWas !== null) {
    const cmdBudget = Math.min(timeoutMs, 10_000);
    while ((await clock.elapsed()) < cmdBudget) {
      const set = await num('Machine Setpoint');
      if (Number.isFinite(set) && Math.abs(set - setpointWas) > tolMm) break;
      await waitPageTime(page, pollMs);
    }
  }

  // Phase 2 — converge onto the setpoint and hold there.
  let stable = 0;
  let last = NaN;
  let pos = NaN;
  let set = NaN;
  while ((await clock.elapsed()) < timeoutMs) {
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
    await waitPageTime(page, pollMs);
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
async function ensureTestIdle(page, { graceMs = 25_000, timeoutMs = 50_000 } = {}) {
  const idle = page.getByText('Test: idle');
  const clock = await pageClock(page);
  // A run that is genuinely finishing should be allowed to finish on its own.
  // The longest move any scenario commands is 40 mm at 2 mm/s, 20 s of the
  // board's time, and the grace is counted on the page's clock (the board's),
  // so it covers that however slowly the host runs the board.
  try {
    await idle.waitFor({ timeout: Math.min(graceMs, timeoutMs) });
    return;
  } catch {
    /* still running — stop it below */
  }
  // Disabling motion ends the run; TC6-disable-stops covers that contract.
  const disable = page.getByRole('button', { name: 'Disable motion' });
  if (await disable.count()) {
    await press(disable);
  }
  // Outside the `if` on purpose. An earlier revision only waited when the
  // button happened to be present, so when it was not this returned having done
  // nothing at all — the caller then drove gated controls and failed 30 s later
  // with a locator timeout naming an input, which says nothing about the cause.
  // Either the machine reaches idle or this throws saying so.
  await idle.waitFor({ timeout: Math.max(20_000, timeoutMs - (await clock.elapsed())) });
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
  const clock = await pageClock(page);
  let last = NaN;
  let stable = 0;
  while ((await clock.elapsed()) < timeoutMs) {
    const p = await pos();
    if (Number.isFinite(p) && Number.isFinite(last) && Math.abs(p - last) <= stillMm) {
      if (++stable >= stableTicks) return p;
    } else {
      stable = 0;
    }
    last = p;
    await waitPageTime(page, pollMs);
  }
  throw new Error(`the axis never came to rest within ${timeoutMs}ms (last position ${last})`);
}

async function readoutNum(page, label) {
  return parseFloat(
    await page.locator('.readout', { hasText: label }).locator('.value').first().innerText(),
  );
}

async function awaitReadoutNear(page, label, target, { eps = 1, timeoutMs = DEVICE_WAIT_MS } = {}) {
  const clock = await pageClock(page);
  let last = NaN;
  while ((await clock.elapsed()) < timeoutMs) {
    last = await readoutNum(page, label);
    if (Number.isFinite(last) && Math.abs(last - target) <= eps) return last;
    await waitPageTime(page, 120);
  }
  throw new Error(`${label} never reached ${target}±${eps} (last ${last})`);
}

/**
 * Reconnect after `dropLink()`.
 *
 * Board route: the cable is still out, so put it back first. The port returns
 * as a new SerialPort and `connect` fires, and the app reconnects by itself
 * to the port with the USB ids it remembers; the Reconnect press below is the
 * user's fallback when it has not within a moment.
 *
 * Bridge: the port never left, so the press reconnects; retry it until
 * `.dot.connected` lands rather than sleeping a guessed 1.2 s.
 */
async function clickReconnect(page, { timeoutMs = DEVICE_WAIT_MS } = {}) {
  const btn = page.getByTestId('reconnect');
  await btn.waitFor({ timeout: timeoutMs });
  const clock = await pageClock(page);
  if (BOARD) {
    await restoreLink(page);
    try {
      await page.locator('.dot.connected').waitFor({ timeout: 2000 });
      return;
    } catch {
      /* not by itself: press Reconnect below */
    }
  }
  while ((await clock.elapsed()) < timeoutMs) {
    if (await page.locator('.dot.connected').count()) return;
    try {
      await press(btn, { timeout: 2000 });
    } catch {
      /* button not ready, or a previous press already started the session */
    }
    try {
      await page.locator('.dot.connected').waitFor({ timeout: 2000 });
      return;
    } catch {
      /* the port is still held — retry */
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
  if (await enable.count()) await press(enable);
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
    if (!Number.isFinite(p)) await waitPageTime(page, 250);
  }
  await page.locator('label.field', { hasText: 'Speed (mm/s)' }).locator('input').fill('20');
  const jog = page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input');
  for (let i = 0; i < 4 && Number.isFinite(p) && Math.abs(p) > 0.5; i++) {
    await jog.fill(Math.abs(p).toFixed(2));
    const setWas = parseFloat(
      await page.locator('.readout', { hasText: 'Machine Setpoint' }).locator('.value').first().innerText(),
    );
    await press(page.getByRole('button', { name: p > 0 ? '− Jog down' : '+ Jog up' }));
    await settleMotion(page, { setpointWas: Number.isFinite(setWas) ? setWas : null });
    p = await pos();
  }
  if (!Number.isFinite(p) || Math.abs(p) > 0.5) {
    throw new Error(`zeroLength: gantry never reached machine 0 (got ${p})`);
  }
  await press(page.getByRole('button', { name: 'Zero length' }));
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

/**
 * The data-folder gate (src/ui/DataFolderGate.tsx), every branch other than
 * the happy path every other scenario takes. Board-free: a host Chrome with
 * the OPFS picker installed but NOT auto-answering, and in-page stubs for the
 * picker's failures and the browser's permission prompt.
 *
 *  1. picker cancelled (AbortError): no error shown, the gate stays up;
 *  2. picker throws anything else: its message is shown, the gate stays up;
 *  3. picker answers: the app renders;
 *  4. a new page in the same profile finds the remembered folder un-granted:
 *     the gate offers "Allow access to <folder>"; refused shows "Access to
 *     <folder> was not granted." and keeps the gate; granted renders the app.
 */
async function walkDataFolderGate() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // One context for both pages: the remembered folder lives in its IndexedDB.
    const context = await browser.newContext();
    const errors = [];
    await context.addInitScript(installOpfsDataDir, { dirName: OPFS_DIR, answerGate: false });

    const gate = (page) => page.getByTestId('data-folder-gate');
    const appShell = (page) => page.locator('nav.nav');
    const choose = (page) => gate(page).getByTestId('choose-data-folder');
    const gateError = (page) => gate(page).getByTestId('data-folder-error');
    // The gate disables its buttons while an attempt is in flight; enabled
    // again means the attempt has settled and its outcome is on screen.
    const settled = async (button) => {
      await button.waitFor({ timeout: DEVICE_WAIT_MS });
      for (let i = 0; i < 100 && (await button.isDisabled()); i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(await button.isEnabled(), 'the gate never finished its attempt');
    };

    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(APP_URL_HOST);
    await choose(page).waitFor({ timeout: DEVICE_WAIT_MS });

    // Swap the picker for one that fails the given way, keeping the real one.
    const pickerFails = (name, message) =>
      page.evaluate(([n, m]) => {
        window.__opfsPicker ??= window.showDirectoryPicker;
        window.showDirectoryPicker = async () => {
          throw new DOMException(m, n);
        };
      }, [name, message]);

    // 1. Cancelled picker: a change of mind, not a failure.
    await pickerFails('AbortError', 'The user aborted a request.');
    await press(choose(page));
    await settled(choose(page));
    assert((await gateError(page).count()) === 0, 'a cancelled folder picker showed an error');
    assert((await appShell(page).count()) === 0, 'the app rendered without a data folder');

    // 2. Any other picker failure is shown as is.
    const MESSAGE = 'The folder is on a drive that is not connected.';
    await pickerFails('NotFoundError', MESSAGE);
    await press(choose(page));
    await settled(choose(page));
    const shown = (await gateError(page).textContent())?.trim();
    assert(shown === MESSAGE, `picker failure showed ${JSON.stringify(shown)}, expected its message`);
    assert((await appShell(page).count()) === 0, 'the app rendered after the picker failed');

    // 3. The picker answers: the gate lifts and the app renders.
    await page.evaluate(() => {
      window.showDirectoryPicker = window.__opfsPicker;
    });
    await press(choose(page));
    await appShell(page).waitFor({ timeout: DEVICE_WAIT_MS });
    assert((await gate(page).count()) === 0, 'the gate stayed up after a folder was chosen');
    await page.close();

    // 4. Re-permission. A second page in the same profile restores the
    // remembered folder, but the browser reports access as needing a prompt
    // again (as it does after a restart). The prompt's answer is
    // window.__permissionAnswer, refused until the scenario says otherwise.
    const again = await context.newPage();
    again.on('pageerror', (e) => errors.push(e.message));
    await again.addInitScript(() => {
      window.__permissionAnswer = 'denied';
      window.__permissionRequests = 0;
      FileSystemHandle.prototype.queryPermission = async () => 'prompt';
      FileSystemHandle.prototype.requestPermission = async () => {
        window.__permissionRequests += 1;
        return window.__permissionAnswer;
      };
    });
    await again.goto(APP_URL_HOST);
    const grant = gate(again).getByTestId('grant-data-folder');
    await grant.waitFor({ timeout: DEVICE_WAIT_MS });
    const label = (await grant.textContent())?.trim();
    assert(label === `Allow access to “${OPFS_DIR}”`, `re-permission button read ${JSON.stringify(label)}`);
    assert((await appShell(again).count()) === 0, 'the app rendered before access was re-granted');

    await press(grant);
    await settled(grant);
    const refused = (await gateError(again).textContent())?.trim();
    assert(
      refused === `Access to “${OPFS_DIR}” was not granted.`,
      `refused permission showed ${JSON.stringify(refused)}`,
    );
    assert((await appShell(again).count()) === 0, 'the app rendered after access was refused');

    await again.evaluate(() => {
      window.__permissionAnswer = 'granted';
    });
    await press(grant);
    await appShell(again).waitFor({ timeout: DEVICE_WAIT_MS });
    assert((await gate(again).count()) === 0, 'the gate stayed up after access was granted');
    const asked = await again.evaluate(() => window.__permissionRequests);
    assert(asked === 2, `expected one permission prompt per press (2), saw ${asked}`);

    assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
  } finally {
    await browser.close();
  }
}

// ── Scenarios (extend toward TEST_PLAN.md §4) ──
const scenarios = [
  {
    id: 'A1',
    name: 'Startup gates: capability gate blocks non-Chromium contexts; data-folder gate branches',
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
      // The data-folder gate sits directly inside the capability gate
      // (App.tsx): the two are the app's startup gates, so A1 walks both.
      await walkDataFolderGate();
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
        await press(page.getByRole('button', { name: '+ Add set' }));
        await press(page.getByRole('button', { name: 'Preview G-code' }));
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
        await fieldInput(page, 'Max force (N)').fill('500');
        await fieldInput(page, 'Sample name').fill('E2E-Sample');
        await press(page.getByRole('button', { name: 'Save sample profile' }));
        await page.getByText(/Saved to data folder/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page
          .locator('.panel', { hasText: 'Saved sample profiles' })
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
        // B2: baud selector present and selectable, and a rate other than the
        // board's says what the hardware contract is.
        const baud = page.locator('label.field', { hasText: 'Baud rate' }).locator('select');
        await baud.selectOption('115200');
        await page.getByText(/Hardware contract is 2,000,000 baud/).waitFor({ timeout: DEVICE_WAIT_MS });
        // Back to the board's rate: its line runs at 2,000,000 baud, and a port
        // opened at another rate hears nothing it can decode (the board
        // route's port sheds it, as a real adapter garbles it).
        await baud.selectOption('2000000');
        // B3: the granted device is listed with a Connect button.
        await page.getByTestId('connect-granted').first().waitFor({ timeout: DEVICE_WAIT_MS });
        // Connect via the granted port at the chosen baud.
        await press(boardGrantedPort(page));
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
        await press(combined.getByRole('button', { name: 'Sample' }));
        await waitPageTime(page, 300);
        await combined.locator('canvas').first().waitFor({ timeout: DEVICE_WAIT_MS });
        await press(combined.getByRole('button', { name: 'Machine' }));
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
          press(page.getByRole('button', { name: 'Export CSV' }).first()),
        ]);
        assert(download.suggestedFilename().includes('_export.csv'), `bad export filename: ${download.suggestedFilename()}`);
        // H4: delete with confirm
        const row = page.locator('tr', { hasText: 'RUN01' });
        await press(row.getByRole('button', { name: 'Delete' }));
        await press(page.getByTestId('confirm-delete'));
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
        // Optional: a short budget, so a screen without the button costs little.
        await press(page.getByRole('button', { name: 'Read from device' }), { timeout: 2000 }).catch(() => {});
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
        const settledValue = async (loc, { ticks = 3, pollMs = 200, timeoutMs = 20_000 } = {}) => {
          const clock = await pageClock(page);
          let last = null;
          let n = 0;
          while ((await clock.elapsed()) < timeoutMs) {
            const v = await loc.inputValue();
            if (v === last) {
              if (++n >= ticks) return v;
            } else {
              n = 0;
            }
            last = v;
            await waitPageTime(page, pollMs);
          }
          return last;
        };
        await settledValue(field);
        await field.fill(target);
        // And confirm the edit actually stuck — a late repaint would have wiped
        // it, and saving an unchanged form proves nothing.
        for (let i = 0; i < 5 && (await field.inputValue()) !== target; i++) {
          await waitPageTime(page, 200);
          await field.fill(target);
        }
        assert(
          (await field.inputValue()) === target,
          'the jaw offset edit did not stick before saving — the form was repainted mid-edit',
        );
        await press(page.getByRole('button', { name: 'Write to device' }));
        await page.getByText(/Saved to device/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await press(page.getByRole('button', { name: 'Read from device' }));
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
        if (await enableBtn.count()) await press(enableBtn);
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
    // The open-loop drive/encoder check under Settings. The emulated machine's
    // drive and encoder are both 8192 steps/mm and wired the same way round,
    // so the report must say the profile matches and show one count per pulse
    // each way -- which needs the firmware sequencer, the protocol pair and
    // the panel all to agree on signs and units.
    id: 'CAL1',
    name: 'Motor calibration: open-loop check reports a matched drive and encoder',
    async run() {
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await prepareManualControl(page);
        await page.goto(`${APP_URL}#/settings`);
        await page.getByRole('heading', { name: 'Motor calibration' }).waitFor({ timeout: DEVICE_WAIT_MS });
        const run = page.getByRole('button', { name: 'Run calibration' });
        await run.waitFor({ timeout: DEVICE_WAIT_MS });
        // Enabled once the machine profile has been read and motion is on.
        const clock = await pageClock(page);
        while (await run.isDisabled()) {
          assert((await clock.elapsed()) < DEVICE_WAIT_MS, 'Run calibration never became available');
          await waitPageTime(page, 200);
        }
        await press(run);
        await page
          .getByText(/Calibration passed/)
          .waitFor({ timeout: DEVICE_WAIT_MS * 4 });
        // The SIL's drive and encoder are both 8192/mm: counts back match the
        // pulses sent, with the right sign.
        const measured = Number(await page.getByTestId('measured-counts').innerText());
        const expected = Number(await page.getByTestId('expected-counts').innerText());
        assert(expected > 0 && Math.abs(measured / expected - 1) < 0.02, `encoder moved ${measured} counts, expected ~${expected}`);
        assert((await page.locator('.badge.error').count()) === 0, 'the calibration reported an error');
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
        await press(page.getByRole('button', { name: 'Save motion profile' }));
        await page.getByText(/Motion profile .* saved/i).waitFor({ timeout: DEVICE_WAIT_MS });
        // The list refreshes from the data folder after the save is reported:
        // a storage read, which completes in a later slice of the page's time.
        // Wait for it rather than reading the list the instant the notice shows.
        await motionPanel.locator('select').last().locator('option', { hasText: 'E2E-Motion-Build' })
          .waitFor({ state: 'attached', timeout: DEVICE_WAIT_MS })
          .catch(() => {});
        const opts = await motionPanel.locator('select').last().locator('option').allTextContents();
        assert(opts.some((o) => o.includes('E2E-Motion-Build')), 'saved motion profile not listed');
        // preview reflects the dwell + trailing G122
        await press(page.getByRole('button', { name: 'Preview G-code' }));
        const code = await page.locator('.code-block').first().textContent();
        assert((code || '').includes('G4 P1500'), 'preview missing dwell');
        assert((code || '').includes('G122'), 'preview missing G122');
        // Close the preview if it has a close button (optional; a short budget).
        await press(page.getByRole('button', { name: '✕' }).first(), { timeout: 2000 }).catch(() => {});
        // F6: import a .mp file populates the editor
        const mp = JSON.stringify({ name: 'Imported-MP', description: 'imp', sets: [] });
        await page.locator('input[accept*=".mp"]').setInputFiles({
          name: 'x.mp',
          mimeType: 'application/json',
          buffer: Buffer.from(mp),
        });
        const nameField = fieldInput(motionPanel, 'Name').first();
        const importClock = await pageClock(page);
        let nameVal = '';
        while ((await importClock.elapsed()) < DEVICE_WAIT_MS) {
          nameVal = await nameField.inputValue();
          if (nameVal === 'Imported-MP') break;
          await waitPageTime(page, 100);
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
        await press(page.getByTestId('run-test'));

        // The run record is created and the device accepts the test (status running).
        await page.locator('.panel', { hasText: 'New Test' }).getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.locator('tbody .badge', { hasText: 'running' }).first().waitFor({ timeout: DEVICE_WAIT_MS });
        // Leave the machine idle: let the 2 s dwell finish. On the board route
        // the next scenario starts a few milliseconds of the board's time after
        // this one ends, and a run still going makes the firmware refuse the
        // next scenario's TEST_RUN as busy.
        await page.locator('tbody .badge.completed').first().waitFor({ timeout: RUN_WAIT_MS });
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
        await press(page.getByTestId('run-test'));
        await runner.getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        const row = page.locator('tbody tr').first();
        // G3: firmware runs the test and testRunning toggles → run auto-marks completed.
        await row.locator('.badge.completed').waitFor({ timeout: RUN_WAIT_MS });
        // H2: pull the data file from the device → CSV.
        await press(row.getByRole('button', { name: /Download data/i }));
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
        await press(row.getByRole('button', { name: 'View' }));
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
        await press(page.getByRole('button', { name: 'Zero length' }));
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
        await press(page.getByTestId('run-test'));
        await runner.getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        const row = page.locator('tbody tr').first();
        await row.locator('.badge.completed').waitFor({ timeout: RUN_WAIT_MS });
        await press(row.getByRole('button', { name: /Download data/i }));
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
        if (await enableBtn.count()) await press(enableBtn);
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });

        const live = () => page.evaluate(() => globalThis.__madLive?.latest() ?? null);
        assert(await live(), 'the live sample ring is exposed (dev build)');

        await page.getByLabel('Jog (mm)').fill('2');
        await page.getByLabel('Speed (mm/s)').fill('5');
        const before = await live();
        await press(page.getByRole('button', { name: '+ Jog up' }));
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
        if (await enableBtn.count()) await press(enableBtn);
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });

        const live = () => page.evaluate(() => globalThis.__madLive?.latest() ?? null);
        const before = await live();
        assert(before, 'the live sample ring is exposed (dev build)');
        await press(page.getByRole('button', { name: 'Home' }));

        // Wait for the seek to actually START before waiting for it to finish.
        // awaitRest on its own returns immediately: the axis is still at rest
        // from before the click, which reads as "settled" and hands back the
        // pre-home position — 87 mm from where homing ends.
        const moveClock = await pageClock(page);
        let moving = false;
        while ((await moveClock.elapsed()) < DEVICE_WAIT_MS) {
          const now = await live();
          if (now && Math.abs(now.machinePosition - before.machinePosition) > 10) { moving = true; break; }
          await waitPageTime(page, 100);
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
        const settleClock = await pageClock(page);
        let after = null;
        let converged = false;
        let prevMm = NaN;
        let stillTicks = 0;
        while ((await settleClock.elapsed()) < RUN_WAIT_MS) {
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
          await waitPageTime(page, 100);
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
        // The wait is for STILLNESS, not for the bound. That is what stops
        // this being the tautology it was, where the loop exited on "within
        // X" and then checked "within X" and could only fail by timing out.
        const offUm = Math.abs(after.machinePosition - after.machineSetpoint) * 1000;
        const homeTolUm = DEADBAND_UM * 1.5;
        assert(
          offUm <= homeTolUm,
          `homing parked on its setpoint (off by ${offUm.toFixed(2)} um, tolerance ${homeTolUm.toFixed(2)} um` +
            `, deadband ${DEADBAND_UM})`,
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
          await press(page.getByRole('button', {
            name: cell.setupJogMm > 0 ? '+ Jog up' : '− Jog down',
          }));
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
        await press(page.getByTestId('run-test'));
        await runner.getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        // Observe the firmware actually running, then disable motion.
        await page.goto(`${APP_URL}#/live`);
        await page.getByText('Test: running').waitFor({ timeout: DEVICE_WAIT_MS });
        await press(page.getByRole('button', { name: 'Disable motion' }));
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
        await press(page.getByRole('button', { name: '+ Jog up' }));
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
        await press(page.getByRole('button', { name: '+ Jog up' }));
        await settleMotion(page, { setpointWas: setBefore });
        const up = await num('Machine Position');
        const upSet = await num('Machine Setpoint');
        assert(Math.abs(up - start - cell.mm) < cell.epsMm, `jog +${cell.mm}mm (Δ ${(up - start).toFixed(3)})`);
        assert(Math.abs(up - upSet) < 0.15, `settled onto setpoint (|Δ| ${Math.abs(up - upSet).toFixed(3)})`);
        if (cell.roundTrip) {
          const setBeforeDown = await num('Machine Setpoint');
          await press(page.getByRole('button', { name: '− Jog down' }));
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
  // The app as it ships: the bundle `vite build` makes, served by
  // `vite preview` (board-route.sh with APP_DIST), on the board. The dev
  // server compiles for the newest Chrome and the bundle for the app's
  // browser floor, so a fault the bundler brings in shows only here: one
  // stopped every sample, state and disconnect reaching the screen (#156).
  // Every check below needs the worker's events to reach the page.
  {
    id: 'BUNDLE-live',
    name: 'The built bundle: connect, live samples and state, unplug, replug and reconnect by itself',
    async run() {
      // The replug below is the board's own cable; only the board route has one.
      assert(BOARD, 'BUNDLE-live runs on the board route (SIL/scripts/board-route.sh with APP_DIST)');
      const html = await (await fetch(APP_URL_HOST)).text();
      assert(!html.includes('/@vite/client'), `the app at ${APP_URL_HOST} is the dev server, not a built bundle`);
      const { browser, page, errors } = await newSilPage();
      try {
        // A built bundle keeps its session log to itself unless the user opts
        // in (`mad:log`); opt in, so a failure here carries that log.
        await page.context().addInitScript(() => {
          try {
            localStorage.setItem('mad:log', '*');
          } catch {
            /* no storage: the failure report goes without the app's log */
          }
        });
        await connectToSil(page);
        await page.goto(`${APP_URL}#/live`);
        // Samples, and the opening handshake's firmware version.
        await awaitResponding(page);
        const forceText = (await page.locator('.readout', { hasText: 'Machine Force' }).locator('.value').textContent())?.trim() || '';
        assert(/^-?\d/.test(forceText), `live readout never populated (got ${forceText})`);
        // Machine state: the Test badge reads '—' until a state frame arrives.
        await page.getByText(/^Test: (idle|running)$/).waitFor({ timeout: DEVICE_WAIT_MS });
        // Unplug: the disconnect reaches the screen.
        await dropLink(page);
        await page.locator('.dot.disconnected').waitFor({ timeout: DEVICE_WAIT_MS });
        await page.locator('.toast').getByText(/disconnected/i).first().waitFor({ timeout: DEVICE_WAIT_MS });
        // Replug: the app reconnects by itself to the port it remembers, with
        // nobody pressing Reconnect, and samples resume.
        await restoreLink(page);
        try {
          await page.locator('.dot.connected').waitFor({ timeout: DEVICE_WAIT_MS });
        } catch {
          throw new Error(`the app did not reconnect by itself within ${DEVICE_WAIT_MS} ms of board time after the cable came back`);
        }
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
        await press(page.getByTestId('run-test'));
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
        await press(page.getByRole('button', { name: '+ Jog up' }));
        await settleMotion(page, { setpointWas: upSetWas });
        const upPos = await num('Machine Position');
        const upSet = await num('Machine Setpoint');
        assert(Math.abs(upPos - startPos - 4) < 0.2, `jog +4mm landed (Δ ${(upPos - startPos).toFixed(3)}mm)`);
        assert(Math.abs(upPos - upSet) < 0.12, `position settles onto setpoint (|Δ| ${Math.abs(upPos - upSet).toFixed(3)}mm)`);
        const downSetWas = await num('Machine Setpoint');
        await press(page.getByRole('button', { name: '− Jog down' }));
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
        await press(page.getByRole('button', { name: 'Zero force' }));
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
            await press(page.getByRole('button', { name: '+ Jog up' }));
          } else {
            await press(page.getByRole('button', { name: '+ Jog up' }));
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
        await press(page.getByRole('button', { name: '− Jog down' }));
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
        await press(page.getByRole('button', { name: 'Zero force' }));
        await awaitReadoutNear(page, 'Sample Force', 0, { eps: 1 });
        const jog = page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input');
        // Two jogs of half if past slack so we don't overshoot from boot.
        const half = cell.jogMm / 2;
        await jog.fill(String(half));
        const firstSetWas = await num('Machine Setpoint');
        await press(page.getByRole('button', { name: '+ Jog up' }));
        await settleMotion(page, { setpointWas: firstSetWas });
        const secondSetWas = await num('Machine Setpoint');
        await press(page.getByRole('button', { name: '+ Jog up' }));
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
        await press(page.getByTestId('run-test'));
        await page.locator('tbody tr').first().locator('.badge.completed').waitFor({ timeout: RUN_WAIT_MS });
        // Run #2 — same profiles, immediately after (newest run is prepended).
        await press(page.getByTestId('run-test'));
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
        await press(page.getByTestId('run-test'));
        await page.locator('.panel', { hasText: 'New Test' }).getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.goto(`${APP_URL}#/live`);
        await page.getByText('Test: running').waitFor({ timeout: DEVICE_WAIT_MS });
        await press(page.getByRole('button', { name: 'Disable motion' }));
        await page.getByText('Test: idle').waitFor({ timeout: DEVICE_WAIT_MS });
        // Re-enable and start a short second test immediately — stuck busy would block it.
        await press(page.getByRole('button', { name: 'Enable motion' }));
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });
        await seedProfiles(page, {
          sample: { serial: 'TM-Restart2', maxForce: 500, maxVelocity: 25, maxDisplacement: 100, sampleWidth: 4, sampleThickness: 1.5 },
          motion: { name: 'Short-TM', moves: [
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: 5, time: 0, circularOffset: 0 } },
            { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: -5, time: 0, circularOffset: 0 } },
          ] },
        });
        await selectSeeded(page);
        await press(page.getByTestId('run-test'));
        await page.locator('.panel', { hasText: 'New Test' }).getByText(/started/i).waitFor({ timeout: DEVICE_WAIT_MS });
        await page.goto(`${APP_URL}#/live`);
        await page.getByText('Test: running').waitFor({ timeout: 20_000 });
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
        await press(page.getByTestId('run-test'));
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
    // A latched servo stall is cleared from the Live screen. The board's
    // carriage is jammed (mad-emulator --jam-file: while the file exists the
    // drive keeps stepping but the carriage gets nowhere, its encoder
    // buzzing a few counts either side as a powered drive's does), so
    // a jog trips dev_servo's stall guard and app_control latches
    // FAULT_SERVO_STALL. Only a disable request clears that latch, and while
    // faulted the machine reports motion off — the Live button has to offer
    // the disable, then the enable once the fault is gone.
    id: 'SERVO-stall',
    name: 'A jammed gantry latches SERVO_STALL; Live clears it and re-enables motion',
    async run() {
      const jamFile = process.env.E2E_JAM_FILE;
      if (!jamFile) {
        throw new Error(
          'SERVO-stall needs E2E_JAM_FILE, the file mad-emulator was given as --jam-file ' +
            '(board-route.sh sets both with BOARD_ROUTE=emulator; the project has no jam)',
        );
      }
      const free = () => rmSync(jamFile, { force: true });
      const { browser, page, errors } = await newSilPage();
      try {
        await connectToSil(page);
        await chooseDataFolder(page);
        await awaitResponding(page);
        await zeroLength(page);
        await page.getByText('Fault: NONE').waitFor({ timeout: DEVICE_WAIT_MS });

        writeFileSync(jamFile, '');
        await page.locator('label.field', { hasText: 'Speed (mm/s)' }).locator('input').fill('5');
        await page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input').fill('5');
        await press(page.getByRole('button', { name: '+ Jog up' }));
        await page.getByText('Fault: SERVO_STALL').waitFor({ timeout: DEVICE_WAIT_MS });
        await page.getByText('Motion: disabled').waitFor({ timeout: DEVICE_WAIT_MS });
        assert(
          !(await page.getByRole('button', { name: 'Enable motion' }).count()),
          'a stalled machine is offered "Enable motion", which it would refuse',
        );

        free();
        await press(page.getByRole('button', { name: 'Clear stall (disable motion)' }));
        await page.getByText('Fault: NONE').waitFor({ timeout: DEVICE_WAIT_MS });
        await press(page.getByRole('button', { name: 'Enable motion' }));
        await page.getByText('Motion: enabled').waitFor({ timeout: DEVICE_WAIT_MS });
        await page.getByText('Fault: NONE').waitFor({ timeout: DEVICE_WAIT_MS });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        free();
        await browser.close();
      }
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

        await press(page.getByTestId('flash-firmware'));
        await page.getByTestId('flash-status').filter({ hasText: /Wrote .* bytes to flash/ })
          .waitFor({ timeout: 30_000 });

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
    id: 'FW-ISS',
    name: 'Firmware: UI flash talks to the ISS mask ROM over Web Serial',
    async run() {
      // The ROM board only (E2E_BOARD=rom, `make e2e-rom`): the node's port
      // is the programming UART, as the P2 Edge's FT231X (0403:6015). The
      // ROM's serial strap is pulled up, so Prop_Chk is answered without the
      // reset pulse the app sends (no pin carries DTR).
      const { browser, page, errors } = await newSilPage();
      try {
        page.on('dialog', (d) => d.accept());
        await page.goto(`${APP_URL}#/firmware`);
        await page.getByTestId('flash-target').filter({ hasText: /USB 0403:6015/ })
          .waitFor({ timeout: DEVICE_WAIT_MS });

        const payload = Buffer.from([
          0x42, 0xEC, 0x07, 0xF6,
          0x3E, 0xEC, 0x27, 0xFC,
          0xFC, 0xFF, 0x9F, 0xFD,
        ]);
        await page.getByTestId('firmware-file').setInputFiles({
          name: 'program.bin',
          mimeType: 'application/octet-stream',
          buffer: payload,
        });

        await press(page.getByTestId('flash-firmware'));
        await page.getByTestId('flash-status').filter({ hasText: /Wrote .* bytes to flash/ })
          .waitFor({ timeout: 120_000 });
        assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
      } finally {
        await browser.close();
      }
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
        await press(page.getByTestId('flash-firmware'));

        // Give the click somewhere to go before asserting nothing happened.
        await waitPageTime(page, 500);
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
        await waitPageTime(page, 200);
        assert((await page.getByTestId('file-error').count()) === 0, 'valid build was rejected');
        assert(await page.getByTestId('flash-firmware').isEnabled(), 'valid build did not arm the button');
      } finally { await browser.close(); }
    },
  },
  {
    id: 'FW7',
    name: 'Firmware: every control is locked while programming and writing flash, and progress shows',
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
        await press(page.getByTestId('flash-firmware'));

        await page.getByTestId('flash-status').filter({ hasText: /Uploading… \d+%/ }).waitFor({ timeout: 20_000 });
        for (const id of ['flash-firmware', 'firmware-file', 'choose-flash-port']) {
          assert(await page.getByTestId(id).isDisabled(), `${id} was still enabled mid-flash`);
        }
        // After the upload the chip is still erasing and programming flash;
        // the app must hold the port, and the user's hands, until it is done.
        await page.getByTestId('flash-status').filter({ hasText: /Writing flash… about \d+s/ }).waitFor({ timeout: RUN_WAIT_MS });
        for (const id of ['flash-firmware', 'firmware-file', 'choose-flash-port']) {
          assert(await page.getByTestId(id).isDisabled(), `${id} was enabled while flash was being written`);
        }
        assert(
          await page.evaluate(() => window.__bootRom.closedAt === null),
          'the port was closed while flash was being written',
        );
        await page.getByTestId('flash-status').filter({ hasText: /Wrote .* bytes to flash/ })
          .waitFor({ timeout: RUN_WAIT_MS });
        // 4096 + 496 bytes: the write estimate is at least its fixed second.
        const held = await page.evaluate(() => window.__bootRom.closedAt - window.__bootRom.finishedAt);
        assert(held >= 1000, `port closed ${Math.round(held)} ms after the download ended; flash needs longer`);
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
        await press(page.getByTestId('choose-flash-port'));
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
        await press(page.getByTestId('flash-firmware'));
        await page.getByTestId('flash-status').filter({ hasText: /No response from the Propeller 2/ })
          .waitFor({ timeout: 30_000 });
      } finally { await browser.close(); }
    },
  },
];

/**
 * The board's Chrome still answers DevTools. Asked a few seconds after the
 * failure: a run the node stops takes Chrome down with it, just after the
 * scenario sees its page go.
 */
async function boardAlive() {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const res = await fetch(new URL('/json/version', CDP_URL), { signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  // BUNDLE-live named without the bundle would be a skip, and a run that
  // asked for it would pass having checked nothing: refuse.
  if (!APP_IS_BUNDLE && (process.env.SCENARIOS || '').split(',').some((x) => x.trim() === 'BUNDLE-live')) {
    console.error('✗ BUNDLE-live needs the built bundle: SIL/scripts/board-route.sh with APP_DIST (see its header).');
    process.exit(2);
  }
  // `--list`: the ids SCENARIOS selects (all of them without it), in the
  // suite's order, one a line: FW-ISS only on the ROM board, BUNDLE-live only
  // on the built bundle, and each left out otherwise. What this board cannot
  // run is left out too, and said on stderr with why. `--board-free` lists
  // only the scenarios that need no board. `--cannot` lists only those the
  // project cannot run (`PROJECT_CANNOT`), whatever the route: the set
  // `make e2e-motion` runs on mad-emulator's board.
  // SIL/scripts/board-route.sh runs them one board each from this.
  if (process.argv.includes('--list')) {
    const only = process.env.SCENARIOS ? new Set(process.env.SCENARIOS.split(',').map((x) => x.trim())) : null;
    const boardFreeOnly = process.argv.includes('--board-free');
    const cannotOnly = process.argv.includes('--cannot');
    for (const s of scenarios) {
      if (
        (s.id === 'FW-ISS') === ROM_BOARD &&
        (s.id !== 'BUNDLE-live' || APP_IS_BUNDLE) &&
        (!only || only.has(s.id)) &&
        (!boardFreeOnly || BOARD_FREE.has(s.id))
      ) {
        if (cannotOnly) {
          if (PROJECT_CANNOT.has(s.id)) console.log(s.id);
        } else if (cannot(s.id)) {
          if (!boardFreeOnly) console.error(`  ~ ${s.id}: skipped (${cannot(s.id)})`);
        } else console.log(s.id);
      }
    }
    return;
  }
  // Fail fast with guidance if the dev server isn't up.
  try {
    const res = await fetch(APP_URL_HOST);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(
      `✗ App not reachable at ${APP_URL_HOST}. Start: npm run dev${
        BOARD ? ' (and the board: cd SIL && make e2e-emulator, CDP_URL its DevTools URL)' : ''
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

  // Without the board, a board scenario has nothing valid to run against
  // (the WS bridge's fake serial is the hardware harness's, in real time).
  // Named explicitly, that is an error; in a whole-suite run, a skip that
  // says so.
  if (!BOARD && only) {
    const needBoard = [...only].filter((id) => !BOARD_FREE.has(id));
    if (needBoard.length) {
      console.error(
        `✗ ${needBoard.join(', ')} touch the board: set CDP_URL to the DevTools URL of ` +
          'the board\'s run (cd SIL && make e2e-emulator), or run `make e2e` in SIL/.',
      );
      process.exit(2);
    }
  }

  let pass = 0;
  const failures = [];
  const timings = [];
  let skipped = 0;
  for (const s of selected) {
    // The ROM board (E2E_BOARD=rom: mad-emulator --boot-rom --chrome, the
    // mask ROM on the programming UART) runs FW-ISS and nothing else; the
    // firmware's board runs everything else.
    if (BOARD && (s.id === 'FW-ISS') !== ROM_BOARD && !BOARD_FREE.has(s.id)) {
      console.log(
        `  ~ ${s.id}: skipped (needs the ${ROM_BOARD ? "firmware's" : 'ROM'} board${
          ROM_BOARD ? '' : ': make e2e-rom'
        })`,
      );
      skipped += 1;
      continue;
    }
    if (s.id === 'BUNDLE-live' && !APP_IS_BUNDLE) {
      console.log(`  ~ ${s.id}: skipped (needs the built bundle: board-route.sh with APP_DIST)`);
      skipped += 1;
      continue;
    }
    if (cannot(s.id)) {
      console.log(`  ~ ${s.id}: skipped (${cannot(s.id)})`);
      skipped += 1;
      continue;
    }
    if (!BOARD && s.id === 'FW-ISS') {
      console.log(`  ~ ${s.id}: skipped (needs the ROM board: make e2e-rom)`);
      skipped += 1;
      continue;
    }
    if (!BOARD && !BOARD_FREE.has(s.id)) {
      console.log(`  ~ ${s.id}: skipped (touches the board; set CDP_URL)`);
      skipped += 1;
      continue;
    }
    process.stdout.write(`• ${s.id} ${s.name} … `);
    setCurrentScenario(s.id);
    takePageTime();
    const started = Date.now();
    let verdict = 'pass';
    try {
      // eslint-disable-next-line no-await-in-loop
      await s.run();
      pass += 1;
    } catch (err) {
      verdict = 'FAIL';
      failures.push(`${s.id} ${s.name}: ${err.message}`);
      // Every failure carries the app's merged main+worker log, so a red CI run
      // is diagnosable without reproducing it locally.
      // eslint-disable-next-line no-await-in-loop
      await dumpFailureArtifacts(s.id, err).catch(() => {});
      // Leave the machine idle for the next scenario. Without this one hung run
      // cascades: the firmware keeps reporting testRunning, the app keeps the
      // jog and speed controls gated, and every later scenario fails on a
      // disabled field rather than on whatever it was testing.
      // On the board route a failure can be the board itself stopping: the
      // emulator ends the run when its chrome-cdp fails (a grant that stuck,
      // a crashed page), and Chrome goes with it. Every later scenario would
      // then fail on the connection, saying nothing; stop and say so.
      // eslint-disable-next-line no-await-in-loop
      if (BOARD && !(await boardAlive())) {
        const left = selected.length - selected.indexOf(s) - 1;
        console.log(
          `\n✗ the board is gone (nothing answers at ${CDP_URL}): mad-emulator stopped, and its ` +
            `log says why. ${left} scenario${left === 1 ? '' : 's'} not run.`,
        );
        failures.push(`the board stopped during ${s.id}; ${left} scenarios not run`);
        timings.push({ id: s.id, verdict, hostS: (Date.now() - started) / 1000, boardS: null });
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await recoverMachine().catch(() => {});
    }
    // Host time is reported, never asserted. Page time is the time the
    // scenario's pages lived: the board's on the board route.
    // A board-free scenario's host Chrome keeps host time: no board time.
    const hostS = (Date.now() - started) / 1000;
    const boardS = BOARD && !BOARD_FREE.has(s.id) ? takePageTime() / 1000 : null;
    timings.push({ id: s.id, verdict, hostS, boardS });
    console.log(
      `${verdict === 'pass' ? '✅' : '❌'}  (host ${hostS.toFixed(1)} s` +
        `${boardS === null ? '' : `, board ${boardS.toFixed(3)} s`})`,
    );
    if (!BOARD) {
      // Settle: let the previous client fully release the bridge before the
      // next connects. (On the board route each page waits a few slices of
      // the board's time before it starts; see newSilPage.)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  // One line per scenario, for a CI log or a table.
  if (process.env.E2E_TIMINGS) {
    writeFileSync(process.env.E2E_TIMINGS, JSON.stringify({ board: BOARD, timings }, null, 2));
  }

  console.log(`\n${pass}/${selected.length - skipped} scenarios passed${skipped ? `, ${skipped} skipped` : ''}${only ? ' (filtered)' : ''}`);
  if (selected.length > 0 && skipped === selected.length) {
    console.log('✗ every scenario selected was skipped: this run checked nothing');
    process.exit(1);
  }
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
