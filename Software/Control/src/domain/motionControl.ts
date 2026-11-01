/**
 * What the Live screen's motion button offers for a given machine state.
 *
 * The machine reports whether motion is ACTUALLY enabled, not whether it was
 * asked for. A fault forces that report to "disabled" while the machine still
 * holds the operator's earlier enable request, and app_control.c refuses every
 * enable while faulted. A button that only toggles the reported value would
 * therefore offer "Enable motion" forever on a faulted machine — and a latched
 * servo stall is cleared by nothing except a disable request.
 *
 * So a faulted machine is always offered a disable. Sending one is never
 * unsafe, it acknowledges a latched stall, and it withdraws the stale enable
 * request so motion does not come back on its own when a live fault clears.
 */

import { FaultedReason, type MachineState } from './types';

export interface MotionButton {
  /** What pressing the button sends: true asks for motion on, false for off. */
  enable: boolean;
  label: string;
}

export function motionButton(state: MachineState): MotionButton {
  if (state.faultedReason === FaultedReason.SERVO_STALL) {
    return { enable: false, label: 'Clear stall (disable motion)' };
  }
  if (state.faultedReason !== FaultedReason.NONE || state.motionEnabled) {
    return { enable: false, label: 'Disable motion' };
  }
  return { enable: true, label: 'Enable motion' };
}
