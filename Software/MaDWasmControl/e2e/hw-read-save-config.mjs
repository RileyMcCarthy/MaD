/**
 * Drive the REAL app in real Chrome against ACTUAL P2 hardware (via
 * tools/hw-ws-bridge.mjs) and exercise reading + saving a machine profile
 * through the Settings → Machine configuration UI.
 *
 *   Terminal 1:  MAD_SERIAL=/dev/cu.usbserial-XXXX npm run hw:bridge
 *   Terminal 2:  npm run dev
 *   Then:        node e2e/hw-read-save-config.mjs          # read only
 *                MAD_DO_SAVE=1 node e2e/hw-read-save-config.mjs   # read + save round-trip
 *
 * Set HEADED=1 to watch the browser.
 */
import { newSilPage, connectToSil, APP_URL } from './fixtures.mjs';

const DO_SAVE = process.env.MAD_DO_SAVE === '1';
const HEADED = process.env.HEADED === '1';

const fieldInput = (page, label) =>
  page.locator('label.field', { hasText: label }).locator('input');

const NUMERIC_LABELS = [
  'Encoder (step/mm)',
  'Servo (step/mm)',
  'Load Cell Capacity (N)',
  'Load Cell Sensitivity (nV/V)',
  'Load Cell Zero Balance (nV/V)',
  'Position Max (mm)',
  'Velocity Max (mm/s)',
  'Acceleration Max (mm/s^2)',
  'Tensile Force Max (N)',
  'Homing Velocity (mm/s)',
  'Homing Offset (mm)',
  'Jaw Offset (mm)',
];

async function readProfile(page) {
  const out = {};
  out.Name = await fieldInput(page, 'Name').inputValue();
  for (const label of NUMERIC_LABELS) {
    // Numeric fields share the substring of some others ("Force Gauge" etc.),
    // so match on the exact label text node.
    out[label] = await page
      .locator('label.field')
      .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm') })
      .locator('input')
      .first()
      .inputValue();
  }
  return out;
}

/** Click "Reload from device" and wait until the Name field has a value,
 *  retrying to ride out the board's reboot-on-connect + SD mount. */
async function reloadUntilLoaded(page, { tries = 12, gapMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    await page.getByRole('button', { name: /Reload from device/i }).click().catch(() => {});
    try {
      await fieldInput(page, 'Name').waitFor({ state: 'visible', timeout: 1200 });
      const v = await fieldInput(page, 'Name').inputValue();
      if (v && v.trim().length > 0) return true;
    } catch {
      /* not ready yet */
    }
    await page.waitForTimeout(gapMs);
  }
  return false;
}

const main = async () => {
  const { browser, page, errors } = await newSilPage({ headed: HEADED });
  try {
    console.log('[hw] connecting to device (opens serial → resets board)…');
    await connectToSil(page);
    console.log('[hw] UI reports connected. Giving the board a moment to boot…');
    await page.waitForTimeout(3500);

    await page.goto(`${APP_URL}#/settings`);
    const loaded = await reloadUntilLoaded(page);
    if (!loaded) {
      console.error('[hw] FAILED to read a machine profile — Name never populated.');
      console.error('[hw]   → firmware likely not responding (not flashed/booted, or wrong link).');
      console.error('[hw] page errors:', errors);
      process.exitCode = 2;
      return;
    }

    const original = await readProfile(page);
    console.log('\n[hw] ===== READ machine profile from device =====');
    console.log(JSON.stringify(original, null, 2));

    if (!DO_SAVE) {
      console.log('\n[hw] read-only run complete (set MAD_DO_SAVE=1 to test saving).');
      return;
    }

    // ---- SAVE round-trip: tweak Name, save, reload, verify, restore. ----
    const stamp = `RWtest-${original.Name}`.slice(0, 20);
    console.log(`\n[hw] ===== SAVE: setting Name → "${stamp}" =====`);
    const nameInput = fieldInput(page, 'Name');

    // saveViaUI: clear + type the Name char-by-char (reliably drives a React
    // controlled input's onChange), verify the input committed, then Save.
    const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
    const saveViaUI = async (value) => {
      await nameInput.click();
      await page.keyboard.press(selectAll);
      await page.keyboard.press('Backspace');
      await nameInput.pressSequentially(value, { delay: 15 });
      await page.waitForTimeout(150);
      const shown = await nameInput.inputValue();
      if (shown !== value) console.log(`[hw]   WARN: input shows "${shown}", expected "${value}"`);
      await page.getByRole('button', { name: /Save to device/i }).click();
      await page.getByText(/Saved to device\.|Device rejected/i).waitFor({ timeout: 8000 });
      return (await page.getByText(/Saved to device\.|Device rejected/i).textContent())?.trim();
    };

    // readBackViaUI: scribble a sentinel into the field, then Reload from device —
    // a real device read replaces the sentinel, so we can't pass on a stale value.
    const readBackViaUI = async () => {
      await page.waitForTimeout(400);
      await nameInput.fill('__pending__');
      await page.getByRole('button', { name: /Reload from device/i }).click();
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(600);
        if ((await nameInput.inputValue()) !== '__pending__') break;
        await page.getByRole('button', { name: /Reload from device/i }).click().catch(() => {});
      }
      return readProfile(page);
    };

    const saveMsg = await saveViaUI(stamp);
    console.log(`[hw] save result: "${saveMsg}"`);
    const afterSave = await readBackViaUI();
    const persisted = afterSave.Name === stamp;
    console.log(`[hw] reloaded Name = "${afterSave.Name}"  → persisted: ${persisted ? 'YES' : 'NO'}`);

    // Restore the original name so we leave the machine as we found it.
    console.log(`[hw] ===== RESTORE: setting Name → "${original.Name}" =====`);
    await saveViaUI(original.Name);
    const restored = await readBackViaUI();
    console.log(`[hw] restored Name = "${restored.Name}"  → ${restored.Name === original.Name ? 'OK' : 'MISMATCH'}`);

    console.log('\n[hw] ===== SAVE round-trip complete =====');
    console.log(`[hw] read OK · save ${persisted ? 'OK' : 'FAILED'} · restore ${restored.Name === original.Name ? 'OK' : 'FAILED'}`);
    if (!persisted) process.exitCode = 3;
  } finally {
    if (errors.length) console.log('[hw] page errors during run:', errors);
    await browser.close();
  }
};

main().catch((e) => {
  console.error('[hw] fatal:', e);
  process.exit(1);
});
