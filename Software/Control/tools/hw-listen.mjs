/**
 * Actively poke the firmware (periodic read-state) to keep the protocol UART
 * cleanly driven, while capturing the stream and surfacing pushed notifications
 * (the firmware interleaves notification frames with responses on the same UART).
 * Used to verify firmware-initiated notifications (e.g. stack-headroom warnings).
 *
 *   MAD_SERIAL=/dev/cu.usbserial-A5069RR4 MAD_LISTEN_SECS=8 node tools/hw-listen.mjs
 */
import { SerialPort } from 'serialport';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4';
const BAUD = Number(process.env.MAD_BAUD || 2000000);
const SECS = Number(process.env.MAD_LISTEN_SECS || 8);
const NEEDLE = process.env.MAD_NEEDLE || 'cog stack';

const port = new SerialPort({ path: DEV, baudRate: BAUD, autoOpen: false });
let rx = Buffer.alloc(0);
port.on('data', (d) => { rx = Buffer.concat([rx, d]); });
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));

// Poke read-state (cmd 1) every 250ms so the firmware keeps TXing clean frames;
// notifications (type 0x03) interleave with the state responses.
const poke = setInterval(() => { port.write(Buffer.from([0x55, 0x00, 0x01])); }, 250);
await new Promise((r) => setTimeout(r, SECS * 1000));
clearInterval(poke);
await new Promise((r) => port.close(() => r()));

let sync = 0, notif = 0;
for (let i = 0; i < rx.length - 1; i++) { if (rx[i] === 0x55) { sync++; if (rx[i + 1] === 0x03) notif++; } }
const txt = rx.toString('latin1');
const hits = [...new Set([...txt.matchAll(new RegExp(`[\\x20-\\x7e]*${NEEDLE}[\\x20-\\x7e]*`, 'g'))].map((m) => m[0].trim()))];
const runs = [...new Set((txt.match(/[\x20-\x7e]{8,}/g) || []))];
console.log(`[listen] ${rx.length} bytes, sync(0x55)=${sync}, notification frames(0x55,0x03)=${notif}`);
console.log(`[listen] matches for "${NEEDLE}":`);
hits.length ? hits.forEach((h) => console.log('  • ' + h)) : console.log('  (none)');
console.log(`[listen] all ASCII runs (>=8 chars): ${runs.length}`);
runs.slice(0, 12).forEach((r) => console.log('  · ' + r));
