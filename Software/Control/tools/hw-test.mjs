/**
 * Drive a full G-code test_run on real hardware to exercise the worst-case
 * stack paths: a G123 waveform (CONTROL cog NCO float math) + SD sample logging
 * (LOGGER cog). Uploads the program to SD, runs it, and polls test state. Watch
 * the debug serial's [stack] reports for the resulting high-water peaks.
 *
 *   MAD_SERIAL=/dev/cu.usbserial-A5069RR4 node tools/hw-test.mjs
 */
import { SerialPort } from 'serialport';
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4';
const BAUD = Number(process.env.MAD_BAUD || 2000000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ts = readFileSync(new URL('../src/protocol/generated/protoemb.ts', import.meta.url), 'utf8');
const C = await import('data:text/javascript,' + encodeURIComponent(esbuild.transformSync(ts, { loader: 'ts', format: 'esm' }).code));

const FAULT = ['NONE', 'COG', 'WATCHDOG', 'ESD_POWER', 'ESD_SWITCH', 'ESD_UPPER', 'ESD_LOWER', 'SERVO', 'FORCE_GAUGE'];
function crc8(d) { let c = 0; for (let b of d) { for (let i = 0; i < 8; i++) { const m = (c ^ b) & 1; c >>= 1; if (m) c ^= 0x8c; b >>= 1; } } return c & 0xff; }

const port = new SerialPort({ path: DEV, baudRate: BAUD, autoOpen: false });
let rx = Buffer.alloc(0);
port.on('data', (d) => { rx = Buffer.concat([rx, d]); });
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
const raw = (b) => new Promise((res, rej) => port.write(b, (e) => (e ? rej(e) : res())));
const writeMsg = (cmd, p) => raw(Buffer.concat([Buffer.from([0x55, 0x01, cmd, p.length & 0xff, (p.length >> 8) & 0xff]), Buffer.from(p), Buffer.from([crc8(p)])]));
const readReq = (cmd) => raw(Buffer.from([0x55, 0x00, cmd]));
const sawAck = (cmd) => rx.includes(Buffer.from([0x55, 0x01, cmd]));
const sawNack = (cmd) => rx.includes(Buffer.from([0x55, 0x00, cmd]));

async function writeAck(label, cmd, payload, tries = 4) {
  for (let i = 0; i < tries; i++) {
    rx = Buffer.alloc(0);
    await writeMsg(cmd, payload); await sleep(250);
    if (sawAck(cmd)) { console.log(`  ${label}: ACK`); return true; }
    if (sawNack(cmd)) { console.log(`  ${label}: NACK`); return false; }
  }
  console.log(`  ${label}: no reply (${tries}x)`); return false;
}
async function readState() {
  for (let i = 0; i < 8; i++) {
    rx = Buffer.alloc(0); await readReq(C.MSG_READ_STATE); await sleep(120);
    const n = Buffer.from([0x55, 0x02, C.MSG_READ_STATE, C.MACHINESTATE_WIRE_SIZE, 0]);
    const idx = rx.lastIndexOf(n);
    if (idx >= 0 && rx.length >= idx + 5 + C.MACHINESTATE_WIRE_SIZE) return C.decodeMachineState(new Uint8Array(rx.subarray(idx + 5, idx + 5 + C.MACHINESTATE_WIRE_SIZE)));
  }
  return null;
}

console.log('[test] state before:', JSON.stringify(await readState()));
rx = Buffer.alloc(0); await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x01]); await sleep(200);
const st = await readState();
console.log(`[test] motion_enable -> motionEnabled=${st?.motionEnabled} fault=${FAULT[st?.faultedReason]}`);
if (!st?.motionEnabled) { console.log('[test] motion not enabled; aborting'); await new Promise((r) => port.close(() => r())); process.exit(1); }

const GID = 'STKTST';
console.log('[test] uploading gcode program (moves + G123 waveform):');
if (!await writeAck(`open ${GID}`, C.MSG_WRITE_TEST_MOVE, Buffer.from(GID, 'latin1'))) {
  console.log('[test] gcode open NACK — SD card not present/writable. Cannot run a logging test.');
  await new Promise((r) => port.close(() => r())); process.exit(2);
}
const mv = (g, x, f) => Buffer.from(C.encodeMove({ g, x, f, p: 0 }));
await writeAck('G90 + G1 X10 F5', C.MSG_WRITE_TEST_MOVE, Buffer.concat([mv(C.GCode.ABSOLUTE, 0, 0), mv(C.GCode.LINEAR_MOVE, 10, 5)]));
await writeAck('G123 sine 3mm 2Hz x8', C.MSG_WRITE_TEST_WAVEFORM, Buffer.from(C.encodeWaveformMove({ shape: C.WaveformShape.SINE, amplitude: 3, frequency: 2, cycles: 8 })));
await writeAck('G1 X0 F5', C.MSG_WRITE_TEST_MOVE, mv(C.GCode.LINEAR_MOVE, 0, 5));
await writeAck('G122 stop', C.MSG_WRITE_TEST_MOVE, mv(C.GCode.STOP, 0, 0));
await writeAck('test_run', C.MSG_WRITE_TEST_RUN, Buffer.from(C.encodeTestRun({ gcodeId: GID, testDataId: 'STKLOG' })));

console.log('[test] running — polling test state:');
let ran = false;
for (let t = 0; t < 50; t++) {
  const s = await readState();
  if (s?.testRunning) ran = true;
  console.log(`  t=${(t * 0.5).toFixed(1)}s testRunning=${s?.testRunning} fault=${FAULT[s?.faultedReason]}`);
  if (ran && s && !s.testRunning) { console.log('[test] test complete'); break; }
  if (s && s.faultedReason !== 0) { console.log('[test] FAULT during test:', FAULT[s.faultedReason]); break; }
  await sleep(500);
}
await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x00]); await sleep(150);
await new Promise((r) => port.close(() => r()));
