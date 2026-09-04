/**
 * Interactive SIL session: opens a real Chrome window with the SIL emulator
 * abstracted behind a fake `navigator.serial` (backed by the WS↔PTY bridge),
 * then leaves it open so you can drive the app by hand. The app itself is
 * unmodified — it only ever uses Web Serial.
 *
 * Prereqs (each in its own terminal):
 *   cd SIL && make e2e-emulator        # emulator on /tmp/tty.rpi (unpaced virtual time)
 *   npm run sil:bridge               # WS bridge on ws://localhost:9999
 *   npm run dev                      # app on http://localhost:5174
 * Then: npm run sil:app   (or: node e2e/sil-playground.mjs)
 *
 * Reuses Playwright/Chromium tooling from the SIL workspace; launches the
 * system Google Chrome via channel.
 */

import { installFakeSerial, APP_URL, BRIDGE_URL, chromium } from './fixtures.mjs';

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  // viewport: null → the page follows the real window size. The Playwright
  // default is a FIXED 1280×720 emulated viewport, which made the app look
  // broken when the window was any other size (dead margin, no reflow).
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  // Same fake serial as the e2e suite (granted-ports list, serial events,
  // and window.__silDropLink() to try the disconnect/reconnect flow by hand).
  await page.addInitScript(installFakeSerial, BRIDGE_URL);
  await page.goto(APP_URL);
  console.log(`Opened ${APP_URL} with SIL serial injected. Click "Connect device".`);
  console.log('Tip: window.__silDropLink() in DevTools simulates an unplug.');
  console.log('Close the Chrome window (or Ctrl-C) to exit.');
  // Stay open until the window is closed.
  await new Promise((resolve) => browser.on('disconnected', resolve));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
