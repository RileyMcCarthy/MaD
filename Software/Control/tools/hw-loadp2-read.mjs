/**
 * Diagnostic: RAM-load the firmware and read the machine profile over a serial
 * link that is NEVER closed/reopened — loadp2 holds the port open in terminal
 * mode (DTR stays asserted, so no reset pulse). If the board answers here but
 * stays silent to a fresh open (hw-active-probe.mjs), that proves the firmware
 * runs fine and it's specifically the reopen-time DTR reset that kills a RAM
 * image — i.e. the app needs firmware in flash.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const LOADP2 = `${homedir()}/.platformio/packages/tool-loadp2/bin/macos/loadp2`;
const PROG = '/Users/rileymccarthy/Documents/MaD/Firmware/MaDCore/.pio/build/propeller2/program';
const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-PLX6ZJLYQ';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reqMachineConfig = Buffer.from([0x55, 0x00, 0x02]);
const reqFirmware = Buffer.from([0x55, 0x00, 0x03]);

const main = async () => {
  const flashBoot = process.env.MAD_FLASHBOOT === '1';
  const args = flashBoot
    ? ['-p', DEV, '-b', '230400', '-t', '-q'] // reset only → board must boot from flash
    : ['-p', DEV, '-b', '230400', '-t', '-q', PROG]; // RAM-load then hold
  console.log(`[loadp2-read] ${flashBoot ? 'DTR reset only (flash boot)' : 'RAM-loading'} + holding port open…`);
  const child = spawn(LOADP2, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rx = [];
  child.stdout.on('data', (d) => rx.push(d));
  child.stderr.on('data', (d) => process.stderr.write(`[loadp2] ${d}`));

  await sleep(3000); // let loadp2 reset+load+start the program, then fw boots
  console.log('[loadp2-read] sending read requests through the held-open link…');
  for (let i = 0; i < 4; i++) {
    child.stdin.write(reqFirmware);
    child.stdin.write(reqMachineConfig);
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  await sleep(800);
  child.kill('SIGTERM');

  const all = Buffer.concat(rx);
  console.log(`[loadp2-read] RX bytes from link: ${all.length}`);
  const idx = all.indexOf(Buffer.from([0x55, 0x02, 0x02, 0x40, 0x00]));
  if (idx >= 0) {
    const payload = all.subarray(idx + 5, idx + 5 + 64);
    const name = payload.subarray(0, 20).toString('latin1').replace(/\0.*$/, '');
    console.log(`[loadp2-read] >>> machine-config DATA frame received; profile name="${name}" <<<`);
    console.log(`[loadp2-read] payload hex: ${payload.toString('hex')}`);
    console.log('[loadp2-read] CONCLUSION: firmware RUNS and responds when the port is held open.');
    console.log('[loadp2-read]   → a fresh open (the app/probe) is what resets it; flash is required.');
  } else {
    console.log(`[loadp2-read] no config frame. RX hex tail: ${all.subarray(-120).toString('hex') || '(none)'}`);
    console.log('[loadp2-read] (inconclusive — loadp2 terminal may not relay raw bytes; see hex above)');
  }
};

main().catch((e) => {
  console.error('[loadp2-read] error:', e.message);
  process.exit(1);
});
