export enum NotificationType {
  ERROR = 'ERROR',
  WARN = 'WARN',
  INFO = 'INFO',
  SUCCESS = 'SUCCESS',
}

export interface Notification {
  Type: NotificationType;
  Message: string;
}

export interface SampleData {
  'Machine Force (N)': number;
  'Machine Position (mm)': number;
  'Machine Setpoint (mm)': number;
  'Sample Force (N)': number;
  'Sample Position (mm)': number;
  Index: number;
}

export enum FaultedReason {
  NONE,
  COG,
  WATCHDOG,
  ESD_POWER,
  ESD_SWITCH,
  ESD_UPPER,
  ESD_LOWER,
  SERVO_COMMUNICATION,
  FORCE_GAGUE_COMMUNICATION,
  USER_REQUEST,
}

export enum RestrictedReason {
  NONE,
  SAMPLE_LENGTH,
  SAMPLE_TENSION,
  MACHINE_TENSION,
  UPPER_ENDSTOP,
  LOWER_ENDSTOP,
  DOOR,
}

export interface MachineState {
  faultedReason: FaultedReason;
  restrictedReason: RestrictedReason;
  testRunning: boolean;
  motionEnabled: boolean;
}

export interface MachineConfiguration {
  Name: string;
  'Encoder (step/mm)': number;
  'Servo (step/mm)': number;
  'Force Gauge (N/step)': number;
  'Force Gauge Zero Offset (steps)': number;
  'Position Max (mm)': number;
  'Velocity Max (mm/s)': number;
  'Acceleration Max (mm/s^2)': number;
  'Tensile Force Max (N)': number;
}

export interface FirmwareVersion {
  version: string;
}

export interface MoveParameters {
  position: number;
  velocity: number;
  distance: number;
  time: number;
  circularOffset: number;
}

export interface Move {
  moveType: 'linear' | 'dwell' | 'arc' | 'math';
  absoluteOrRelative: 'absolute' | 'relative';
  moveParameters: MoveParameters;
}

export interface Set {
  name: string;
  executions: number;
  moves: Move[];
}

export interface SampleProfile {
  maxForce: number;
  maxVelocity: number;
  maxDisplacement: number;
  sampleWidth: number;
  serialNumber: string;
}

export interface MotionProfile {
  name: string;
  description: string;
  sets: Set[];
}

export interface TestProfile extends MotionProfile {
  sampleProfile: SampleProfile;
}

export interface TestHeader {
  motionProfileName: string;
  sampleProfileName: string;
  test_name: string;
  'Data and Time': string;
}
