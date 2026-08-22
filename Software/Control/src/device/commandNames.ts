/**
 * Command id → human-readable name, for the session log.
 *
 * A frame log full of bare numbers ("tx 34, rx 34, nack 12") is unreadable in a
 * bug report; the whole point of logging protocol traffic is that someone can
 * skim it. Kept next to the worker rather than in `diagnostics/` because it is
 * protocol knowledge, not logging machinery.
 *
 * Derived from the generated codec's constants, so it cannot drift from the
 * wire format the way a hand-written table would.
 */

import {
  MSG_READ_SAMPLE,
  MSG_READ_STATE,
  MSG_READ_MACHINE_CONFIGURATION,
  MSG_READ_FIRMWARE_VERSION,
  MSG_READ_SAMPLE_PROFILE,
  MSG_WRITE_MACHINE_CONFIGURATION_WRITE,
  MSG_WRITE_MOTION_ENABLE,
  MSG_WRITE_TEST_RUN,
  MSG_WRITE_MANUAL_MOVE,
  MSG_WRITE_TEST_MOVE,
  MSG_WRITE_TEST_WAVEFORM,
  MSG_WRITE_SAMPLE_PROFILE_WRITE,
  MSG_WRITE_GAUGE_LENGTH,
  MSG_WRITE_GAUGE_FORCE,
  MSG_WRITE_FILE_DOWNLOAD,
} from '@/protocol/generated/protoemb';

/**
 * Reads and writes share the id space — `READ_MACHINE_CONFIGURATION` and
 * `WRITE_TEST_RUN` are both command 2 — so a single id→name map silently
 * mislabels half the traffic. Keep them apart and resolve with the direction
 * the call site knows.
 */
const READ_NAMES = new Map<number, string>([
  [MSG_READ_SAMPLE, 'READ_SAMPLE'],
  [MSG_READ_STATE, 'READ_STATE'],
  [MSG_READ_MACHINE_CONFIGURATION, 'READ_MACHINE_CONFIGURATION'],
  [MSG_READ_FIRMWARE_VERSION, 'READ_FIRMWARE_VERSION'],
  [MSG_READ_SAMPLE_PROFILE, 'READ_SAMPLE_PROFILE'],
]);

const WRITE_NAMES = new Map<number, string>([
  [MSG_WRITE_MACHINE_CONFIGURATION_WRITE, 'WRITE_MACHINE_CONFIGURATION'],
  [MSG_WRITE_MOTION_ENABLE, 'WRITE_MOTION_ENABLE'],
  [MSG_WRITE_TEST_RUN, 'WRITE_TEST_RUN'],
  [MSG_WRITE_MANUAL_MOVE, 'WRITE_MANUAL_MOVE'],
  [MSG_WRITE_TEST_MOVE, 'WRITE_TEST_MOVE'],
  [MSG_WRITE_TEST_WAVEFORM, 'WRITE_TEST_WAVEFORM'],
  [MSG_WRITE_SAMPLE_PROFILE_WRITE, 'WRITE_SAMPLE_PROFILE'],
  [MSG_WRITE_GAUGE_LENGTH, 'WRITE_GAUGE_LENGTH'],
  [MSG_WRITE_GAUGE_FORCE, 'WRITE_GAUGE_FORCE'],
  [MSG_WRITE_FILE_DOWNLOAD, 'WRITE_FILE_DOWNLOAD'],
]);

/** Which side of the protocol a command id should be read against. */
export type CommandDir = 'read' | 'write';

/**
 * `'WRITE_MOTION_ENABLE(1)'` when the direction is known.
 *
 * Without one, an id that exists on both sides renders as
 * `'READ_STATE|WRITE_MOTION_ENABLE(1)'` — honest ambiguity, because a
 * confidently wrong name is worse in a bug report than a hedged one.
 */
export function commandName(command: number, dir?: CommandDir): string {
  const read = READ_NAMES.get(command);
  const write = WRITE_NAMES.get(command);
  if (dir === 'read') return read ? `${read}(${command})` : `cmd(${command})`;
  if (dir === 'write') return write ? `${write}(${command})` : `cmd(${command})`;
  if (read && write) return `${read}|${write}(${command})`;
  const only = read ?? write;
  return only ? `${only}(${command})` : `cmd(${command})`;
}

/**
 * The high-rate periodics. These arrive at ~100 Hz and ~10 Hz respectively and
 * must never get a log entry each — call sites aggregate them instead.
 */
export function isPeriodicCommand(command: number): boolean {
  return command === MSG_READ_SAMPLE || command === MSG_READ_STATE;
}

/**
 * Summarise a G-code program for the log.
 *
 * The full program can be thousands of lines, so this keeps what actually
 * answers "did we upload the right thing": size, a content hash (two runs of
 * the same profile must produce the same digest — if they don't, the transform
 * is non-deterministic), and a per-opcode histogram. The histogram makes the
 * project's classic footgun visible at a glance: a program missing its trailing
 * `G122` never signals completion to the firmware.
 */
export function summariseGcode(lines: readonly string[]): Record<string, unknown> {
  const opcodes: Record<string, number> = {};
  let bytes = 0;
  // FNV-1a: tiny, dependency-free, and only needs to detect difference.
  let hash = 0x811c9dc5;
  for (const line of lines) {
    bytes += line.length + 1;
    for (let i = 0; i < line.length; i++) {
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    const op = /^\s*([GM]\d+)/i.exec(line)?.[1]?.toUpperCase();
    if (op !== undefined) opcodes[op] = (opcodes[op] ?? 0) + 1;
  }
  return {
    lines: lines.length,
    bytes,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
    opcodes,
    endsWithG122: /^\s*G122\b/i.test(lines[lines.length - 1] ?? ''),
  };
}
