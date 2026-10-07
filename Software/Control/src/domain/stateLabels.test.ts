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
      expect: {
        'hint-present': 'each has a non-empty hint',
        'badge-is-text': 'each badge label is text, never a bare number',
      },
      why: { 'badge-is-text': 'the badge shown to the operator is the fault name' },
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
      expect: {
        'hint-present': 'each has a non-empty hint',
        'badge-present': 'each has a non-empty badge label',
      },
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
      given: 'the app\'s fault reasons and the machine\'s fault reasons, including force-gauge communication',
      expect: {
        'ordinals-match': 'each reason has the same number on both sides',
        'user-request-has-hint': 'a user-requested disable also carries a hint',
      },
      why: {
        'user-request-has-hint': 'user-requested disable exists only in the app, and it still needs a hint',
      },
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
      expect(FaultedReason.SERVO_STALL).toBe(ProtoFault.SERVO_STALL);

      // Structural, not name-by-name: every wire variant must sit at the same
      // ordinal here, so a variant added to the schema and forgotten here is
      // caught without anyone remembering to extend the list above.
      const wireNames = Object.keys(ProtoFault).filter((k) => Number.isNaN(Number(k)));
      for (const name of wireNames) {
        expect(
          (FaultedReason as unknown as Record<string, number>)[name],
          `wire fault ${name} must exist here at the same ordinal`,
        ).toBe((ProtoFault as unknown as Record<string, number>)[name]);
      }

      // USER_REQUEST is domain-only -- the firmware never sends it -- so it
      // must stay PAST the end of the wire enum. When it sat on the next free
      // ordinal, adding SERVO_STALL to the schema would have put a real stall
      // from the machine on the same value, and the UI would have reported a
      // jammed carriage as the operator's own button press.
      expect(FaultedReason.USER_REQUEST).toBeGreaterThanOrEqual(wireNames.length);
      expect(FAULT_HINTS[FaultedReason.USER_REQUEST]).toBeTruthy();
      expect(FAULT_HINTS[FaultedReason.SERVO_STALL]).toBeTruthy();
    },
  );

  behaviour(
    {
      id: 'labels.restriction-ordinals-match-wire',
      covers: 'src/domain/types.ts#RestrictedReason',
      given: 'the app\'s restriction reasons and the machine\'s restriction reasons',
      expect: { 'ordinals-match': 'each reason has the same number on both sides' },
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
      expect: {
        'badge-spelling': 'the badge reads FORCE_GAUGE_COMMUNICATION',
        'hint-names-force-gauge': 'the hint mentions the force gauge',
      },
      why: { 'badge-spelling': 'the badge is the fault name shown to the operator' },
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

  // C2: Live.tsx puts these strings on the Fault / Restriction badge `title`.
  behaviour(
    {
      id: 'labels.cog-hint-is-a-stopped-processor-core',
      covers: 'src/domain/stateLabels.ts#FAULT_HINTS',
      given: 'a processor-core fault on the machine controller',
      expect: {
        'hint-names-a-stopped-core':
          'the hint says a processor core in the machine controller stopped running',
      },
      why: {
        'hint-names-a-stopped-core':
          'COG is a Propeller 2 processor core; the live-screen tooltip is what the operator reads',
      },
    },
    () => {
      const hint = FAULT_HINTS[FaultedReason.COG].toLowerCase();
      expect(hint).toMatch(/processor|core/);
      expect(hint).not.toMatch(/motor/);
      expect(hint).not.toMatch(/cogging/);
    },
  );

  behaviour(
    {
      id: 'labels.tooltip-is-longer-than-the-badge',
      covers: 'src/domain/stateLabels.ts#FAULT_HINTS',
      given: 'every fault and restriction the live screen can badge',
      expect: {
        'fault-tooltip-longer': 'every fault tooltip is longer than its short badge name',
        'restriction-tooltip-longer':
          'every restriction tooltip is longer than its short badge name',
      },
    },
    () => {
      const faults = Object.values(FaultedReason).filter((v): v is number => typeof v === 'number');
      for (const v of faults) {
        const badge = faultBadgeLabel(v as FaultedReason);
        const hint = FAULT_HINTS[v as FaultedReason];
        expect(hint.length, `FAULT_HINTS[${badge}] is not explanatory`).toBeGreaterThan(badge.length);
      }
      const restrictions = Object.values(RestrictedReason).filter(
        (v): v is number => typeof v === 'number',
      );
      for (const v of restrictions) {
        const badge = restrictionBadgeLabel(v as RestrictedReason);
        const hint = RESTRICTION_HINTS[v as RestrictedReason];
        expect(
          hint.length,
          `RESTRICTION_HINTS[${badge}] is not explanatory`,
        ).toBeGreaterThan(badge.length);
      }
    },
  );
});
