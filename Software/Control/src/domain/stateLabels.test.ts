import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { FaultedReason, RestrictedReason } from './types';
import {
  FAULT_HINTS,
  RESTRICTION_HINTS,
  faultBadgeLabel,
  restrictionBadgeLabel,
} from './stateLabels';
import { FaultedReason as ProtoFault, RestrictedReason as ProtoRestriction } from '@/protocol/generated/protoemb';

describe('fault / restriction label lockstep', () => {
  behaviour(
    {
      id: 'labels.fault-has-hint-and-badge',
      covers: 'src/domain/stateLabels.ts#faultBadgeLabel',
      given: 'every fault reason the machine can report',
      then: 'every fault reason has a non-empty hint and a textual badge label',
      why: 'the badge shown to the operator is the fault name',
    },
    () => {
      const values = Object.values(FaultedReason).filter((v): v is number => typeof v === 'number');
      expect(values.length).toBeGreaterThanOrEqual(9);
      for (const v of values) {
        const hint = FAULT_HINTS[v as FaultedReason];
        expect(hint, `missing FAULT_HINTS[${v}]`).toBeTruthy();
        expect(typeof hint).toBe('string');
        expect(hint.length).toBeGreaterThan(0);
        const badge = faultBadgeLabel(v as FaultedReason);
        expect(typeof badge).toBe('string');
        expect(badge).not.toMatch(/^\d+$/); // never raw numeric object-render trap
      }
    },
  );

  behaviour(
    {
      id: 'labels.restriction-has-hint-and-badge',
      covers: 'src/domain/stateLabels.ts#restrictionBadgeLabel',
      given: 'every restriction reason the machine can report',
      then: 'every restriction reason has a non-empty hint and a textual badge label',
    },
    () => {
      const values = Object.values(RestrictedReason).filter((v): v is number => typeof v === 'number');
      expect(values.length).toBeGreaterThanOrEqual(7);
      for (const v of values) {
        const hint = RESTRICTION_HINTS[v as RestrictedReason];
        expect(hint, `missing RESTRICTION_HINTS[${v}]`).toBeTruthy();
        expect(typeof hint).toBe('string');
        const badge = restrictionBadgeLabel(v as RestrictedReason);
        expect(typeof badge).toBe('string');
        expect(badge.length).toBeGreaterThan(0);
      }
    },
  );

  behaviour(
    {
      id: 'labels.fault-ordinals-match-wire',
      covers: 'src/domain/stateLabels.ts#FAULT_HINTS',
      given: 'the domain fault reasons and the machine fault reasons, including force-gauge communication',
      then: 'domain fault reason numbers match the machine fault reason numbers, and a user-requested disable still has a hint',
      why: 'user-requested disable exists only in the app, and it still needs a hint',
    },
    () => {
      expect(FaultedReason.NONE).toBe(ProtoFault.NONE);
      expect(FaultedReason.COG).toBe(ProtoFault.COG);
      expect(FaultedReason.WATCHDOG).toBe(ProtoFault.WATCHDOG);
      expect(FaultedReason.ESD_POWER).toBe(ProtoFault.ESD_POWER);
      expect(FaultedReason.ESD_SWITCH).toBe(ProtoFault.ESD_SWITCH);
      expect(FaultedReason.ESD_UPPER).toBe(ProtoFault.ESD_UPPER);
      expect(FaultedReason.ESD_LOWER).toBe(ProtoFault.ESD_LOWER);
      expect(FaultedReason.SERVO_COMMUNICATION).toBe(ProtoFault.SERVO_COMMUNICATION);
      expect(FaultedReason.FORCE_GAUGE_COMMUNICATION).toBe(ProtoFault.FORCE_GAUGE_COMMUNICATION);
      // USER_REQUEST is a domain-only extension beyond the wire enum; still has a hint.
      expect(FAULT_HINTS[FaultedReason.USER_REQUEST]).toBeTruthy();
    },
  );

  behaviour(
    {
      id: 'labels.restriction-ordinals-match-wire',
      covers: 'src/domain/types.ts#RestrictedReason',
      given: 'the domain restriction reasons and the machine restriction reasons',
      then: 'domain restriction reason numbers match the machine restriction reason numbers',
    },
    () => {
      expect(RestrictedReason.NONE).toBe(ProtoRestriction.NONE);
      expect(RestrictedReason.SAMPLE_LENGTH).toBe(ProtoRestriction.SAMPLE_LENGTH);
      expect(RestrictedReason.SAMPLE_TENSION).toBe(ProtoRestriction.SAMPLE_TENSION);
      expect(RestrictedReason.MACHINE_TENSION).toBe(ProtoRestriction.MACHINE_TENSION);
      expect(RestrictedReason.UPPER_ENDSTOP).toBe(ProtoRestriction.UPPER_ENDSTOP);
      expect(RestrictedReason.LOWER_ENDSTOP).toBe(ProtoRestriction.LOWER_ENDSTOP);
      expect(RestrictedReason.DOOR).toBe(ProtoRestriction.DOOR);
    },
  );

  behaviour(
    {
      id: 'labels.force-gauge-fault-spelling',
      covers: 'src/domain/stateLabels.ts#faultBadgeLabel',
      given: 'a force-gauge communication fault',
      then: 'a force-gauge communication fault is labelled FORCE_GAUGE_COMMUNICATION, and its hint mentions the force gauge',
      why: 'the badge is the fault name shown to the operator',
    },
    () => {
      expect(faultBadgeLabel(FaultedReason.FORCE_GAUGE_COMMUNICATION)).toBe(
        'FORCE_GAUGE_COMMUNICATION',
      );
      expect(FAULT_HINTS[FaultedReason.FORCE_GAUGE_COMMUNICATION].toLowerCase()).toContain(
        'force gauge',
      );
    },
  );
});
