/**
 * SD data-pipeline test (no motor/encoder/FG needed): upload a no-motion G-code
 * program to SD, run it (which reads the G-code back + logs samples), then read
 * the logged samples back over the protocol (file_download) — the UI read path.
 * Gates on the SD write first (the known EIO failure mode).
 *   MAD_SERIAL=/dev/cu.usbserial-A5069RR4 node tools/hw-sdtest.mjs
 */
import { SerialPort } from 'serialport';
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = await import('data:text/javascript,' + encodeURIComponent(
  esbuild.transformSync(readFileSync(new URL('../src/protocol/generated/protoemb.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code));
function crc8(d) { let c = 0; for (let b of d) { for (let i = 0; i < 8; i++) { const m = (c ^ b) & 1; c >>= 1; if (m) c ^= 0x8c; b >>= 1; } } return c & 0xff; }
const port = new SerialPort({ path: process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4', baudRate: 2000000, autoOpen: false });
let rx = Buffer.alloc(0);
port.on('data', (d) => { rx = Buffer.concat([rx, d]); });
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
const raw = (b) => new Promise((res, rej) => port.write(b, (e) => (e ? rej(e) : res())));
const TYPE_READ = 0x00, TYPE_WRITE = 0x01, TYPE_DATA = 0x02;
const writeMsg = (cmd, p) => raw(Buffer.concat([Buffer.from([0x55, TYPE_WRITE, cmd, p.length & 0xff, (p.length >> 8) & 0xff]), Buffer.from(p), Buffer.from([crc8(p)])]));
const readReq = (cmd) => raw(Buffer.from([0x55, TYPE_READ, cmd]));
const sawAck = (cmd) => rx.includes(Buffer.from([0x55, TYPE_WRITE, cmd]));
const sawNack = (cmd) => rx.includes(Buffer.from([0x55, TYPE_READ, cmd]));
const lastData = (cmd, len) => { const n = Buffer.from([0x55, TYPE_DATA, cmd, len & 0xff, (len >> 8) & 0xff]); const i = rx.lastIndexOf(n); if (i < 0 || rx.length < i + 5 + len) return null; return rx.subarray(i + 5, i + 5 + len); };
async function writeAck(label, cmd, payload, tries = 5) {
  for (let i = 0; i < tries; i++) { rx = Buffer.alloc(0); await writeMsg(cmd, payload); await sleep(250); if (sawAck(cmd)) { console.log(`  ${label}: ACK`); return true; } if (sawNack(cmd)) { console.log(`  ${label}: NACK`); return false; } }
  console.log(`  ${label}: no reply`); return false;
}
async function readState() { for (let i = 0; i < 8; i++) { rx = Buffer.alloc(0); await readReq(C.MSG_READ_STATE); await sleep(120); const p = lastData(C.MSG_READ_STATE, C.MACHINESTATE_WIRE_SIZE); if (p) return C.decodeMachineState(new Uint8Array(p)); } return null; }
const GID = 'SDTST', DID = 'SDLOG';
const mv = (g, x, f, p) => Buffer.from(C.encodeMove({ g, x, f, p }));

if (process.env.MAD_DELAY) { console.log(`(waiting ${process.env.MAD_DELAY}ms for RAM-load + boot)`); await sleep(Number(process.env.MAD_DELAY)); }
await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x01]); await sleep(200);
let st = await readState();
console.log(`enabled=${st?.motionEnabled} fault=${st?.faultedReason}`);

console.log('\n=== 1) SD WRITE: upload no-motion gcode ===');
const openOk = await writeAck(`open ${GID}`, C.MSG_WRITE_TEST_MOVE, Buffer.from(GID, 'latin1'));
if (!openOk) {
  console.log('>>> SD WRITE FAILED (gcode open NACK = card not writable / EIO). Pipeline blocked here.');
  await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x00]); await sleep(150);
  await new Promise((r) => port.close(() => r())); process.exit(2);
}
await writeAck('G90+G4(3s)+G4(2s)+G122', C.MSG_WRITE_TEST_MOVE, Buffer.concat([
  mv(C.GCode.ABSOLUTE, 0, 0, 0), mv(C.GCode.DWELL, 0, 0, 3000), mv(C.GCode.DWELL, 0, 0, 2000), mv(C.GCode.STOP, 0, 0, 0)]));
console.log('  gcode upload ACKed; flushing writes to SD before run...');
await sleep(1500);

console.log('\n=== 2) test_run: read gcode back + log samples (simultaneous SD r/w) ===');
console.log('  (a ~5s run with testRunning=true => gcode PERSISTED + read back OK; instant finish => empty file = silent write fail)');
await writeAck('test_run', C.MSG_WRITE_TEST_RUN, Buffer.from(C.encodeTestRun({ gcodeId: GID, testDataId: DID })));
let ran = false;
for (let t = 0; t < 16; t++) {
  const s = await readState(); if (s?.testRunning) ran = true;
  console.log(`  t=${(t * 0.25).toFixed(2)}s testRunning=${s?.testRunning} fault=${s?.faultedReason}`);
  if (ran && s && !s.testRunning) { console.log('  test complete'); break; }
  if (s && s.faultedReason) { console.log('  FAULT during test'); break; }
  await sleep(250);
}

console.log('\n=== 3) read back logged samples (file_download) ===');
console.log('  (waiting 2.5s for the LOGGER cog to flush + close the sample log channel)');
await sleep(2500);
const dl = Buffer.alloc(24); dl.write(DID, 0, 'latin1'); dl.writeUInt32LE(0, 16); dl.writeUInt32LE(64, 20);
rx = Buffer.alloc(0); await writeMsg(C.MSG_WRITE_FILE_DOWNLOAD, dl); await sleep(600);
// collect every DATA frame for cmd FILE_DOWNLOAD and decode StoredSamples
const SS = C.STOREDSAMPLE_WIRE_SIZE; let samples = [];
for (let i = 0; i + 5 <= rx.length; i++) {
  if (rx[i] === 0x55 && rx[i + 1] === TYPE_DATA && rx[i + 2] === C.MSG_WRITE_FILE_DOWNLOAD) {
    const len = rx[i + 3] | (rx[i + 4] << 8);
    if (len > 0 && len % SS === 0 && i + 5 + len <= rx.length) {
      for (let o = 0; o < len; o += SS) samples.push(C.decodeStoredSample(new Uint8Array(rx.subarray(i + 5 + o, i + 5 + o + SS))));
      i += 5 + len;
    }
  }
}
console.log(`  raw RX ${rx.length} bytes; decoded ${samples.length} samples`);
samples.slice(0, 6).forEach((s, i) => console.log(`   [${i}] ${JSON.stringify(s)}`));
if (samples.length > 6) console.log(`   ... [${samples.length - 1}] ${JSON.stringify(samples[samples.length - 1])}`);

await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x00]); await sleep(150);
await new Promise((r) => port.close(() => r()));
