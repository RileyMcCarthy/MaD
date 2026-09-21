import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
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
  behaviour(
    {
      id: 'mapping.config-round-trips',
      covers: 'src/domain/mapping.ts#configToShared',
      given: 'a machine configuration with a name, load-cell constants, and a tensile force limit of 1234.5 N',
      expect: {
        'name-and-force-limit': 'the operator sees the same name and force limit',
        'load-cell-in-millivolts-per-volt':
          'the load-cell constants are shown in millivolts per volt, converted from the stored nanovolts per volt',
        'round-trip': 'converting back gives the same machine values',
      },
    },
    () => {
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
        restrictedVelocity: 2,
      };
      const shared = configToShared(proto);
      expect(shared.Name).toBe('M1');
      expect(shared['Tensile Force Max (N)']).toBe(1234.5);
      expect(shared['Load Cell Sensitivity (mV/V)']).toBe(1);
      expect(shared['Load Cell Zero Balance (mV/V)']).toBe(0.005);
      expect(configFromShared(shared)).toEqual(proto);
    },
  );

  behaviour(
    {
      id: 'mapping.sample-uses-display-names',
      covers: 'src/domain/mapping.ts#sampleToShared',
      given: 'a live sample with machine force of 1 N and sample position of 5 mm',
      expect: {
        'values-carry-through': 'the values carry through unchanged under newton and millimetre labels',
      },
    },
    () => {
      const s = sampleToShared({
        machineForce: 1,
        machinePosition: 2,
        machineSetpoint: 3,
        sampleForce: 4,
        samplePosition: 5,
      });
      expect(s['Machine Force (N)']).toBe(1);
      expect(s['Sample Position (mm)']).toBe(5);
    },
  );

  behaviour(
    {
      id: 'mapping.state-flags-kept',
      covers: 'src/domain/mapping.ts#stateToShared',
      given: 'a machine state that is running a test with motion disabled',
      expect: {
        'flags-kept': 'the operator view keeps the test-running and motion-enabled flags unchanged',
      },
    },
    () => {
      const st = stateToShared({ faultedReason: 2, restrictedReason: 1, testRunning: true, motionEnabled: false } as never);
      expect(st.testRunning).toBe(true);
      expect(st.motionEnabled).toBe(false);
    },
  );

  behaviour(
    {
      id: 'mapping.sample-profile-round-trips',
      covers: 'src/domain/mapping.ts#sampleProfileToShared',
      given: 'a sample profile with force, velocity, displacement, width, and thickness, and no serial from the machine',
      expect: {
        'serial-empty': 'the operator view carries an empty serial',
        'round-trip': 'converting back gives the same machine fields',
      },
      why: {
        'serial-empty':
          'serial is an operator label stored only in the app, so it is empty when the profile comes from the machine',
      },
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'mapping.notification-severity',
      covers: 'src/domain/mapping.ts#notificationToShared',
      given: 'an error, a warning, and a success notification from the machine',
      expect: { 'severity-kept': 'each is shown to the operator at the same severity' },
    },
    () => {
      expect(notificationToShared({ type: ProtoNotificationType.ERROR, message: 'x' }).Type).toBe(NotificationType.ERROR);
      expect(notificationToShared({ type: ProtoNotificationType.WARNING, message: 'x' }).Type).toBe(NotificationType.WARN);
      expect(notificationToShared({ type: ProtoNotificationType.SUCCESS, message: 'x' }).Type).toBe(NotificationType.SUCCESS);
    },
  );
});
