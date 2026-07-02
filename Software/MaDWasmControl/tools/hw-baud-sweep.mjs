/** Sweep bauds on the protocol port, sending read-config + read-fw each time,
 * to find what (if any) baud the firmware answers at. If NONE answer, the
 * FT232R<->P2 (53/55) wiring is the likely culprit. */
import { SerialPort } from 'serialport';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4';
const BAUDS = (process.env.MAD_BAUDS || '2000000,921600,460800,230400,115200').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tryBaud = async (baud) => {
  const port = new SerialPort({ path: DEV, baudRate: baud, autoOpen: false });
  const chunks = [];
  port.on('data', (d) => chunks.push(d));
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  for (let i = 0; i < 6; i++) {
    port.write(Buffer.from([0x55, 0x00, 0x02]));
    port.write(Buffer.from([0x55, 0x00, 0x03]));
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  await new Promise((res) => port.close(() => res()));
  const all = Buffer.concat(chunks);
  const frame = all.indexOf(Buffer.from([0x55, 0x02]));
  console.log(`[baud ${baud}] RX=${all.length} bytes  frame=${frame >= 0 ? 'YES@' + frame : 'no'}  hex=${all.subarray(0, 24).toString('hex')}`);
  return all.length > 0;
};

const main = async () => {
  console.log(`sweeping ${DEV}`);
  for (const b of BAUDS) {
    // eslint-disable-next-line no-await-in-loop
    try { await tryBaud(b); } catch (e) { console.log(`[baud ${b}] error: ${e.message}`); }
  }
};
main().catch((e) => { console.error(e.message); process.exit(1); });
