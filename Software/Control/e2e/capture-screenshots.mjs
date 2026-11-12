/**
 * Documentation screenshot capture: `npm run docs:screenshots`.
 *
 * Renders the real Control UI with no machine and no emulator, and saves a PNG
 * of every screen and every state the docs describe into
 * docs/assets/screenshots/. It starts its own Vite dev server, so there is
 * nothing to run first.
 *
 * The machine is faked inside the page (this file only; nothing in src/):
 *   - the store is put into each state directly (connection, firmware verdict,
 *     machine state, configuration);
 *   - a small carriage model feeds the live buffer at 100 Hz and answers the
 *     device client's move commands, so the charts, the motor calibration and
 *     the load cell calibration run their real code on plausible data;
 *   - `navigator.serial.getPorts` returns two adapters (control + Prop Plug);
 *   - the data folder is an OPFS directory seeded with profiles and runs.
 *
 * The shots show what the app looks like in a state. They are not evidence the
 * firmware produces that state: that is the e2e suite's job, on the board.
 */

import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'vite';
import playwright from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const OUT = process.env.SHOT_DIR || resolve(HERE, '../../../docs/assets/screenshots');
const PORT = Number(process.env.SHOT_PORT || 5199);
const ONLY = process.env.SHOT_ONLY ? new RegExp(process.env.SHOT_ONLY) : null;
const OPFS_DIR = 'mad-docs';

const VIEW_W = 1280;
const VIEW_H = 820;

/** Realistic seed data so the editors, history and charts look populated. */
const SAMPLE = {
  maxForce: 10,
  maxVelocity: 50,
  maxDisplacement: 120,
  sampleWidth: 10,
  sampleThickness: 2,
  serial: 'PDMS-10A',
};
const MOTION = {
  name: 'Cyclic Tension',
  description: 'Preload then 3 load/unload cycles',
  sets: [
    {
      name: 'Preload',
      executions: 1,
      moves: [
        { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 5, distance: 5, time: 0, circularOffset: 0 } },
      ],
    },
    {
      name: 'Cycle',
      executions: 3,
      moves: [
        { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: 20, time: 0, circularOffset: 0 } },
        { moveType: 'dwell', absoluteOrRelative: 'absolute', moveParameters: { position: 0, velocity: 0, distance: 0, time: 500, circularOffset: 0 } },
        { moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 10, distance: -20, time: 0, circularOffset: 0 } },
      ],
    },
  ],
};

/** A machine configuration as the Settings screen shows it. */
const CONFIG = {
  Name: 'MaD-01',
  'Encoder (step/mm)': 2400,
  'Servo (step/mm)': 6400,
  'Load Cell Capacity (N)': 500,
  'Load Cell Sensitivity (mV/V)': 2,
  'Load Cell Zero Balance (mV/V)': 0.0125,
  'Position Max (mm)': 300,
  'Velocity Max (mm/s)': 50,
  'Acceleration Max (mm/s^2)': 200,
  'Tensile Force Max (N)': 450,
  'Homing Velocity (mm/s)': 5,
  'Homing Offset (mm)': 2,
  'Jaw Offset (mm)': 35,
  'Restricted Velocity (mm/s)': 2,
  'Servo Kp (1/s)': 8,
  'Servo Ki (1/s^2)': 0,
  'Drive Enable Active Low': false,
};

/** Build a cyclic load/unload CSV (firmware-native units: µs, mN, µm). */
function buildCsv() {
  const rows = ['time_us,force_mN,position_um,setpoint_um'];
  const gauge = 10000; // µm
  let t = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i <= 40; i++) {
      const phase = i / 40;
      const posMm = phase < 0.5 ? phase * 2 * 20 : (1 - phase) * 2 * 20;
      const pos = gauge + posMm * 1000;
      const stretch = Math.max(0, posMm - 5);
      const force = stretch * 380;
      rows.push(`${t},${Math.round(force)},${Math.round(pos)},${Math.round(pos)}`);
      t += 50000;
    }
  }
  return rows.join('\n');
}

/** Init script: two granted serial adapters and an OPFS data folder. */
function installBrowserFakes({ dirName }) {
  const fakePort = (vendor, product) => ({
    getInfo: () => ({ usbVendorId: vendor, usbProductId: product }),
    addEventListener() {},
    removeEventListener() {},
  });
  // FT232R on the control port, FT231X Prop Plug on J1.
  const ports = [fakePort(0x0403, 0x6001), fakePort(0x0403, 0x6015)];
  if (navigator.serial) {
    navigator.serial.getPorts = async () => ports;
    navigator.serial.requestPort = async () => ports[1];
  }
  // The Firmware page's remembered programming port: the Prop Plug.
  try {
    localStorage.setItem('mad.flashPort', JSON.stringify({ vendorId: 0x0403, productId: 0x6015, index: 1 }));
  } catch {
    /* storage blocked: the page then asks which port, which is also a real state */
  }
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(dirName, { recursive: true });
    } catch {
      /* not present */
    }
    return root.getDirectoryHandle(dirName, { create: true });
  };
}

async function seed(page) {
  await page.evaluate(
    async ({ sample, motion, csv, dirName }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(dirName, { create: true });
      const write = async (sub, name, content) => {
        const d = await dir.getDirectoryHandle(sub, { create: true });
        const fh = await d.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
      };
      const now = new Date().toISOString();
      await write('sampleProfiles', `${sample.serial}.json`, JSON.stringify({
        id: `s-${sample.serial}`, name: sample.serial, createdAt: now, profile: sample,
      }));
      await write('motionProfiles', `${motion.name}.json`, JSON.stringify({
        id: `m-${motion.name}`, name: motion.name, description: motion.description, createdAt: now,
        profile: { name: motion.name, description: motion.description, sets: motion.sets },
      }));
      const mkRun = (name, status, withCsv, startedOffsetMin) => ({
        id: `r-${name}`,
        testName: name,
        sampleProfileId: `s-${sample.serial}`,
        motionProfileId: `m-${motion.name}`,
        sampleProfile: sample,
        motionProfile: { name: motion.name, description: motion.description, sets: motion.sets },
        sampleProfileName: sample.serial,
        motionProfileName: motion.name,
        gcode: ['G90', 'G91', 'G1 X20 F10', 'G4 P500', 'G1 X-20 F10', 'G122'],
        gaugeLengthMm: 10,
        initialPositionUm: 10000,
        startedAt: new Date(Date.now() - startedOffsetMin * 60000).toISOString(),
        completedAt: status === 'running' ? undefined : new Date(Date.now() - (startedOffsetMin - 1) * 60000).toISOString(),
        status,
        dataFilePath: withCsv ? `testRuns/${name}.csv` : undefined,
      });
      const runs = [
        mkRun('0004', 'running', false, 1),
        mkRun('0003', 'downloaded', true, 5),
        mkRun('0002', 'completed', false, 60),
        mkRun('0001', 'downloaded', true, 1440),
      ];
      for (const r of runs) await write('testRuns', `${r.testName}.json`, JSON.stringify(r));
      await write('testRuns', '0003.csv', csv);
      await write('testRuns', '0001.csv', csv);
    },
    { sample: SAMPLE, motion: MOTION, csv: buildCsv(), dirName: OPFS_DIR },
  );
}

/**
 * Start the in-page machine: a carriage that follows a trapezoid to its target
 * through a short drive lag, a force that rises with extension, both fed to the
 * live buffer at 100 Hz, and the device client's commands answered by it.
 */
async function startMachine(page, config) {
  await page.evaluate(async (config) => {
    const { useStore } = await import('/src/store/useStore.ts');
    const live = await import('/src/store/liveBuffer.ts');
    const { deviceClient } = await import('/src/device/session.ts');
    const sim = {
      pos: 62, cmd: 62, target: 62, v: 0, speed: 5, accel: config['Acceleration Max (mm/s^2)'],
      tau: 0.012, lengthZero: 50, forceZero: 0, load: 0, drift: 0, noiseN: 0.004, slack: 55, stiffness: 2.6,
    };
    window.__sim = sim;
    const gauss = () => {
      let u = 0;
      for (let i = 0; i < 6; i++) u += Math.random();
      return (u - 3) / Math.sqrt(0.5);
    };
    const sampleNow = () => {
      const force = Math.max(0, sim.pos - sim.slack) * sim.stiffness + sim.load + sim.drift + gauss() * sim.noiseN;
      return {
        'Machine Force (N)': force,
        'Machine Position (mm)': Math.round(sim.pos * 2400) / 2400,
        'Machine Setpoint (mm)': sim.target,
        'Machine Commanded (mm)': sim.cmd,
        'Sample Force (N)': force - sim.forceZero,
        'Sample Position (mm)': sim.pos - sim.lengthZero,
      };
    };
    const step = (dt) => {
      const remaining = sim.target - sim.cmd;
      const dir = Math.sign(remaining);
      const stopDist = (sim.v * sim.v) / (2 * sim.accel);
      if (Math.abs(remaining) < 1e-6 && Math.abs(sim.v) < sim.accel * dt) {
        sim.v = 0;
        sim.cmd = sim.target;
      } else if (Math.abs(remaining) <= stopDist + 1e-9) {
        sim.v -= Math.sign(sim.v) * sim.accel * dt;
      } else {
        sim.v += dir * sim.accel * dt;
        if (Math.abs(sim.v) > sim.speed) sim.v = dir * sim.speed;
      }
      const next = sim.cmd + sim.v * dt;
      sim.cmd = (sim.target - next) * dir < 0 ? sim.target : next;
      sim.pos += (sim.cmd - sim.pos) * (1 - Math.exp(-dt / sim.tau));
    };
    // A minute of history: two slow pulls, so the chart is not an empty sweep.
    const history = [];
    sim.speed = 12;
    sim.target = 170;
    for (let i = 0; i < 6000; i++) {
      if (i === 1500) sim.target = 90;
      if (i === 2700) sim.target = 190;
      if (i === 4500) sim.target = 62;
      step(0.01);
      history.push(sampleNow());
    }
    live.resetLiveBuffer();
    live.seedSamples(history, 10);
    let last = performance.now();
    let mirrored = 0;
    setInterval(() => {
      const now = performance.now();
      // Sub-step: a background tab's timer can run late, and the model must not skip.
      let dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      while (dt > 0) {
        const h = Math.min(0.002, dt);
        step(h);
        dt -= h;
      }
      const s = sampleNow();
      live.pushSample(s);
      if (now - mirrored > 250) {
        mirrored = now;
        useStore.setState({ latestSample: s });
      }
    }, 10);

    const move = (mm, speed) => {
      if (!useStore.getState().machineState?.motionEnabled) return Promise.resolve(false);
      sim.speed = Math.min(Math.abs(speed), config['Velocity Max (mm/s)']);
      sim.target += mm;
      return Promise.resolve(true);
    };
    deviceClient.manualMove = move;
    deviceClient.openLoopMove = move;
    deviceClient.setMotionEnabled = (enabled) => {
      const s = useStore.getState().machineState;
      const faulted = s && s.faultedReason !== 0;
      useStore.setState({
        machineState: { ...s, motionEnabled: enabled && !faulted, faultedReason: enabled ? s.faultedReason : 0 },
      });
      return Promise.resolve(!enabled || !faulted);
    };
    useStore.setState({
      refreshConfig: async () => {},
      saveConfig: async (c) => {
        useStore.setState({ config: c });
        return true;
      },
    });
  }, config);
}

/** Put the store into a state. `machine` is merged over an idle, enabled machine. */
async function setState(page, patch = {}, machine) {
  await page.evaluate(
    async ({ patch, machine, config }) => {
      const { useStore } = await import('/src/store/useStore.ts');
      const base = {
        connection: 'connected',
        responding: true,
        error: null,
        canReconnect: false,
        portLabel: 'USB 403:6001',
        firmwareVersion: '0.15',
        deviceProtocol: 4,
        firmwareCompat: { kind: 'ok' },
        config,
        notifications: [],
        updateReady: false,
        machineState: { faultedReason: 0, restrictedReason: 0, testRunning: false, motionEnabled: true },
      };
      const next = { ...base, ...patch };
      if (machine === null) next.machineState = null;
      else if (machine) next.machineState = { ...base.machineState, ...machine };
      useStore.setState(next);
    },
    { patch, machine, config: CONFIG },
  );
  await page.waitForTimeout(350);
}

const DISCONNECTED = {
  connection: 'disconnected',
  responding: false,
  portLabel: null,
  firmwareVersion: null,
  deviceProtocol: null,
  firmwareCompat: null,
  config: null,
};

const FAULTS = ['COG', 'WATCHDOG', 'ESD_POWER', 'ESD_SWITCH', 'ESD_UPPER', 'ESD_LOWER', 'SERVO_COMMUNICATION', 'FORCE_GAUGE_COMMUNICATION', 'SERVO_STALL', 'FORCE_OVERLOAD'];
const RESTRICTIONS = ['SAMPLE_LENGTH', 'SAMPLE_TENSION', 'MACHINE_TENSION', 'UPPER_ENDSTOP', 'LOWER_ENDSTOP', 'DOOR'];
const slug = (s) => s.toLowerCase().replace(/_/g, '-');

async function go(page, hash) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.waitForTimeout(500);
}

let taken = 0;
const failed = [];

/** Whole viewport, grown to `height` for screens taller than it. */
async function shot(page, name, { height } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  if (height) await page.setViewportSize({ width: VIEW_W, height });
  await page.waitForTimeout(height ? 900 : 400);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  if (height) await page.setViewportSize({ width: VIEW_W, height: VIEW_H });
  taken += 1;
  console.log(`  ✓ ${name}.png`);
}

/** The rectangle covering every given locator, plus a margin. */
async function shotOf(page, name, locators, { pad = 12, height } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  if (height) await page.setViewportSize({ width: VIEW_W, height });
  await page.waitForTimeout(height ? 700 : 250);
  let box = null;
  for (const l of locators) {
    await l.first().scrollIntoViewIfNeeded().catch(() => {});
    const b = await l.first().boundingBox();
    if (!b) throw new Error(`${name}: an element to capture is not on the page`);
    box = box
      ? {
          x: Math.min(box.x, b.x),
          y: Math.min(box.y, b.y),
          r: Math.max(box.r, b.x + b.width),
          b: Math.max(box.b, b.y + b.height),
        }
      : { x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height };
  }
  const view = page.viewportSize();
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    clip: { x, y, width: Math.min(view.width, box.r + pad) - x, height: Math.min(view.height, box.b + pad) - y },
  });
  if (height) await page.setViewportSize({ width: VIEW_W, height: VIEW_H });
  taken += 1;
  console.log(`  ✓ ${name}.png`);
}

async function safe(label, fn) {
  try {
    await fn();
  } catch (e) {
    failed.push(label);
    console.warn(`  ✗ ${label}: ${e.message.split('\n')[0]}`);
  }
}

const panel = (page, heading) => page.locator('.panel', { has: page.getByRole('heading', { name: heading, exact: true }) });

async function main() {
  if (!ONLY) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const server = await createServer({
    root: APP_ROOT,
    logLevel: 'error',
    server: { port: PORT, strictPort: true, open: false },
  });
  await server.listen();
  const APP_URL = `http://localhost:${PORT}/`;

  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: VIEW_W, height: VIEW_H },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.warn(`  [pageerror] ${e.message}`));
  await page.addInitScript(installBrowserFakes, { dirName: OPFS_DIR });
  // The recommended firmware release: fixed, so the shots do not depend on the network.
  await page.route('**/firmware/manifest.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        releases: [
          {
            tag: 'firmware-v0.15',
            version: '0.15',
            assetName: 'MaD-Firmware-0.15.bin',
            size: 187432,
            sha256: '0'.repeat(64),
            publishedAt: '2026-11-02T07:11:01Z',
            htmlUrl: 'https://github.com/RileyMcCarthy/MaD/releases/tag/firmware-v0.15',
            protocolVersion: 4,
            path: 'firmware/MaD-Firmware-0.15.bin',
          },
        ],
      }),
    }),
  );
  // window.confirm (the flash prompt) would block a headless page.
  page.on('dialog', (d) => void d.dismiss());

  console.log(`Capturing screenshots → ${OUT}`);
  const statusbar = page.locator('.statusbar');
  const banner = page.getByTestId('firmware-compat');

  // ---- First run: the data folder gate, then the Connect screen. ----
  await page.goto(`${APP_URL}#/connect`);
  await safe('data-folder-gate', async () => {
    await page.getByTestId('choose-data-folder').waitFor({ timeout: 20000 });
    await shot(page, 'data-folder-gate');
    await page.getByTestId('choose-data-folder').click();
    await page.getByTestId('connect-device').waitFor({ timeout: 10000 });
  });
  await seed(page);

  await safe('connect', async () => {
    await page.getByTestId('connect-granted').first().waitFor({ timeout: 8000 });
    await shot(page, 'connect');
    await go(page, '/live');
    await shot(page, 'live-disconnected');
    await go(page, '/firmware');
    await page.getByTestId('install-recommended').waitFor({ timeout: 15000 }).catch(() => {});
    await shot(page, 'firmware-disconnected');
  });

  // ---- Connected: the machine model takes over. ----
  await startMachine(page, CONFIG);
  await setState(page);

  await safe('connect-connected', async () => {
    await go(page, '/connect');
    await shot(page, 'connect-connected');
  });

  await safe('firmware', async () => {
    await go(page, '/firmware');
    await page.getByTestId('install-recommended').waitFor({ timeout: 15000 }).catch(() => {});
    await shot(page, 'firmware');
    await setState(page, { firmwareVersion: '0.14', deviceProtocol: 3, firmwareCompat: { kind: 'firmwareTooOld', deviceProtocol: 3, appProtocol: 4 } }, { motionEnabled: false });
    await shot(page, 'firmware-update-needed');
    await setState(page);
  });

  // ---- The firmware banner, one shot per verdict, on the Live screen. ----
  await safe('banners', async () => {
    await go(page, '/live');
    const verdicts = {
      'banner-checking': { firmwareCompat: { kind: 'checking' }, firmwareVersion: null, deviceProtocol: null },
      'banner-firmware-too-old': { firmwareVersion: '0.14', deviceProtocol: 3, firmwareCompat: { kind: 'firmwareTooOld', deviceProtocol: 3, appProtocol: 4 } },
      'banner-app-too-old': { firmwareVersion: '0.16', deviceProtocol: 5, firmwareCompat: { kind: 'appTooOld', deviceProtocol: 5, appProtocol: 4 } },
      'banner-update-recommended': { firmwareVersion: '0.15', firmwareCompat: { kind: 'belowMinFirmware', firmwareVersion: '0.15', minFirmware: '0.16' } },
      'banner-no-answer': { firmwareVersion: null, deviceProtocol: null, firmwareCompat: { kind: 'unanswered' } },
    };
    for (const [name, patch] of Object.entries(verdicts)) {
      const blocked = patch.firmwareCompat.kind !== 'belowMinFirmware';
      await setState(page, patch, { motionEnabled: !blocked });
      await shotOf(page, name, [statusbar, banner]);
    }
    // The whole screen while the app refuses to move the machine.
    await setState(page, verdicts['banner-firmware-too-old'], { motionEnabled: false });
    await shot(page, 'live-firmware-too-old');
    await setState(page);
  });

  // ---- The status bar. ----
  await safe('statusbar', async () => {
    await go(page, '/live');
    await shotOf(page, 'status-connected', [statusbar]);
    await setState(page, { responding: false, firmwareVersion: null }, null);
    await shotOf(page, 'status-not-responding', [statusbar]);
    await shotOf(page, 'live-waiting-for-state', [panel(page, 'State'), panel(page, 'Controls')]);
    await setState(page, { ...DISCONNECTED, canReconnect: true });
    await shotOf(page, 'status-disconnected-reconnect', [statusbar]);
    await go(page, '/connect');
    await shot(page, 'connect-link-lost');
    await setState(page, { ...DISCONNECTED, updateReady: true });
    await shotOf(page, 'status-update-ready', [statusbar]);
    await setState(page);
  });

  // ---- Live: the normal screen, then State + Controls in every machine state. ----
  await safe('live', async () => {
    await go(page, '/live');
    await page.locator('[data-testid="live-combined-chart"] canvas').first().waitFor({ timeout: 12000 });
    await page.locator('label.field', { hasText: 'Speed (mm/s)' }).locator('input').fill('4');
    await page.getByRole('button', { name: '+ Jog up' }).click();
    await page.waitForTimeout(2600);
    await shot(page, 'live', { height: 1340 });
    await shotOf(page, 'live-readouts', [panel(page, 'Readouts')]);
    await shotOf(page, 'live-controls', [panel(page, 'Controls')]);
    await shotOf(page, 'live-chart', [page.getByTestId('live-combined-chart')], { height: 1340 });
  });

  await safe('machine-states', async () => {
    await go(page, '/live');
    const both = [panel(page, 'State'), panel(page, 'Controls')];
    await setState(page, {}, { motionEnabled: false });
    await shotOf(page, 'state-disabled', both);
    await setState(page, {}, { motionEnabled: true });
    await shotOf(page, 'state-manual', both);
    await setState(page, {}, { motionEnabled: true, testRunning: true });
    await shotOf(page, 'state-test', both);
    for (const [i, name] of RESTRICTIONS.entries()) {
      await setState(page, {}, { restrictedReason: i + 1 });
      await shotOf(page, `restriction-${slug(name)}`, both);
    }
    for (const [i, name] of FAULTS.entries()) {
      await setState(page, {}, { faultedReason: i + 1, motionEnabled: false });
      await shotOf(page, `fault-${slug(name)}`, both);
    }
    // What a refused jog looks like.
    await setState(page, {}, { motionEnabled: false });
    await page.getByRole('button', { name: '+ Jog up' }).click();
    await page.locator('.toasts > *').first().waitFor({ timeout: 4000 });
    await shotOf(page, 'toast-jog-rejected', [page.locator('.toasts')]);
    await setState(page);
  });

  // ---- Settings: data folder, configuration, calibration. ----
  await safe('settings', async () => {
    await go(page, '/settings');
    await page.getByText(/Current:/).waitFor({ timeout: 10000 });
    await shot(page, 'settings', { height: 2100 });
    await shotOf(page, 'settings-data-folder', [panel(page, 'Data folder')]);
    await shotOf(page, 'settings-machine-configuration', [panel(page, 'Machine configuration')], { height: 1400 });
    await shotOf(page, 'motor-calibration', [panel(page, 'Motor calibration')], { height: 2100 });
    await shotOf(page, 'load-cell-calibration', [panel(page, 'Load cell calibration')], { height: 2100 });
  });

  await safe('motor-calibration-run', async () => {
    await go(page, '/settings');
    const motor = panel(page, 'Motor calibration');
    await motor.getByRole('button', { name: 'Run check' }).click();
    await page.waitForTimeout(1500);
    await shotOf(page, 'motor-calibration-check-running', [motor], { height: 2100 });
    await page.getByTestId('calibration-result').waitFor({ timeout: 90000 });
    await shotOf(page, 'motor-calibration-check-result', [motor], { height: 2400 });
    await motor.getByRole('button', { name: 'Run motion calibration' }).click();
    await page.getByTestId('motion-result').waitFor({ timeout: 240000 });
    await shotOf(page, 'motor-calibration-motion-result', [page.getByTestId('motion-result')], { height: 3000 });
  });

  await safe('motor-calibration-mismatch', async () => {
    // The drive is set finer than Servo (step/mm) says: the encoder sees more travel.
    await go(page, '/live');
    await go(page, '/settings');
    await page.evaluate(async () => {
      const { deviceClient } = await import('/src/device/session.ts');
      const plain = deviceClient.openLoopMove;
      deviceClient.openLoopMove = (mm, speed) => plain(mm * 1.25, speed * 1.25);
      window.__restoreOpenLoop = () => {
        deviceClient.openLoopMove = plain;
      };
    });
    const motor = panel(page, 'Motor calibration');
    await motor.getByRole('button', { name: 'Run check' }).click();
    await page.getByTestId('calibration-result').waitFor({ timeout: 90000 });
    await shotOf(page, 'motor-calibration-check-mismatch', [page.getByTestId('calibration-result')], { height: 2400 });
    await page.evaluate(() => window.__restoreOpenLoop());
  });

  await safe('load-cell-run', async () => {
    await go(page, '/live');
    await go(page, '/settings');
    const cell = panel(page, 'Load cell calibration');
    // Nothing on the load cell; the true zero sits a little off the saved one.
    await page.evaluate(() => {
      Object.assign(window.__sim, { load: 0.42, noiseN: 0.012, target: 40, speed: 20 });
    });
    await page.waitForTimeout(2500);
    await cell.getByRole('button', { name: 'Read zero' }).click();
    await page.getByTestId('zero-result').waitFor({ timeout: 15000 });
    await shotOf(page, 'load-cell-zero-result', [page.getByTestId('zero-result')], { height: 2400 });
    await cell.getByRole('button', { name: /Read unloaded/ }).click();
    await page.getByTestId('sensitivity-unloaded').waitFor({ timeout: 15000 });
    // Known weights; the load cell reads 1.6% low against its saved sensitivity.
    for (const kg of [1, 2, 5]) {
      await page.evaluate((kg) => {
        window.__sim.load = 0.42 + kg * 9.80665 * 0.984;
      }, kg);
      await cell.locator('label.field', { hasText: 'Mass (kg)' }).locator('input').fill(String(kg));
      await page.waitForTimeout(600);
      const rows = await page.getByRole('button', { name: 'Remove' }).count();
      await cell.getByRole('button', { name: /Read with weight/ }).click();
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="sensitivity-result"] tbody tr').length > n, rows, { timeout: 15000 });
    }
    await shotOf(page, 'load-cell-sensitivity-result', [page.getByTestId('sensitivity-result')], { height: 2600 });
    await page.evaluate(() => {
      Object.assign(window.__sim, { load: 0, noiseN: 0.004, target: 62 });
    });
  });

  // ---- Profiles, runs, results. ----
  await safe('samples', async () => {
    await go(page, '/profiles');
    await page.waitForTimeout(600);
    const load = page.getByRole('button', { name: /^Load$/ }).first();
    if (await load.count()) await load.click().catch(() => {});
    await shot(page, 'sample-profiles', { height: 1000 });
  });

  await safe('motion-profiles', async () => {
    await go(page, '/create');
    await page.waitForTimeout(600);
    const loadSel = page.locator('select').filter({ has: page.getByRole('option', { name: /Load saved profile/i }) });
    await loadSel.selectOption({ index: 1 }).catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, 'motion-profiles', { height: 1500 });
    await page.getByRole('button', { name: /Preview G-code/i }).first().click();
    await page.getByRole('heading', { name: 'Generated G-code & Motion' }).waitFor({ timeout: 5000 });
    await page.waitForTimeout(600);
    await shot(page, 'gcode-preview');
    await page.keyboard.press('Escape').catch(() => {});
  });

  await safe('test-runs', async () => {
    await go(page, '/runs');
    await page.waitForTimeout(800);
    const runner = panel(page, 'New test');
    await runner.locator('select').nth(0).selectOption({ index: 1 }).catch(() => {});
    await runner.locator('select').nth(1).selectOption({ index: 1 }).catch(() => {});
    await shot(page, 'test-runs', { height: 1150 });
    await shotOf(page, 'test-runs-new-test', [runner]);
    await shotOf(page, 'test-runs-history', [panel(page, 'History')], { height: 1150 });
  });

  await safe('run-viewer', async () => {
    await go(page, '/view/0003');
    await page.locator('[data-testid="chart-force"] canvas').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    await shot(page, 'run-viewer', { height: 1850 });
  });

  await safe('about', async () => {
    await go(page, '/about');
    await page.getByTestId('app-version').waitFor({ timeout: 8000 });
    await shot(page, 'about', { height: 1100 });
  });

  await browser.close();
  await server.close();
  console.log(`Done: ${taken} screenshots${failed.length ? `, ${failed.length} group(s) failed: ${failed.join(', ')}` : ''}.`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
