/**
 * Choosing and remembering which serial port to program through.
 *
 * Programming is the one destructive thing this app does, and Web Serial gives
 * us almost nothing to identify a port with: `getInfo()` returns only USB
 * vendor/product IDs — no serial number, no device path. Two identical FTDI
 * adapters are therefore indistinguishable in code.
 *
 * So the rule here is: never silently guess. Resolve to a port only when the
 * choice is unambiguous, otherwise make the user pick, and always hand back a
 * label the UI can show so a wrong guess is visible before anything is written.
 */

const FLASH_PORT_KEY = 'mad.flashPort';

interface FlashPortPref {
  vendorId?: number;
  productId?: number;
  /**
   * Position within `getPorts()` when it was chosen. Only a tiebreaker for
   * identical VID/PID pairs — ordering is not guaranteed stable across
   * sessions, so a match on this alone is never trusted.
   */
  index: number;
}

/** Human-readable identity for a port, matching the Connect screen's style. */
export function describePort(port: SerialPort, index = 0): string {
  const info = port.getInfo();
  if (info.usbVendorId === undefined) return `Serial device ${index + 1}`;
  const vid = info.usbVendorId.toString(16).padStart(4, '0');
  const pid = (info.usbProductId ?? 0).toString(16).padStart(4, '0');
  return `USB ${vid}:${pid}`;
}

export function rememberFlashPort(port: SerialPort, index: number): void {
  try {
    const info = port.getInfo();
    const pref: FlashPortPref = {
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
      index,
    };
    localStorage.setItem(FLASH_PORT_KEY, JSON.stringify(pref));
  } catch {
    /* storage unavailable / quota; remembering is best-effort */
  }
}

export function readFlashPortPref(): FlashPortPref | null {
  try {
    return JSON.parse(localStorage.getItem(FLASH_PORT_KEY) ?? 'null') as FlashPortPref | null;
  } catch {
    return null;
  }
}

export function forgetFlashPort(): void {
  try {
    localStorage.removeItem(FLASH_PORT_KEY);
  } catch {
    /* nothing to do */
  }
}

export type PortResolution =
  | { kind: 'resolved'; port: SerialPort; index: number; reason: 'only-port' | 'remembered' }
  | { kind: 'ambiguous'; ports: SerialPort[] }
  | { kind: 'none' };

/**
 * Work out which granted port to program, without ever picking arbitrarily.
 *
 * - exactly one granted port  → use it
 * - a remembered pref matching exactly one granted port → use it
 * - anything else → report ambiguity so the UI asks
 *
 * Deliberately does NOT fall back to "the first one", which is how you flash
 * the wrong device on a bench with two adapters plugged in.
 */
export function resolveFlashPort(ports: SerialPort[], pref = readFlashPortPref()): PortResolution {
  if (ports.length === 0) return { kind: 'none' };
  if (ports.length === 1) return { kind: 'resolved', port: ports[0], index: 0, reason: 'only-port' };

  if (pref?.vendorId !== undefined) {
    const matches = ports
      .map((port, index) => ({ port, index }))
      .filter(({ port }) => {
        const info = port.getInfo();
        return info.usbVendorId === pref.vendorId && info.usbProductId === pref.productId;
      });
    if (matches.length === 1) {
      return { kind: 'resolved', ...matches[0], reason: 'remembered' };
    }
    // Several identical adapters: fall back to the recorded slot, but only if
    // that slot still holds one of the matching devices.
    const bySlot = matches.find(({ index }) => index === pref.index);
    if (bySlot) return { kind: 'resolved', ...bySlot, reason: 'remembered' };
  }

  return { kind: 'ambiguous', ports };
}

/** The P2 has 512 KiB of hub RAM; an image larger than that cannot be loaded. */
export const MAX_IMAGE_BYTES = 512 * 1024;

/**
 * Cheap sanity check on a user-picked file, so an obviously wrong choice is
 * caught before the chip is reset rather than part-way through a flash write.
 */
export function validateFirmwareFile(size: number): string | null {
  if (size === 0) return 'That file is empty.';
  if (size > MAX_IMAGE_BYTES) {
    return `That file is ${size.toLocaleString()} bytes, larger than the Propeller 2's ${MAX_IMAGE_BYTES.toLocaleString()}-byte hub RAM. It is probably not a firmware image.`;
  }
  return null;
}
