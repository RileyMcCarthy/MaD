/**
 * Native serialport probe — the class of serial impl that actually works with
 * this PL2303 (like loadp2/Chrome): real 230400 baud + DTR control via ioctl.
 * Resets via DTR, watches for the flash-boot banner, and reads the machine config.
 *
 *   MAD_SERIAL=/dev/cu.usbserial-XXXX node tools/hw-serialport-probe.mjs
 */
import { SerialPort } from 'serialport';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-PLX6ZJLYQ';
const BAUD = Number(process.env.MAD_BAUD || 230400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const set = (port, opts) => new Promise((res, rej) => port.set(opts, (e) => (e ? rej(e) : res())));
const write = (port, buf) => new Promise((res, rej) => port.write(buf, (e) => (e ? rej(e) : res())));

const main = async () => {
  const port = new SerialPort({ path: DEV, baudRate: BAUD, autoOpen: false });
  const rx = [];
  port.on('data', (d) => rx.push(d));
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  console.log(`[sp] opened ${DEV} @ ${BAUD}`);

  // DTR reset pulse (active-low assumption): drop then raise.
  await set(port, { dtr: true, rts: true });
  await sleep(60);
  console.log('[sp] DTR reset pulse…');
  await set(port, { dtr: false });
  await sleep(60);
  await set(port, { dtr: true });

  await sleep(2000); // boot window
  const bootBytes = Buffer.concat(rx).length;
  console.log(`[sp] bytes after reset: ${bootBytes}  ${Buffer.concat(rx).subarray(0, 60).toString('latin1')!=''?JSON.stringify(Buffer.concat(rx).subarray(0,60).toString('latin1')):''}`);

  console.log('[sp] sending read requests…');
  for (let i = 0; i < 6; i++) {
    await write(port, Buffer.from([0x55, 0x00, 0x03])); // firmware version
    await write(port, Buffer.from([0x55, 0x00, 0x02])); // machine config
    await sleep(400);
  }

  const all = Buffer.concat(rx);
  console.log(`[sp] total RX: ${all.length} bytes`);
  console.log(`[sp] hex: ${all.subarray(0, 200).toString('hex')}`);
  if (all.includes('Starting MaD Board')) console.log('[sp] >>> boot banner seen — flash boot CONFIRMED <<<');
  const i = all.indexOf(Buffer.from([0x55, 0x02, 0x02, 0x40, 0x00]));
  if (i >= 0 && all.length >= i + 5 + 64) {
    const name = all.subarray(i + 5, i + 25).toString('latin1').replace(/\0.*$/, '');
    console.log(`[sp] >>> machine-config frame found; profile name="${name}" <<<`);
  }
  await new Promise((res) => port.close(() => res()));
};

main().catch((e) => {
  console.error('[sp] error:', e.message);
  process.exit(1);
});
