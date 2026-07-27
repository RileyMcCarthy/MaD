import { describe, it, expect } from 'vitest';
import { FaultedReason, RestrictedReason } from './types';
import {
  FAULT_HINTS,
  RESTRICTION_HINTS,
  faultBadgeLabel,
  restrictionBadgeLabel,
} from './stateLabels';
import { FaultedReason as ProtoFault, RestrictedReason as ProtoRestriction } from '@/protocol/generated/protoemb';

describe('fault / restriction label lockstep', () => {
  it('every FaultedReason has a non-empty hint and string badge label', () => {
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
  });

  it('every RestrictedReason has a non-empty hint and string badge label', () => {
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
  });

  it('domain FaultedReason ordinals match generated proto enum (incl. FORCE_GAUGE_COMMUNICATION)', () => {
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
  });

  it('domain RestrictedReason ordinals match generated proto enum', () => {
    expect(RestrictedReason.NONE).toBe(ProtoRestriction.NONE);
    expect(RestrictedReason.SAMPLE_LENGTH).toBe(ProtoRestriction.SAMPLE_LENGTH);
    expect(RestrictedReason.SAMPLE_TENSION).toBe(ProtoRestriction.SAMPLE_TENSION);
    expect(RestrictedReason.MACHINE_TENSION).toBe(ProtoRestriction.MACHINE_TENSION);
    expect(RestrictedReason.UPPER_ENDSTOP).toBe(ProtoRestriction.UPPER_ENDSTOP);
    expect(RestrictedReason.LOWER_ENDSTOP).toBe(ProtoRestriction.LOWER_ENDSTOP);
    expect(RestrictedReason.DOOR).toBe(ProtoRestriction.DOOR);
  });

  it('FORCE_GAUGE_COMMUNICATION badge is the correct spelling (not a typo variant)', () => {
    expect(faultBadgeLabel(FaultedReason.FORCE_GAUGE_COMMUNICATION)).toBe(
      'FORCE_GAUGE_COMMUNICATION',
    );
    expect(FAULT_HINTS[FaultedReason.FORCE_GAUGE_COMMUNICATION].toLowerCase()).toContain(
      'force gauge',
    );
  });
});
