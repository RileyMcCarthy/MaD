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

const NAMES = new Map<number, string>([
  [MSG_READ_SAMPLE, 'READ_SAMPLE'],
  [MSG_READ_STATE, 'READ_STATE'],
  [MSG_READ_MACHINE_CONFIGURATION, 'READ_MACHINE_CONFIGURATION'],
  [MSG_READ_FIRMWARE_VERSION, 'READ_FIRMWARE_VERSION'],
  [MSG_READ_SAMPLE_PROFILE, 'READ_SAMPLE_PROFILE'],
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

/** `'WRITE_MOTION_ENABLE(21)'`, or `'cmd(99)'` for anything unmapped. */
export function commandName(command: number): string {
  const name = NAMES.get(command);
  return name ? `${name}(${command})` : `cmd(${command})`;
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
