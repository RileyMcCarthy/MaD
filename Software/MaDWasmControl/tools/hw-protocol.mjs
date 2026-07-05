/**
 * Talk the real protocol to the board over the FT232R protocol UART (P53/P55)
 * at 2,000,000 baud using native serialport. Reads firmware version + machine
 * profile (and with --save, writes a profile round-trip).
 *
 *   MAD_SERIAL=/dev/cu.usbserial-A5069RR4 MAD_BAUD=2000000 node tools/hw-protocol.mjs [--save]
 */
import { SerialPort } from 'serialport';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4';
const BAUD = Number(process.env.MAD_BAUD || 2000000);
const DO_SAVE = process.argv.includes('--save');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drain = (p) => new Promise((res, rej) => p.drain((e) => (e ? rej(e) : res())));
const writeRaw = (p, b) => new Promise((res, rej) => p.write(b, (e) => (e ? rej(e) : res())));
// Chunk large writes + drain each: a single big serialport write at high baud
// (>=1.5M on this FT232R/macOS) is dropped, while small drained writes go out.
const WRITE_CHUNK = Number(process.env.MAD_WRITE_CHUNK || 0);
const write = async (p, b) => {
  if (WRITE_CHUNK <= 0) { await writeRaw(p, b); return; }
  for (let i = 0; i < b.length; i += WRITE_CHUNK) {
    await writeRaw(p, b.subarray(i, i + WRITE_CHUNK));
    await drain(p);
  }
};

const CMD_READ_MACHINE_CONFIG = 0x02;
const CMD_READ_FIRMWARE_VERSION = 0x03;
const CMD_WRITE_MACHINE_CONFIG = 0x00;

function crc8(data) {
  let crc = 0;
  for (let b of data) {
    for (let i = 0; i < 8; i++) {
      const mix = (crc ^ b) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      b >>= 1;
    }
  }
  return crc & 0xff;
}

function findFrame(buf, cmd, payloadLen) {
  const needle = Buffer.from([0x55, 0x02, cmd, payloadLen & 0xff, (payloadLen >> 8) & 0xff]);
  const i = buf.indexOf(needle);
  if (i < 0 || buf.length < i + 5 + payloadLen) return null;
  const payload = buf.subarray(i + 5, i + 5 + payloadLen);
  const crc = buf.length > i + 5 + payloadLen ? buf[i + 5 + payloadLen] : null;
  return { payload, crcOk: crc === crc8(payload) };
}

const KEYS = ['encoderStepsPerMM', 'servoStepsPerMM', 'forceGaugeNPerStep', 'forceGaugeZeroOffset',
  'maxPosition', 'maxVelocity', 'maxAcceleration', 'maxForceTensile_mN', 'homingVelocity', 'homingOffset', 'jawOffset'];

function decodeProfile(p) {
  const name = p.subarray(0, 20).toString('latin1').replace(/\0.*$/, '');
  const o = { name };
  for (let i = 0; i < 11; i++) o[KEYS[i]] = p.readInt32LE(20 + i * 4);
  o.maxForceTensile_N = o.maxForceTensile_mN / 1000;
  return o;
}

function encodeProfile(o) {
  const buf = Buffer.alloc(64);
  buf.write(o.name.slice(0, 20), 0, 'latin1');
  for (let i = 0; i < 11; i++) buf.writeInt32LE(o[KEYS[i]] | 0, 20 + i * 4);
  return buf;
}

const main = async () => {
  const port = new SerialPort({ path: DEV, baudRate: BAUD, autoOpen: false });
  const chunks = [];
  port.on('data', (d) => chunks.push(d));
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  console.log(`[proto] open ${DEV} @ ${BAUD}`);

  const drain = () => Buffer.concat(chunks);
  const req = async (cmd) => { await write(port, Buffer.from([0x55, 0x00, cmd])); };

  // Read firmware version + machine config (retry a few times).
  let fw = null, prof = null;
  for (let i = 0; i < 8 && (!fw || !prof); i++) {
    await req(CMD_READ_FIRMWARE_VERSION);
    await req(CMD_READ_MACHINE_CONFIG);
    await sleep(300);
    const all = drain();
    const f = findFrame(all, CMD_READ_FIRMWARE_VERSION, 16);
    const m = findFrame(all, CMD_READ_MACHINE_CONFIG, 64);
    if (f) fw = f.payload.toString('latin1').replace(/\0.*$/, '');
    if (m) prof = { ...decodeProfile(m.payload), _crcOk: m.crcOk };
  }

  console.log(`[proto] total RX: ${drain().length} bytes`);
  console.log(`[proto] firmware version: ${fw ?? '(none)'}`);
  console.log(`[proto] machine profile: ${prof ? JSON.stringify(prof, null, 2) : '(none)'}`);

  if (process.env.MAD_SET_NAME && prof) {
    const target = { ...prof }; delete target._crcOk;
    target.name = process.env.MAD_SET_NAME;
    const payload = encodeProfile(target);
    chunks.length = 0;
    await write(port, Buffer.concat([Buffer.from([0x55, 0x01, CMD_WRITE_MACHINE_CONFIG, 64, 0]), payload, Buffer.from([crc8(payload)])]));
    await sleep(600);
    chunks.length = 0;
    for (let i = 0; i < 6; i++) { await write(port, Buffer.from([0x55, 0x00, CMD_READ_MACHINE_CONFIG])); await sleep(300); const m = findFrame(drain(), CMD_READ_MACHINE_CONFIG, 64); if (m) { console.log(`[proto] set name -> "${decodeProfile(m.payload).name}"`); break; } }
    await new Promise((res) => port.close(() => res()));
    return;
  }

  if (DO_SAVE && prof) {
    const original = { ...prof }; delete original._crcOk;
    const stamp = ('RW-' + original.name).slice(0, 20);
    console.log(`\n[proto] SAVE: name -> ${stamp}`);
    const payload = encodeProfile({ ...original, name: stamp });
    chunks.length = 0;
    await write(port, Buffer.concat([Buffer.from([0x55, 0x01, CMD_WRITE_MACHINE_CONFIG, 64, 0]), payload, Buffer.from([crc8(payload)])]));
    await sleep(600);
    const ack = drain();
    const isAck = ack.includes(Buffer.from([0x55, 0x01, CMD_WRITE_MACHINE_CONFIG]));
    const isNack = ack.includes(Buffer.from([0x55, 0x00, CMD_WRITE_MACHINE_CONFIG]));
    console.log(`[proto] write reply: ${isAck ? 'ACK' : isNack ? 'NACK' : `none (${ack.subarray(0, 12).toString('hex')})`}`);

    // Read back WITHOUT a reboot — does the firmware's in-RAM hot-update reflect?
    chunks.length = 0;
    for (let i = 0; i < 6; i++) {
      await write(port, Buffer.from([0x55, 0x00, CMD_READ_MACHINE_CONFIG]));
      await sleep(300);
      const m = findFrame(drain(), CMD_READ_MACHINE_CONFIG, 64);
      if (m) { console.log(`[proto] read-back name -> "${decodeProfile(m.payload).name}" (expected "${stamp}")`); break; }
    }

    // Restore.
    console.log(`[proto] RESTORE: name -> ${original.name}`);
    const restorePayload = encodeProfile(original);
    chunks.length = 0;
    await write(port, Buffer.concat([Buffer.from([0x55, 0x01, CMD_WRITE_MACHINE_CONFIG, 64, 0]), restorePayload, Buffer.from([crc8(restorePayload)])]));
    await sleep(600);
    console.log(`[proto] restore reply: ${drain().includes(Buffer.from([0x55, 0x01, CMD_WRITE_MACHINE_CONFIG])) ? 'ACK' : 'see device'}`);
  }

  await new Promise((res) => port.close(() => res()));
};

main().catch((e) => { console.error('[proto] error:', e.message); process.exit(1); });
