/**
 * Make sure a port the Firmware page opened for flashing is closed again.
 *
 * The loader's own teardown is time-boxed so a wedged port cannot hang the
 * page, which means it can give up with the port still open. Left that way,
 * the port stays claimed by this page: the next connect or flash fails with
 * "The port is already open", and on a P2-EVAL every later open resets the
 * board. One more close is tried; whether it worked is reported to the caller.
 */
export async function closeFlashPort(port: Pick<SerialPort, 'readable' | 'writable' | 'close'>): Promise<boolean> {
  if (port.readable === null && port.writable === null) return true;
  try {
    await port.close();
  } catch {
    /* streams still locked, or the device is gone */
  }
  return port.readable === null && port.writable === null;
}
