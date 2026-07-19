/**
 * Human-readable labels for machine fault/restriction enums.
 *
 * Kept as a pure domain module (not inline in Live.tsx) so unit tests can
 * lockstep every proto enum value to a non-empty display string — the class
 * of bug that once broke FORCE_GAUGE_COMMUNICATION via a spelling drift.
 */

import { FaultedReason, RestrictedReason } from './types';

export const FAULT_HINTS: Record<FaultedReason, string> = {
  [FaultedReason.NONE]: 'No faults detected.',
  [FaultedReason.COG]: 'Cogging detected in the machine.',
  [FaultedReason.WATCHDOG]: 'Watchdog timer triggered.',
  [FaultedReason.ESD_POWER]: 'ESD power fault detected.',
  [FaultedReason.ESD_SWITCH]: 'ESD switch fault detected.',
  [FaultedReason.ESD_UPPER]: 'Upper ESD fault detected.',
  [FaultedReason.ESD_LOWER]: 'Lower ESD fault detected.',
  [FaultedReason.SERVO_COMMUNICATION]: 'Servo communication fault detected.',
  [FaultedReason.FORCE_GAUGE_COMMUNICATION]: 'Force gauge communication fault detected.',
  [FaultedReason.USER_REQUEST]: 'User requested to disable the machine.',
};

export const RESTRICTION_HINTS: Record<RestrictedReason, string> = {
  [RestrictedReason.NONE]: 'No restrictions detected.',
  [RestrictedReason.SAMPLE_LENGTH]: 'Sample length restriction.',
  [RestrictedReason.SAMPLE_TENSION]: 'Sample tension restriction.',
  [RestrictedReason.MACHINE_TENSION]: 'Machine tension restriction.',
  [RestrictedReason.UPPER_ENDSTOP]: 'Upper endstop restriction.',
  [RestrictedReason.LOWER_ENDSTOP]: 'Lower endstop restriction.',
  [RestrictedReason.DOOR]: 'Door restriction.',
};

/** Enum member name used as the short badge label (must be a string, never an object). */
export function faultBadgeLabel(reason: FaultedReason): string {
  return FaultedReason[reason] ?? 'UNKNOWN';
}

export function restrictionBadgeLabel(reason: RestrictedReason): string {
  return RestrictedReason[reason] ?? 'UNKNOWN';
}
