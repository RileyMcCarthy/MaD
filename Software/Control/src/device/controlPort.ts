/**
 * Which granted port is the control port, the one the app connects through.
 *
 * The machine has two serial ports with different jobs. The control port (the
 * secondary serial: an FTDI adapter on P30/P32, or the Edge carrier's isolated
 * link) carries the protocol, and opening it never resets the machine. The
 * programming port (a Prop Plug on header J1, or the P2-EVAL's own USB) only
 * flashes firmware, and opening it resets the machine through the adapter's
 * DTR line. Web Serial identifies a port only by its USB vendor/product id, so
 * the two can look alike; the app must never open the programming port by
 * mistake on its own.
 */

/** The USB identity remembered for the control port. */
export interface ControlPortId {
  vendorId?: number;
  productId?: number;
}

/**
 * The granted port to reconnect to on its own, or null to leave the choice to
 * the user. A remembered USB id picks the one port that has it; two or more
 * with that id are never guessed between. With no id remembered (an adapter
 * that reports none), only a sole granted port is taken.
 */
export function matchControlPort(ports: readonly SerialPort[], pref: ControlPortId | null): SerialPort | null {
  if (ports.length === 0) return null;
  if (pref?.vendorId === undefined) return ports.length === 1 ? ports[0] : null;
  const byId = ports.filter((p) => {
    const i = p.getInfo();
    return i.usbVendorId === pref.vendorId && i.usbProductId === pref.productId;
  });
  return byId.length === 1 ? byId[0] : null;
}

/** What the Connect screen asks for. */
export const CONTROL_PORT_HINT =
  "Connect through the control port: the USB-serial adapter on the controller's secondary serial (P30/P32 — " +
  "on the Edge carrier, its isolated link). Opening it never restarts the machine. The Prop Plug on header J1 " +
  "(or the P2-EVAL's own USB) is the programming port: it is for the Firmware page only, and opening it restarts the machine.";

/** What the Firmware screen asks for. */
export const PROGRAMMING_PORT_HINT =
  "Flash through the programming port: the Prop Plug on header J1, or the P2-EVAL's own USB. Its DTR line resets " +
  'the board into the loader. The control port (P30/P32) cannot program the board.';
