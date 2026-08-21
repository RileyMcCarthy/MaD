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
