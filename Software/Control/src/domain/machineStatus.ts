/**
 * What the Live screen tells the operator about the machine, and which manual
 * controls it allows, for a given machine state.
 *
 * One status wins, in order of how much it stops the operator:
 * unknown → faulted → test running → motion off → restricted → ready.
 * Each carries a tone (the colour the UI paints it), a headline, and the next
 * step, so the screen always says what to do rather than only what is wrong.
 *
 * Motion gating mirrors the firmware: app_motion empties its queue while motion
 * is off (app_motion.c getDesiredState), so a jog or home sent then is dropped
 * without a word. The controls are locked instead of letting that happen.
 * Zeroing force or length does not move the gantry, so it only needs a known,
 * idle machine.
 */

import { FaultedReason, RestrictedReason, type MachineState } from './types';
import { FAULT_HINTS, RESTRICTION_HINTS, faultBadgeLabel, restrictionBadgeLabel } from './stateLabels';

export type StatusTone = 'unknown' | 'fault' | 'test' | 'off' | 'restricted' | 'ready';

export interface MachineStatus {
  tone: StatusTone;
  /** Short headline, e.g. "Motion is off". */
  title: string;
  /** The next step for the operator. */
  detail: string;
  /** Jog and home are allowed. */
  canMove: boolean;
  /** Zero force / zero length are allowed. */
  canZero: boolean;
  /** Why jog/home are locked (tooltip), when they are. */
  moveBlockedReason?: string;
}

export function machineStatus(state: MachineState | null): MachineStatus {
  if (state === null) {
    return {
      tone: 'unknown',
      title: 'Waiting for the machine',
      detail: 'Controls unlock once the machine reports its state.',
      canMove: false,
      canZero: false,
      moveBlockedReason: 'Waiting for the machine to report its state.',
    };
  }
  if (state.faultedReason !== FaultedReason.NONE) {
    return {
      tone: 'fault',
      title: `Faulted: ${faultBadgeLabel(state.faultedReason)}`,
      detail: `${FAULT_HINTS[state.faultedReason]} Motion stays off until the fault clears.`,
      canMove: false,
      canZero: !state.testRunning,
      moveBlockedReason: 'The machine is faulted, so motion is off.',
    };
  }
  if (state.testRunning) {
    return {
      tone: 'test',
      title: 'Test running',
      detail: 'Manual controls are locked during a test. Use STOP (top bar) to halt.',
      canMove: false,
      canZero: false,
      moveBlockedReason: 'A test is running.',
    };
  }
  if (!state.motionEnabled) {
    return {
      tone: 'off',
      title: 'Motion is off',
      detail: 'Press Enable motion to jog or home the gantry.',
      canMove: false,
      canZero: true,
      moveBlockedReason: 'Enable motion first.',
    };
  }
  if (state.restrictedReason !== RestrictedReason.NONE) {
    return {
      tone: 'restricted',
      title: `Restricted: ${restrictionBadgeLabel(state.restrictedReason)}`,
      detail: `${RESTRICTION_HINTS[state.restrictedReason]} The gantry moves at reduced speed until it clears.`,
      canMove: true,
      canZero: true,
    };
  }
  return {
    tone: 'ready',
    title: 'Ready',
    detail: 'Motion is on. Jog, home, or start a test.',
    canMove: true,
    canZero: true,
  };
}
