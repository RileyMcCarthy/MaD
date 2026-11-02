import type { CategoryLogger } from '@/diagnostics/log';

/** How long the freshly flashed firmware gets to come up before reconnecting. */
export const RECONNECT_SETTLE_MS = 1500;

/** Why a flash on the control port is refused, fit for the screen. */
export const FLASH_ON_CONTROL_PORT =
  'That is the control port, the one MaD Control is connected through. Firmware is written over the ' +
  "programming port: the Prop Plug on header J1, or the P2-EVAL's own USB. Choose that port to flash.";

/**
 * Everything {@link flashWithSession} touches, injected so each path can be
 * tested with plain fakes: no board, no Web Serial, no timers.
 */
export interface FlashWithSessionDeps<P, R> {
  /** The control port the main device session holds, or null when it holds none. */
  heldPort: P | null;
  /** The programming port being flashed. */
  target: P;
  /** A name for the port in the `port-left-open` warning. */
  targetLabel: string;
  /** Stop the main device session for the flash. */
  disconnect: () => Promise<void>;
  /** Program the target port. */
  program: (port: P) => Promise<R>;
  /** Close the flash port; resolves false when it stayed open. */
  closePort: (port: P) => Promise<boolean>;
  /** Reconnect the main session to the given (control) port. */
  connect: (port: P) => Promise<void>;
  /** Wait before reconnecting (the firmware's boot). */
  wait: (ms: number) => Promise<void>;
  /** Where `port-left-open` goes. */
  log: Pick<CategoryLogger, 'warn'>;
  /** The flash worked; called before any reconnect. */
  onDone: (result: R) => void;
  /** The flash was refused, or the disconnect, the flash or the close failed;
   *  called before any reconnect. */
  onError: (err: unknown) => void;
}

/**
 * Flash `target`, the programming port, around the main device session.
 *
 * The two are different ports. The session talks to the firmware on the
 * control port (the secondary serial, which never resets the chip); firmware is
 * written over the programming port (J1, whose adapter's DTR resets it). The
 * flash reboots the chip, so a running session is stopped first and, once the
 * new firmware has had time to boot, reconnected to its own control port, never
 * to the programming port, whatever the flash did: a failed flash leaves the
 * firmware the board already had. Flashing the port the session holds is
 * refused before anything is touched. The flash port is always closed
 * afterwards.
 */
export async function flashWithSession<P, R>(deps: FlashWithSessionDeps<P, R>): Promise<void> {
  if (deps.heldPort !== null && deps.heldPort === deps.target) {
    deps.onError(new Error(FLASH_ON_CONTROL_PORT));
    return;
  }
  const controlPort = deps.heldPort;
  // Set once the session has been stopped; it is then always reconnected.
  let paused = false;
  try {
    if (controlPort !== null) {
      await deps.disconnect();
      paused = true;
    }

    let result: R;
    try {
      result = await deps.program(deps.target);
    } finally {
      // The page opened this port; it must not keep it, whatever happened.
      if (!(await deps.closePort(deps.target))) {
        deps.log.warn('port-left-open', 'the flash port did not close; unplug and replug the adapter', {
          port: deps.targetLabel,
        });
      }
    }
    deps.onDone(result);
  } catch (err) {
    deps.onError(err);
  }

  if (paused && controlPort !== null) {
    await deps.wait(RECONNECT_SETTLE_MS);
    await deps.connect(controlPort);
  }
}
