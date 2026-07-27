/**
 * Capture BOTH board UARTs at once:
 *   - debug port  (P62/63 @ 230400)  -> boot banner + printf/DEBUG_* trace
 *   - protocol    (P53/55 @ 2000000) -> protocol frames; we poll read-config here
 *
 * Run in background, then physically reset/power-cycle the board to capture a
 * fresh flash-boot trace.
 */
import { SerialPort } from 'serialport';

const DBG = process.env.MAD_DBG || '/dev/cu.usbserial-PLX6ZJLYQ';
const PROTO = process.env.MAD_PROTO || '/dev/cu.usbserial-A5069RR4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(path, baud, label) {
  const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
  port.on('data', (d) => {
    const printable = d.toString('latin1').replace(/[^\x20-\x7e\r\n]/g, '.');
    process.stdout.write(`[${label}] ${printable}`);
    process.stdout.write(`\n[${label} hex] ${d.toString('hex')}\n`);
  });
  return new Promise((res, rej) => port.open((e) => (e ? rej(e) : res(port))));
}

const main = async () => {
  const dbg = await open(DBG, 230400, 'DBG').catch((e) => { console.log('DBG open failed:', e.message); return null; });
  const proto = await open(PROTO, 2000000, 'PROTO').catch((e) => { console.log('PROTO open failed:', e.message); return null; });
  console.log('[cap] listening on both ports. RESET THE BOARD NOW. Polling read-config on PROTO…');

  const iters = Number(process.env.MAD_CAP_ITERS || 40);
  for (let i = 0; i < iters; i++) {
    if (proto) proto.write(Buffer.from([0x55, 0x00, 0x02])); // read machine config
    if (proto) proto.write(Buffer.from([0x55, 0x00, 0x03])); // read firmware version
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  console.log('[cap] done');
  process.exit(0);
};

main().catch((e) => { console.error('[cap] error:', e.message); process.exit(1); });
