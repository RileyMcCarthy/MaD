/**
 * Flash a firmware image to ACTUAL P2 hardware through the app's Firmware
 * screen — the UI path a user takes — over the programming port.
 *
 * The bridge's adapter must be the programming port: a Prop Plug on header
 * J1, or the P2-EVAL's own USB, whose DTR resets the chip into its boot ROM.
 * The firmware (`pio run -e MaD`, or a release's `MaD-Firmware-<v>.bin`)
 * answers the protocol only on the control port (P30/P32), so this script
 * does not read the version back: connect a second adapter there and use the
 * Connect page (or hw-read-save-config.mjs over a bridge on that adapter).
 *
 *   Terminal 1:  MAD_SERIAL=/dev/cu.usbserial-XXXX node tools/hw-ws-bridge.mjs
 *   Terminal 2:  npm run dev
 *   Then:        MAD_FIRMWARE=../../Firmware/MaDCore/.pio/build/MaD/program \
 *                  node e2e/hw-flash.mjs
 *
 * Set HEADED=1 to watch the browser.
 */
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { newSilPage, readAppLog, APP_URL } from './fixtures.mjs';

const FIRMWARE = resolve(process.env.MAD_FIRMWARE ?? '');
const HEADED = process.env.HEADED === '1';
/** A 300 KB image at 2 Mbaud is a few seconds; the ROM detect retries add more. */
const FLASH_TIMEOUT_MS = Number(process.env.MAD_FLASH_TIMEOUT_MS || 120_000);

if (!process.env.MAD_FIRMWARE || !existsSync(FIRMWARE)) {
  console.error(`MAD_FIRMWARE must name a built image (got "${process.env.MAD_FIRMWARE ?? ''}")`);
  process.exit(2);
}

const { browser, page, errors } = await newSilPage({ headed: HEADED });
let ok = false;
try {
  await page.goto(`${APP_URL}#/firmware`);
  await page.getByTestId('choose-flash-port').click();
  await page.getByTestId('firmware-file').setInputFiles(FIRMWARE);
  console.log('[hw-flash] target:', (await page.getByTestId('flash-target').textContent())?.trim());

  page.once('dialog', (d) => {
    console.log('[hw-flash] confirm:', d.message().split('\n')[0]);
    void d.accept();
  });
  const started = Date.now();
  await page.getByTestId('flash-firmware').click();

  // Running shows progress; the done and error states each replace it.
  const status = page.getByTestId('flash-status');
  let last = '';
  for (;;) {
    const text = ((await status.textContent().catch(() => '')) ?? '').trim();
    if (text !== last) console.log(`[hw-flash] ${((Date.now() - started) / 1000).toFixed(1)}s ${text}`);
    last = text;
    if (await page.locator('[data-testid="flash-status"].error').count()) throw new Error(text);
    if (/Wrote .* bytes to flash/.test(text)) break;
    if (Date.now() - started > FLASH_TIMEOUT_MS) throw new Error(`flash did not finish in ${FLASH_TIMEOUT_MS} ms`);
    await page.waitForTimeout(250);
  }

  ok = true;
} catch (err) {
  console.error('[hw-flash] FAILED:', err instanceof Error ? err.message : err);
} finally {
  const log = await readAppLog(page);
  if (log) {
    const out = resolve(process.env.MAD_LOG_OUT ?? 'e2e/artifacts/hw-flash.log.json');
    writeFileSync(out, JSON.stringify(log, null, 1));
    console.log(`[hw-flash] app log: ${out}`);
  }
  if (errors.length) console.log('[hw-flash] page errors:', errors);
  await browser.close();
}
process.exit(ok ? 0 : 1);
