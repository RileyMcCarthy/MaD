/**
 * One-shot hardware liveness probe (dev-only, not part of the app).
 *
 * Opens the real P2 USB-serial port at 230400/raw and listens passively for a
 * few seconds. If the firmware is running it streams ~100 Hz sample frames
 * (each starts with the 0x55 protocol sync byte), so any framed traffic here
 * confirms the board booted and the baud rate is right — before we bring up the
 * full app + bridge + Playwright stack.
 *
 *   MAD_SERIAL=/dev/cu.usbserial-XXXX node tools/hw-serial-probe.mjs
 */
import { open } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-PLX6ZJLYQ';
const BAUD = Number(process.env.MAD_BAUD || 230400);
const SECONDS = Number(process.env.MAD_PROBE_SECONDS || 3);

function configure() {
  // raw 8N1, no flow control, ignore modem lines, short read timeout (VMIN=0 VTIME=1).
  const cmd = `stty -f ${DEV} ${BAUD} cs8 -cstopb -parenb -ixon -ixoff -crtscts clocal raw -echo min 0 time 1`;
  execSync(cmd);
}

const main = async () => {
  console.log(`[probe] ${DEV} @ ${BAUD}, listening ${SECONDS}s…`);
  configure();
  const fh = await open(DEV, 'r+');
  configure(); // re-apply while the fd is held, in case open reset termios
  const buf = Buffer.alloc(4096);
  let total = 0;
  let syncs = 0;
  let firstHex = '';
  const deadline = Date.now() + SECONDS * 1000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const { bytesRead } = await fh.read(buf, 0, buf.length, null);
    if (bytesRead > 0) {
      const slice = buf.subarray(0, bytesRead);
      total += bytesRead;
      for (let i = 0; i < bytesRead; i++) if (slice[i] === 0x55) syncs++;
      if (!firstHex) firstHex = slice.subarray(0, Math.min(48, bytesRead)).toString('hex');
    }
  }
  await fh.close();
  console.log(`[probe] bytes=${total}  0x55-sync-bytes=${syncs}`);
  console.log(`[probe] first bytes: ${firstHex || '(none)'}`);
  console.log(total > 0 ? '[probe] RESULT: traffic seen — firmware appears alive.' : '[probe] RESULT: silence — firmware not streaming (not booted, wrong baud, or quiet).');
};

main().catch((e) => {
  console.error('[probe] error:', e.message);
  process.exit(1);
});
