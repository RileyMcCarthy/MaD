/**
 * Conversion between generated protocol structs (wire units / field names)
 * and the display-layer domain types. Ported from the desktop
 * `BridgeHandler.ts` type-mapping section — pure functions, no I/O.
 */

import {
  Sample as ProtoSample,
  MachineState as ProtoMachineState,
  MachineConfiguration as ProtoMachineConfiguration,
  SampleProfile as ProtoSampleProfile,
  NotificationType as ProtoNotificationType,
  Notification as ProtoNotification,
} from '@/protocol/generated/protoemb';
import {
  SampleData,
  MachineState,
  FaultedReason,
  RestrictedReason,
  MachineConfiguration,
  SampleProfile,
  Notification,
  NotificationType,
} from './types';

export function sampleToShared(sample: ProtoSample): SampleData {
  return {
    'Machine Force (N)': sample.machineForce,
    'Machine Position (mm)': sample.machinePosition,
    'Machine Setpoint (mm)': sample.machineSetpoint,
    'Sample Force (N)': sample.sampleForce,
    'Sample Position (mm)': sample.samplePosition,
  };
}

export function stateToShared(state: ProtoMachineState): MachineState {
  return {
    faultedReason: state.faultedReason as unknown as FaultedReason,
    restrictedReason: state.restrictedReason as unknown as RestrictedReason,
    testRunning: state.testRunning,
    motionEnabled: state.motionEnabled,
  };
}

export function configToShared(
  config: ProtoMachineConfiguration,
): MachineConfiguration {
  return {
    Name: config.name,
    'Encoder (step/mm)': config.encoderStepsPerMM,
    'Servo (step/mm)': config.servoStepsPerMM,
    'Force Gauge (N/step)': config.forceGaugeNPerStep,
    'Force Gauge Zero Offset (steps)': config.forceGaugeZeroOffset,
    'Position Max (mm)': config.maxPosition,
    'Velocity Max (mm/s)': config.maxVelocity,
    'Acceleration Max (mm/s^2)': config.maxAcceleration,
    'Tensile Force Max (N)': config.maxForceTensile,
    'Homing Velocity (mm/s)': config.homingVelocity,
    'Homing Offset (mm)': config.homingOffset,
    'Jaw Offset (mm)': config.jawOffset,
  };
}

export function configFromShared(
  config: MachineConfiguration,
): ProtoMachineConfiguration {
  return {
    name: config.Name,
    encoderStepsPerMM: config['Encoder (step/mm)'],
    servoStepsPerMM: config['Servo (step/mm)'],
    forceGaugeNPerStep: config['Force Gauge (N/step)'],
    forceGaugeZeroOffset: config['Force Gauge Zero Offset (steps)'],
    maxPosition: config['Position Max (mm)'],
    maxVelocity: config['Velocity Max (mm/s)'],
    maxAcceleration: config['Acceleration Max (mm/s^2)'],
    maxForceTensile: config['Tensile Force Max (N)'],
    homingVelocity: config['Homing Velocity (mm/s)'],
    homingOffset: config['Homing Offset (mm)'],
    jawOffset: config['Jaw Offset (mm)'],
  };
}

export function sampleProfileToShared(
  profile: ProtoSampleProfile,
): SampleProfile {
  return {
    maxForce: profile.maxForce,
    maxVelocity: profile.maxVelocity,
    maxDisplacement: profile.maxDisplacement,
    sampleWidth: profile.sampleWidth,
    sampleThickness: profile.sampleThickness,
    serial: '', // UI-only field, not on the wire
  };
}

export function sampleProfileFromShared(
  profile: SampleProfile,
): ProtoSampleProfile {
  return {
    maxForce: profile.maxForce,
    maxVelocity: profile.maxVelocity,
    maxDisplacement: profile.maxDisplacement,
    sampleWidth: profile.sampleWidth,
    sampleThickness: profile.sampleThickness,
  };
}

const NOTIFICATION_TYPE_MAP: Record<ProtoNotificationType, NotificationType> = {
  [ProtoNotificationType.MESSAGE]: NotificationType.INFO,
  [ProtoNotificationType.INFO]: NotificationType.INFO,
  [ProtoNotificationType.WARNING]: NotificationType.WARN,
  [ProtoNotificationType.ERROR]: NotificationType.ERROR,
  [ProtoNotificationType.SUCCESS]: NotificationType.SUCCESS,
};

export function notificationToShared(n: ProtoNotification): Notification {
  return {
    Type: NOTIFICATION_TYPE_MAP[n.type] ?? NotificationType.INFO,
    Message: n.message,
  };
}
