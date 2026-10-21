import type { CategoryLogger } from '@/diagnostics/log';

/** How long the freshly flashed firmware gets to come up before reconnecting. */
export const RECONNECT_SETTLE_MS = 1500;

/**
 * Everything {@link flashWithSession} touches, injected so each path can be
 * tested with plain fakes: no board, no Web Serial, no timers.
 */
export interface FlashWithSessionDeps<P, R> {
  /** The port the main device session holds, or null when it holds none. */
  heldPort: P | null;
  /** The port being flashed. */
  target: P;
  /** A name for the port in the `port-left-open` warning. */
  targetLabel: string;
  /** Stop the main device session so its port is free. */
  disconnect: () => Promise<void>;
  /** Program the target port. */
  program: (port: P) => Promise<R>;
  /** Close the flash port; resolves false when it stayed open. */
  closePort: (port: P) => Promise<boolean>;
  /** Reconnect the main session to the given port. */
  connect: (port: P) => Promise<void>;
  /** Wait before reconnecting (the firmware's boot). */
  wait: (ms: number) => Promise<void>;
  /** Where `port-left-open` goes. */
  log: Pick<CategoryLogger, 'warn'>;
  /** The flash worked; called before any reconnect. */
  onDone: (result: R) => void;
  /** The disconnect, the flash or the close failed; called before any reconnect. */
  onError: (err: unknown) => void;
}

/**
 * Flash `target`, handing the main device session's port over and back.
 *
 * The session is touched only when it holds the port being flashed (one
 * adapter for both). Flashing over a separate programming adapter, as on the
 * MadEdge PCBA, leaves the main connection running. The flash port is always
 * closed afterwards, whatever happened. Once the session has handed its port
 * over, it is always reconnected to that same port (no chooser), even after a
 * failed flash, so the user is never left disconnected by a flash.
 */
export async function flashWithSession<P, R>(deps: FlashWithSessionDeps<P, R>): Promise<void> {
  const sharesPort = deps.heldPort !== null && deps.heldPort === deps.target;
  // Set once the session has handed its port over; it is then always given
  // back afterwards, whether the flash worked or not.
  let tookSessionPort = false;
  try {
    // On a shared port the worker holds the streams (also while connecting or
    // after a lost link), and the chip reboots, so that session has to go.
    if (sharesPort) {
      await deps.disconnect();
      tookSessionPort = true;
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

  if (tookSessionPort) {
    await deps.wait(RECONNECT_SETTLE_MS);
    await deps.connect(deps.target);
  }
}
