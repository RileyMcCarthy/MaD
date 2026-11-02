/**
 * The firmware check run after every connect: read the firmware's version and
 * protocol, decide whether this app can drive it (src/domain/firmwareCompat.ts),
 * and block motion at the device client when it cannot.
 *
 * Kept out of useStore so the sequence can be tested without the store's
 * singletons; the store passes the real device client and its retrying read.
 */

import {
  blocksMotion,
  checkFirmwareCompat,
  describeFirmwareCompat,
  type FirmwareCompat,
} from '@/domain';
import { logger } from '@/diagnostics/log';

export interface FirmwareCheckClient {
  readFirmwareVersion(): Promise<string>;
  readDeviceInfo(): Promise<{ protocolVersion: number } | null>;
  setMotionBlock(reason: string | null): void;
}

export interface FirmwareCheckPatch {
  firmwareVersion?: string;
  deviceProtocol?: number | null;
  firmwareCompat?: FirmwareCompat | null;
}

export interface FirmwareCheckOptions {
  client: FirmwareCheckClient;
  /** A device read retried over transient misses; undefined when every attempt missed. */
  read: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  /** False once the connection this check belongs to has been replaced. */
  isCurrent: () => boolean;
  apply: (patch: FirmwareCheckPatch) => void;
  appProtocol: number;
  minFirmware: string | null;
}

const log = logger('store');

/**
 * Firmware on another protocol has every motion command refused until a later
 * check says otherwise. A board that never answers the handshake leaves no
 * verdict: the link is not working, and nothing is blocked on a guess.
 */
export async function checkConnectedFirmware(opts: FirmwareCheckOptions): Promise<void> {
  const { client, read, isCurrent, apply, appProtocol, minFirmware } = opts;
  const version = await read(() => client.readFirmwareVersion());
  if (!isCurrent()) return;
  if (version) apply({ firmwareVersion: version });
  // undefined: no answer at all. null: refused, i.e. firmware from before the handshake.
  const info = await read(() => client.readDeviceInfo());
  if (!isCurrent()) return;
  if (info === undefined) {
    log.warn('firmware-compat', 'no reply to the device-info read');
    client.setMotionBlock(null);
    apply({ firmwareCompat: null, deviceProtocol: null });
    return;
  }
  const deviceProtocol = info?.protocolVersion ?? null;
  const compat = checkFirmwareCompat({
    deviceProtocol,
    deviceFirmware: version ?? null,
    appProtocol,
    minFirmware,
  });
  const data = { verdict: compat.kind, deviceProtocol, appProtocol, firmware: version ?? null };
  if (compat.kind === 'ok') log.info('firmware-compat', undefined, data);
  else log.warn('firmware-compat', describeFirmwareCompat(compat), data);
  client.setMotionBlock(blocksMotion(compat) ? describeFirmwareCompat(compat) : null);
  apply({ firmwareCompat: compat, deviceProtocol });
}
