/**
 * Payload-size check between the connected firmware and this app's schema.
 *
 * The firmware sends every fixed-size reply at exactly its generated wire size
 * (and refuses requests of any other size), so a reply whose length differs
 * was encoded against a different `MaDProtocol.yaml` — an older or newer
 * firmware. Decoding it anyway either throws (DataView-based structs) or reads
 * the missing bytes as zero (bit-packed structs), so such a reply is rejected
 * before it reaches the codec and reported to the user instead.
 */

import {
  MSG_READ_SAMPLE,
  MSG_READ_STATE,
  MSG_READ_MACHINE_CONFIGURATION,
  MSG_READ_SAMPLE_PROFILE,
  SAMPLE_WIRE_SIZE,
  MACHINESTATE_WIRE_SIZE,
  MACHINECONFIGURATION_WIRE_SIZE,
  SAMPLEPROFILE_WIRE_SIZE,
} from '@/protocol/generated/protoemb';

/** A reply whose length does not match this app's schema. */
export interface PayloadMismatch {
  command: number;
  /** Plain-language name of the record, for the user-facing message. */
  name: string;
  expected: number;
  actual: number;
}

/** Fixed-size read replies, by command. The firmware version is deliberately
 *  absent: it is a plain string, decoded at any length, and it is what names
 *  the firmware in the mismatch message. */
const FIXED_READ_REPLIES: ReadonlyMap<number, { name: string; bytes: number }> = new Map([
  [MSG_READ_SAMPLE, { name: 'sample', bytes: SAMPLE_WIRE_SIZE }],
  [MSG_READ_STATE, { name: 'machine state', bytes: MACHINESTATE_WIRE_SIZE }],
  [MSG_READ_MACHINE_CONFIGURATION, { name: 'machine configuration', bytes: MACHINECONFIGURATION_WIRE_SIZE }],
  [MSG_READ_SAMPLE_PROFILE, { name: 'sample profile', bytes: SAMPLEPROFILE_WIRE_SIZE }],
]);

/** The size this app's schema expects for a read reply, if it is fixed. */
export function expectedReadReplyBytes(command: number): number | undefined {
  return FIXED_READ_REPLIES.get(command)?.bytes;
}

/** The mismatch for a read reply, or null when its length is the schema's. */
export function readReplyMismatch(command: number, payload: Uint8Array): PayloadMismatch | null {
  const spec = FIXED_READ_REPLIES.get(command);
  if (spec === undefined || payload.length === spec.bytes) return null;
  return { command, name: spec.name, expected: spec.bytes, actual: payload.length };
}

/** What the user is told when the firmware's payloads do not fit this app. */
export function schemaMismatchMessage(mismatch: PayloadMismatch, firmwareVersion: string | null): string {
  const firmware = firmwareVersion ? `Firmware ${firmwareVersion}` : 'The connected firmware';
  const detail = `its ${mismatch.name} is ${mismatch.actual} bytes; this app expects ${mismatch.expected}`;
  return mismatch.actual < mismatch.expected
    ? `${firmware} uses an older protocol than this app (${detail}). Update the firmware.`
    : `${firmware} uses a newer protocol than this app (${detail}). Update the app.`;
}
