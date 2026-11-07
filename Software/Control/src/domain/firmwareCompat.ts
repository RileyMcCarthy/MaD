/**
 * Whether this app can drive the firmware it is connected to.
 *
 * Compatibility rests on the protocol version both sides are generated from
 * (`protocol_version` in Protocol/MaDProtocol.yaml): the firmware reports its
 * number in the device-info handshake and the app was built with its own
 * (`PROTOCOL_VERSION`). The number is bumped on every wire-incompatible
 * change, so any difference means the two cannot talk safely, whichever side
 * is ahead. Nothing here is a hand-kept list of firmware versions.
 *
 * `minFirmware` (src/domain/compat.json) is the one hand-kept input: a floor
 * for fixes that did not change the protocol. Falling below it only
 * recommends an update.
 *
 * Motion fails closed: from the moment a connection opens until the firmware
 * answers with a protocol this app speaks, nothing that moves the gantry is
 * sent. A firmware that never answers stays blocked.
 */

import compat from './compat.json';

/** The recommended minimum firmware from compat.json; null when there is none. */
export const MIN_FIRMWARE: string | null = (compat as { minFirmware: string | null }).minFirmware;

export type FirmwareCompat =
  /** The question is on its way: the connection is open, the answer not in. */
  | { kind: 'checking' }
  /** The firmware never answered the question (nor refused it). */
  | { kind: 'unanswered' }
  /** Same protocol, and at or above any minimum firmware. */
  | { kind: 'ok' }
  /** The firmware speaks an older protocol, or predates the handshake (`deviceProtocol` null). */
  | { kind: 'firmwareTooOld'; deviceProtocol: number | null; appProtocol: number }
  /** The firmware speaks a newer protocol than this app. */
  | { kind: 'appTooOld'; deviceProtocol: number; appProtocol: number }
  /** Same protocol, but older than a fix this app recommends. */
  | { kind: 'belowMinFirmware'; firmwareVersion: string; minFirmware: string };

export interface FirmwareCompatInput {
  /**
   * The protocol version the firmware reported, or null when it refused the
   * device-info read: firmware from before the handshake existed.
   */
  deviceProtocol: number | null;
  /** The version string the firmware reported, when it answered. */
  deviceFirmware: string | null;
  /** The protocol version this app was generated from. */
  appProtocol: number;
  /** Lowest recommended firmware version for this protocol, if any. */
  minFirmware?: string | null;
}

/** The version a firmware built without a release stamp reports. */
export const UNSTAMPED_FIRMWARE_VERSION = '0.0.0';

/**
 * A firmware release version (`0.13`, `1.2.0`, optionally `v`-prefixed) as
 * numbers, or null for anything else, such as a CI build's `dev-123`.
 */
export function parseFirmwareVersion(version: string): number[] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareFirmwareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Whether a firmware is below the recommended minimum. A developer build
 * (unstamped, or not a release version) is never held to it: its number says
 * nothing about which fixes it carries.
 */
function belowMinimum(firmware: string | null, minimum: string | null | undefined): boolean {
  if (!firmware || !minimum || firmware === UNSTAMPED_FIRMWARE_VERSION) return false;
  const have = parseFirmwareVersion(firmware);
  const want = parseFirmwareVersion(minimum);
  if (!have || !want) return false;
  return compareFirmwareVersions(have, want) < 0;
}

export function checkFirmwareCompat(input: FirmwareCompatInput): FirmwareCompat {
  const { deviceProtocol, deviceFirmware, appProtocol, minFirmware } = input;
  if (deviceProtocol === null || deviceProtocol < appProtocol) {
    return { kind: 'firmwareTooOld', deviceProtocol, appProtocol };
  }
  if (deviceProtocol > appProtocol) {
    return { kind: 'appTooOld', deviceProtocol, appProtocol };
  }
  if (belowMinimum(deviceFirmware, minFirmware)) {
    return { kind: 'belowMinFirmware', firmwareVersion: deviceFirmware!, minFirmware: minFirmware! };
  }
  return { kind: 'ok' };
}

/** The verdict while the question is on its way. */
export const CHECKING: FirmwareCompat = { kind: 'checking' };

/**
 * Whether a verdict means the app must not move the machine: every verdict but
 * a match. No verdict (null) means no connection, so nothing to move.
 */
export function blocksMotion(compat: FirmwareCompat | null): boolean {
  return compat !== null && compat.kind !== 'ok' && compat.kind !== 'belowMinFirmware';
}

/** One sentence for the operator: what is wrong, and what to do about it. */
export function describeFirmwareCompat(compat: FirmwareCompat): string {
  switch (compat.kind) {
    case 'checking':
      return "Checking which protocol the machine's firmware speaks. Motion stays disabled until it answers.";
    case 'unanswered':
      return "The machine's firmware did not say which protocol it speaks, so this app cannot tell whether it can drive it. Motion is disabled: check the connection and reconnect, or update the firmware.";
    case 'ok':
      return 'The firmware matches this version of MaD Control.';
    case 'firmwareTooOld':
      return compat.deviceProtocol === null
        ? `The machine's firmware is too old for this version of MaD Control (it does not report a protocol; this app needs protocol ${compat.appProtocol}). Motion is disabled until the firmware is updated.`
        : `The machine's firmware is too old for this version of MaD Control (protocol ${compat.deviceProtocol}; this app needs ${compat.appProtocol}). Motion is disabled until the firmware is updated.`;
    case 'appTooOld':
      return `The machine's firmware is newer than this version of MaD Control (protocol ${compat.deviceProtocol}; this app speaks ${compat.appProtocol}). Motion is disabled: open a MaD Control that speaks protocol ${compat.deviceProtocol}, or install firmware for this app.`;
    case 'belowMinFirmware':
      return `A firmware update is recommended: ${compat.firmwareVersion} is older than ${compat.minFirmware}, the oldest this version of MaD Control recommends.`;
  }
}

/**
 * Which way out an app too old for its firmware has, once it knows: `release`
 * is the newest released MaD Control that speaks the firmware's protocol, or
 * null when there is none to offer (no release speaks it, or this copy is not
 * a release and has no list to look in). A firmware no release speaks is
 * built from ahead of every release, so its way out is this app's firmware.
 */
export function describeAppForFirmware(deviceProtocol: number, release: string | null): string {
  return release === null
    ? `No released MaD Control speaks protocol ${deviceProtocol}, so the machine is probably running a development firmware build.`
    : `MaD Control ${release} speaks protocol ${deviceProtocol}.`;
}
