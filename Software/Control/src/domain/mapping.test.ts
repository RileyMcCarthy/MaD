import { describe, it, expect } from 'vitest';
import {
  configToShared,
  configFromShared,
  sampleToShared,
  stateToShared,
  sampleProfileToShared,
  sampleProfileFromShared,
  notificationToShared,
} from './mapping';
import { NotificationType } from './types';
import {
  NotificationType as ProtoNotificationType,
  MachineConfiguration as ProtoConfig,
  SampleProfile as ProtoSampleProfile,
} from '@/protocol/generated/protoemb';

describe('proto ↔ display mapping', () => {
  it('machine configuration round-trips', () => {
    const proto: ProtoConfig = {
      name: 'M1',
      encoderStepsPerMM: 200,
      servoStepsPerMM: 400,
      loadCellCapacity: 100,
      loadCellSensitivity: 1000000,
      loadCellZeroBalance: 5000,
      maxPosition: 250,
      maxVelocity: 50,
      maxAcceleration: 100,
      maxForceTensile: 1234.5,
      homingVelocity: 5,
      homingOffset: 2,
      jawOffset: 3,
    };
    const shared = configToShared(proto);
    expect(shared.Name).toBe('M1');
    expect(shared['Tensile Force Max (N)']).toBe(1234.5);
    expect(shared['Load Cell Sensitivity (mV/V)']).toBe(1);
    expect(shared['Load Cell Zero Balance (mV/V)']).toBe(0.005);
    expect(configFromShared(shared)).toEqual(proto);
  });

  it('sample maps to display keys', () => {
    const s = sampleToShared({
      machineForce: 1,
      machinePosition: 2,
      machineSetpoint: 3,
      sampleForce: 4,
      samplePosition: 5,
    });
    expect(s['Machine Force (N)']).toBe(1);
    expect(s['Sample Position (mm)']).toBe(5);
  });

  it('state maps flags', () => {
    const st = stateToShared({ faultedReason: 2, restrictedReason: 1, testRunning: true, motionEnabled: false } as never);
    expect(st.testRunning).toBe(true);
    expect(st.motionEnabled).toBe(false);
  });

  it('sample profile round-trips (serial is UI-only)', () => {
    const proto: ProtoSampleProfile = {
      maxForce: 500,
      maxVelocity: 10,
      maxDisplacement: 20,
      sampleWidth: 2,
      sampleThickness: 1,
    };
    const shared = sampleProfileToShared(proto);
    expect(shared.serial).toBe('');
    expect(sampleProfileFromShared(shared)).toEqual(proto);
  });

  it('notification severity maps', () => {
    expect(notificationToShared({ type: ProtoNotificationType.ERROR, message: 'x' }).Type).toBe(NotificationType.ERROR);
    expect(notificationToShared({ type: ProtoNotificationType.WARNING, message: 'x' }).Type).toBe(NotificationType.WARN);
    expect(notificationToShared({ type: ProtoNotificationType.SUCCESS, message: 'x' }).Type).toBe(NotificationType.SUCCESS);
  });
});
