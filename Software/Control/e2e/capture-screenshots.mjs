/**
 * Documentation screenshot capture.
 *
 * Drives the *real* Control UI against the live SIL emulator (via the
 * same fake-serial harness the e2e suite uses) and saves a labelled PNG of every
 * screen + key modal into docs/assets/screenshots/. These images are embedded in
 * the docs site (mkdocs) user guide.
 *
 * Prereqs (each in its own terminal), exactly like the e2e suite:
 *   cd SIL && make playground        # emulator on /tmp/tty.rpi
 *   npm run sil:bridge               # WS bridge on ws://localhost:9999
 *   npm run dev                      # app on http://localhost:5174
 * Then: npm run docs:screenshots
 *
 * Data-bearing screens (Samples, Motion Profiles, Test Runs, Run Viewer) are
 * populated by seeding realistic profiles + a finished run straight into the
 * OPFS data folder (the e2e pattern), so the shots are deterministic and don't
 * depend on a flaky live test. The Live screen uses genuine streamed samples
 * from the connected emulator.
 */

import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { installFakeSerial, installOpfsDataDir, APP_URL, BRIDGE_URL, OPFS_DIR } from './fixtures.mjs';

const require = createRequire('/Users/rileymccarthy/Documents/MaD/SIL/');
const { chromium } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOT_DIR || resolve(HERE, '../../../docs/assets/screenshots');

/** Realistic seed data so the editors/history/charts look populated. */
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

/** Build a cyclic load/unload CSV (firmware-native units: µs, mN, µm). */
function buildCsv() {
  const rows = ['time_us,force_mN,position_um,setpoint_um'];
  const gauge = 10000; // µm
  let t = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i <= 40; i++) {
      // triangle position 0→20→0 mm over the cycle, force grows past ~5 mm slack
      const phase = i / 40;
      const posMm = phase < 0.5 ? phase * 2 * 20 : (1 - phase) * 2 * 20;
      const pos = gauge + posMm * 1000;
      const stretch = Math.max(0, posMm - 5);
      const force = stretch * 380; // mN, ~ up to ~5.7 N
      rows.push(`${t},${Math.round(force)},${Math.round(pos)},${Math.round(pos)}`);
      t += 50000;
    }
  }
  return rows.join('\n');
}

async function seed(page) {
  const csv = buildCsv();
  await page.evaluate(
    async ({ sample, motion, csv }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('mad-e2e', { create: true });
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
      // Most-recent first by startedAt; one downloaded (viewable), one completed, one running.
      const runs = [
        mkRun('0003', 'downloaded', true, 5),
        mkRun('0002', 'completed', false, 60),
        mkRun('0001', 'downloaded', true, 1440),
      ];
      for (const r of runs) await write('testRuns', `${r.testName}.json`, JSON.stringify(r));
      await write('testRuns', '0003.csv', csv);
      await write('testRuns', '0001.csv', csv);
    },
    { sample: SAMPLE, motion: MOTION, csv },
  );
}

async function connect(page) {
  await page.goto(`${APP_URL}#/connect`);
  await page.getByTestId('connect-granted').first().waitFor({ timeout: 8000 }).catch(() => {});
  // Prefer the granted-port row; fall back to the primary connect button.
  const granted = page.getByTestId('connect-granted').first();
  if (await granted.count()) await granted.click();
  else await page.getByTestId('connect-device').click();
  await page.locator('.dot.connected').waitFor({ timeout: 12000 });
  // Wait until firmware actually responds (samples flowing).
  const resp = page.getByTestId('responding');
  for (let i = 0; i < 40; i++) {
    const txt = (await resp.textContent().catch(() => '')) || '';
    if (txt.includes('Responding') && !txt.includes('Not')) break;
    await page.waitForTimeout(250);
  }
}

async function chooseFolder(page) {
  await page.goto(`${APP_URL}#/settings`);
  await page.getByRole('button', { name: /Choose folder/i }).click();
  await page.getByText(/Current:/).waitFor({ timeout: 10000 });
}

const VIEW_W = 1440;
const VIEW_H = 900;

async function shot(page, name, { full = false, height } = {}) {
  const path = join(OUT, `${name}.png`);
  // The app shell is height:100vh with an internally-scrolling <main>, so a
  // plain fullPage shot still clips to the viewport. For tall screens, grow the
  // viewport (which the flex layout fills) so all content is captured, then
  // restore. Charts re-fit to the larger container.
  if (height) await page.setViewportSize({ width: VIEW_W, height });
  await page.waitForTimeout(height ? 900 : 500); // settle layout / chart re-fit
  await page.screenshot({ path, fullPage: full });
  if (height) await page.setViewportSize({ width: VIEW_W, height: VIEW_H });
  console.log(`  ✓ ${name}.png`);
}

async function safe(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.warn(`  ✗ ${label}: ${e.message}`);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.warn(`  [pageerror] ${e.message}`));
  await page.addInitScript(installFakeSerial, BRIDGE_URL);
  await page.addInitScript(installOpfsDataDir, OPFS_DIR);

  console.log(`Capturing screenshots → ${OUT}`);

  // 1. Connect screen (pre-connect: baud + granted ports + Connect).
  await safe('connect', async () => {
    await page.goto(`${APP_URL}#/connect`);
    await page.getByTestId('connect-device').waitFor({ timeout: 8000 });
    await shot(page, '01-connect');
  });

  // Connect to the emulator for the live/connected shots.
  await safe('connect-flow', () => connect(page));
  await safe('connect-connected', async () => {
    await page.goto(`${APP_URL}#/connect`);
    await page.locator('.dot.connected').waitFor({ timeout: 8000 });
    await shot(page, '01b-connect-connected');
  });

  // Choose the OPFS data folder, then seed realistic profiles + runs.
  await safe('choose-folder', () => chooseFolder(page));
  await safe('seed', () => seed(page));

  // 2. Live monitoring — real streamed samples; enable motion + jog for movement.
  await safe('live', async () => {
    await page.goto(`${APP_URL}#/live`);
    await page.locator('[data-testid="live-combined-chart"] canvas').first().waitFor({ timeout: 12000 });
    const enable = page.getByRole('button', { name: 'Enable motion' });
    if (await enable.count()) await enable.click().catch(() => {});
    await page.getByText('Motion: enabled').waitFor({ timeout: 8000 }).catch(() => {});
    await safe('jog', async () => {
      await page.locator('label.field', { hasText: 'Speed (mm/s)' }).locator('input').fill('20');
      await page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input').fill('10');
      await page.getByRole('button', { name: '+ Jog up' }).click();
    });
    await page.waitForTimeout(3500); // let the chart accumulate a sweep
    await shot(page, '02-live', { height: 1300 });
  });

  // 3. Samples (sample profile editor) — populated from the seeded profile list.
  await safe('samples', async () => {
    await page.goto(`${APP_URL}#/profiles`);
    await page.waitForTimeout(800);
    // Load the seeded sample into the editor if a Load control exists.
    const load = page.getByRole('button', { name: /^Load$/ }).first();
    if (await load.count()) await load.click().catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, '03-samples', { height: 1150 });
  });

  // 4. Motion Profiles (builder) — load the seeded multi-set profile.
  await safe('motion-profiles', async () => {
    await page.goto(`${APP_URL}#/create`);
    await page.waitForTimeout(800);
    // Target the "Load saved profile…" select specifically (not the move-type
    // dropdowns), then pick the first saved profile.
    const loadSel = page
      .locator('select')
      .filter({ has: page.getByRole('option', { name: /Load saved profile/i }) });
    await loadSel.selectOption({ index: 1 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, '04-motion-profiles', { height: 1500 });
    // G-code preview modal.
    await safe('gcode-preview', async () => {
      await page.getByRole('button', { name: /Preview G-code/i }).first().click();
      await page.getByRole('heading', { name: 'Generated G-code & Motion' }).waitFor({ timeout: 5000 });
      await page.waitForTimeout(700);
      await shot(page, '05-gcode-preview');
      await page.keyboard.press('Escape').catch(() => {});
    });
  });

  // 5. Test Runs — runner (seeded profiles selectable) + history table.
  await safe('test-runs', async () => {
    await page.goto(`${APP_URL}#/runs`);
    await page.waitForTimeout(800);
    const runner = page.locator('.panel', { hasText: 'New Test' });
    await runner.locator('select').nth(0).selectOption({ index: 1 }).catch(() => {});
    await runner.locator('select').nth(1).selectOption({ index: 1 }).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, '06-test-runs', { height: 1250 });
  });

  // 6. Run Viewer — analysis charts for the seeded downloaded run.
  await safe('run-viewer', async () => {
    await page.goto(`${APP_URL}#/view/0003`);
    await page.locator('[data-testid="chart-force"] canvas').first().waitFor({ timeout: 10000 });
    await page.locator('[data-testid="chart-stress-strain"] canvas').first().waitFor({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, '07-run-viewer', { height: 1850 });
  });

  // 7. Settings — data folder + machine configuration (loaded from device).
  await safe('settings', async () => {
    await page.goto(`${APP_URL}#/settings`);
    await page.getByText(/Current:/).waitFor({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, '08-settings', { height: 1400 });
  });

  // 8. Firmware / About — version + diagnostics export.
  await safe('about', async () => {
    await page.goto(`${APP_URL}#/about`);
    await page.getByTestId('fw-version').waitFor({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, '09-firmware', { full: true });
  });

  await browser.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
