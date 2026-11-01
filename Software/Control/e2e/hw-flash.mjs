/**
 * Flash a firmware image to ACTUAL P2 hardware through the app's Firmware
 * screen, then connect and read the version back — the UI path a user takes.
 *
 * Needs a single-port board: the Prop Plug's DTR resets the chip, and the
 * production build (`pio run -e propeller2`, or a release's
 * `MaD-Firmware-<v>-release.bin`, the image the app flashes by default)
 * answers the protocol on the same P62/P63 pins. A `-madEdge.bin` image puts
 * the protocol on P53/P55, so the version read-back here would fail.
 *
 *   Terminal 1:  MAD_SERIAL=/dev/cu.usbserial-XXXX node tools/hw-ws-bridge.mjs
 *   Terminal 2:  npm run dev
 *   Then:        MAD_FIRMWARE=../../Firmware/MaDCore/.pio/build/propeller2/program \
 *                  node e2e/hw-flash.mjs
 *
 * Set HEADED=1 to watch the browser.
 */
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { newSilPage, connectToSil, readAppLog, APP_URL } from './fixtures.mjs';

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

  // The board rebooted into the new image; give it time to mount SD and boot.
  await page.waitForTimeout(3000);
  await connectToSil(page);
  await page.goto(`${APP_URL}#/firmware`);
  const version = page.getByTestId('fw-version');
  const deadline = Date.now() + 20_000;
  let text = '';
  while (Date.now() < deadline) {
    text = ((await version.textContent()) ?? '').trim();
    if (text && !text.startsWith('—') && text !== 'Unknown') break;
    await page.waitForTimeout(500);
  }
  console.log(`[hw-flash] firmware version after flash: ${text}`);
  ok = text !== '' && !text.startsWith('—') && text !== 'Unknown';
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
