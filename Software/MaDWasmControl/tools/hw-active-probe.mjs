/**
 * Active hardware liveness probe (dev-only). Sends real protocol READ requests
 * straight to the board and reports any reply — no app, no bridge, no Playwright.
 *
 * Read request frame = [0x55(sync), 0x00(READ), command]; the firmware answers
 * with a DATA frame [0x55, 0x02(DATA), command, len_lo, len_hi, payload..., crc8].
 *
 *   MAD_SERIAL=/dev/cu.usbserial-XXXX node tools/hw-active-probe.mjs
 */
import { open } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-PLX6ZJLYQ';
const BAUD = Number(process.env.MAD_BAUD || 230400);

const READ_MACHINE_CONFIGURATION = 0x02;
const READ_FIRMWARE_VERSION = 0x03;
const req = (cmd) => Buffer.from([0x55, 0x00, cmd]);

function configure() {
  execSync(`stty -f ${DEV} ${BAUD} cs8 -cstopb -parenb -ixon -ixoff -crtscts clocal raw -echo min 0 time 1`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  configure();
  const fh = await open(DEV, 'r+');
  configure();
  console.log(`[active] ${DEV} @ ${BAUD}; opened (board reset). Waiting 2s for boot…`);

  const rx = [];
  let running = true;
  const buf = Buffer.alloc(4096);
  const reader = (async () => {
    while (running) {
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead > 0) rx.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
  })();

  await sleep(2000);
  // Send a few requests spaced out in case early ones land mid-boot.
  for (let i = 0; i < 5; i++) {
    await fh.write(req(READ_FIRMWARE_VERSION));
    await fh.write(req(READ_MACHINE_CONFIGURATION));
    console.log(`[active] sent read requests (round ${i + 1})`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(600);
  }
  await sleep(600);
  running = false;
  await reader.catch(() => {});
  await fh.close();

  const all = Buffer.concat(rx);
  console.log(`[active] total RX bytes: ${all.length}`);
  console.log(`[active] RX hex: ${all.toString('hex') || '(none)'}`);
  // Look for a machine-config DATA frame.
  const idx = all.indexOf(Buffer.from([0x55, 0x02, 0x02, 0x40, 0x00]));
  if (idx >= 0) {
    const name = all.subarray(idx + 5, idx + 5 + 20).toString('latin1').replace(/\0.*$/, '');
    console.log(`[active] RESULT: machine-config DATA frame found at offset ${idx}; profile name="${name}"`);
    console.log('[active] >>> FIRMWARE IS ALIVE and responding. <<<');
  } else if (all.length > 0) {
    console.log('[active] RESULT: got bytes but no recognizable config frame (maybe ROM loader / wrong baud).');
  } else {
    console.log('[active] RESULT: total silence — no firmware responding on this port.');
  }
};

main().catch((e) => {
  console.error('[active] error:', e.message);
  process.exit(1);
});
