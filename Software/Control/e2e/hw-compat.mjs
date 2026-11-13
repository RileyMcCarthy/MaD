/**
 * Bench test of the firmware-compatibility handshake on ACTUAL P2 hardware,
 * through the app's screens: a board running firmware this app cannot drive
 * is refused motion, offered the recommended firmware, updated with one
 * click, and driven once it reconnects.
 *
 * Needs a single-port board (the Prop Plug, or a P2-EVAL's own USB, whose DTR
 * resets the chip) running firmware from before the handshake, such as
 * firmware-v0.14's `-release.bin` (flash it first with e2e/hw-flash.mjs), and
 * an app whose `firmware/manifest.json` lists a release for its protocol:
 *
 *   Terminal 1:  MAD_SERIAL=/dev/cu.usbserial-XXXX node tools/hw-ws-bridge.mjs
 *   Terminal 2:  npm run dev     (MAD_FIRMWARE_RELEASE=off with the release
 *                                 under public/firmware/ serves a local build)
 *   Then:        node e2e/hw-compat.mjs
 *
 * Each step prints what it saw. The jog is MAD_JOG_MM (0.5) at 1 mm/s;
 * MAD_JOG_MM=0 skips it. Motion is disabled at the end, however it ends.
 * HEADED=1 shows the browser.
 */
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { newSilPage, connectToSil, readAppLog, APP_URL } from './fixtures.mjs';

const HEADED = process.env.HEADED === '1';
const JOG_MM = Number(process.env.MAD_JOG_MM ?? 0.5);
const FLASH_TIMEOUT_MS = Number(process.env.MAD_FLASH_TIMEOUT_MS || 180_000);

const step = (n, text) => console.log(`[hw-compat] ${n}. ${text}`);
const text = async (locator) => ((await locator.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();

const { browser, page, errors } = await newSilPage({ headed: HEADED });
page.on('dialog', (d) => {
  console.log(`[hw-compat]    confirm: ${d.message().split('\n')[0]}`);
  void d.accept();
});
const banner = page.getByTestId('firmware-compat');
/** The banner once the firmware has answered (or been given up on). */
const verdictBanner = page.locator('[data-testid="firmware-compat"]:not([data-kind="checking"])');
let ok = false;
try {
  // 1. Connect to the board as it is.
  await connectToSil(page);
  await verdictBanner.waitFor({ timeout: 30_000 });
  step(1, `connected; banner: "${await text(verdictBanner)}"`);
  await page.goto(`${APP_URL}#/firmware`);
  step(1, `Installed: ${await text(page.getByTestId('fw-version'))}; Protocol: ${await text(page.getByTestId('fw-protocol'))}`);

  // 2. Motion is refused.
  await page.goto(`${APP_URL}#/control`);
  await page.getByText(/Motion: (enabled|disabled)/).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Enable motion' }).click();
  // The refusal's own toast; another may already be up about unreadable replies.
  const toast = page.locator('.toast').getByText(/too old|newer than this version/).first();
  await toast.waitFor({ timeout: 5000 });
  await page.waitForTimeout(1500);
  const motion = await text(page.getByText(/^Motion: /));
  if (motion !== 'Motion: disabled') throw new Error(`motion was not refused (${motion})`);
  step(2, `Enable motion refused; toast: "${await text(toast)}"; badge still "${motion}"`);

  // 3. Install the recommended firmware.
  await page.goto(`${APP_URL}#/firmware`);
  const install = page.getByTestId('install-recommended');
  await install.waitFor({ timeout: 15_000 });
  step(3, `Recommended: ${await text(page.getByTestId('fw-latest'))}; clicking "${await text(install)}"`);
  const started = Date.now();
  await install.click();
  const status = page.getByTestId('flash-status');
  let last = '';
  for (;;) {
    const now = await text(status);
    if (now !== last) console.log(`[hw-compat]    ${((Date.now() - started) / 1000).toFixed(1)}s ${now}`);
    last = now;
    if (await page.locator('[data-testid="flash-status"].error').count()) throw new Error(now);
    if (/Wrote .* bytes to flash/.test(now)) break;
    if (Date.now() - started > FLASH_TIMEOUT_MS) throw new Error(`flash did not finish in ${FLASH_TIMEOUT_MS} ms`);
    await page.waitForTimeout(250);
  }

  // 4. The app reconnects to the new firmware and asks again.
  const matched = page.getByTestId('fw-protocol').filter({ hasText: /^(\d+) · this app speaks \1$/ });
  const verdict = async (ms) => matched.waitFor({ timeout: ms }).then(() => true, () => false);
  if (!(await verdict(45_000))) {
    // The board may still have been booting when the app asked: ask again.
    step(4, 'no verdict after the reconnect; reconnecting once');
    await page.goto(`${APP_URL}#/connect`);
    await page.getByRole('button', { name: 'Disconnect' }).click().catch(() => {});
    await page.locator('.dot.disconnected').waitFor({ timeout: 10_000 });
    await connectToSil(page);
    await page.goto(`${APP_URL}#/firmware`);
    if (!(await verdict(30_000))) throw new Error(`no ok verdict after the update (Protocol: ${await text(page.getByTestId('fw-protocol'))})`);
  }
  const bannerLeft = (await banner.count()) === 0;
  step(4, `reconnected; Installed: ${await text(page.getByTestId('fw-version'))}; Protocol: ${await text(page.getByTestId('fw-protocol'))}; banner ${bannerLeft ? 'gone' : `still shown: "${await text(banner)}"`}`);
  if (!bannerLeft) throw new Error('the banner stayed after the update');

  // 5. Motion works.
  await page.goto(`${APP_URL}#/control`);
  await page.getByText(/Motion: (enabled|disabled)/).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Enable motion' }).click();
  await page.getByText('Motion: enabled').waitFor({ timeout: 10_000 });
  step(5, 'Enable motion accepted: "Motion: enabled"');
  if (JOG_MM > 0) {
    const position = async () =>
      parseFloat(await text(page.locator('.readout', { hasText: 'Machine Position' }).locator('.value').first()));
    await page.locator('label.field', { hasText: 'Jog (mm)' }).locator('input').fill(String(JOG_MM));
    await page.locator('label.field', { hasText: 'Speed (mm/s)' }).locator('input').fill('1');
    const before = await position();
    await page.getByRole('button', { name: '+ Jog up' }).click();
    let moved = NaN;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(250);
      moved = (await position()) - before;
      if (Math.abs(moved - JOG_MM) < 0.05) break;
    }
    step(5, `jog +${JOG_MM} mm at 1 mm/s: position moved ${moved.toFixed(4)} mm (from ${before} mm)`);
    if (!(Math.abs(moved - JOG_MM) < 0.1)) throw new Error(`the jog moved ${moved} mm, expected ${JOG_MM}`);
  }
  ok = true;
} catch (err) {
  console.error('[hw-compat] FAILED:', err instanceof Error ? err.message : err);
} finally {
  // Leave the machine with motion off.
  try {
    await page.goto(`${APP_URL}#/control`);
    const disable = page.getByRole('button', { name: 'Disable motion' });
    if (await disable.count()) {
      await disable.click();
      await page.getByText('Motion: disabled').waitFor({ timeout: 5000 });
      console.log('[hw-compat]    motion disabled');
    }
  } catch {
    /* not connected: nothing to disable */
  }
  const log = await readAppLog(page);
  if (log) {
    const out = resolve(process.env.MAD_LOG_OUT ?? 'e2e/artifacts/hw-compat.log.json');
    writeFileSync(out, JSON.stringify(log, null, 1));
    console.log(`[hw-compat] app log: ${out}`);
  }
  if (errors.length) console.log('[hw-compat] page errors:', errors);
  await browser.close();
}
process.exit(ok ? 0 : 1);
