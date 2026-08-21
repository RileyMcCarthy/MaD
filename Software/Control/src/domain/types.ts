/**
 * Display-layer domain types.
 *
 * These are the
 * human-facing shapes the UI works with, independent of the wire protocol.
 * Conversion to/from the generated protocol structs lives in `mapping.ts`.
 */

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
  FORCE_GAUGE_COMMUNICATION,
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
  /** Wire field forceGaugeNPerStep (MaDProtocol.yaml) — counts-to-force scale. */
  'Force Gauge (N/step)': number;
  'Force Gauge Zero Offset (steps)': number;
  'Position Max (mm)': number;
  'Velocity Max (mm/s)': number;
  'Acceleration Max (mm/s^2)': number;
  'Tensile Force Max (N)': number;
  'Homing Velocity (mm/s)': number;
  'Homing Offset (mm)': number;
  'Jaw Offset (mm)': number;
}

export interface FirmwareVersion {
  version: string;
}

/** Position-vs-time waveform shapes for a "math" move (host-expanded to G1
 *  segments). Both are continuous and start/end at the centre over whole cycles
 *  (so they begin smoothly from the current position). */
export type WaveformFn = 'sine' | 'triangle';

export interface MoveParameters {
  position: number;
  velocity: number;
  distance: number;
  time: number;
  // ── Waveform ("math") move parameters. Optional so older .mp files round-trip. ──
  /** Waveform shape; defaults to 'sine' when absent. */
  waveform?: WaveformFn;
  /** Peak deviation from the centre, mm. */
  amplitude?: number;
  /** Cycles per second, Hz. */
  frequency?: number;
  /** Number of full cycles. */
  cycles?: number;
  /** Starting phase, degrees. */
  phase?: number;
}

export interface Move {
  /** `math` = a position-vs-time waveform (see WaveformFn), expanded host-side.
   *  (Arc/G2 was removed — the waveform replaces it; G2/G3 remain valid wire
   *  codes but the app no longer generates them.) */
  moveType: 'linear' | 'dwell' | 'math';
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
  sampleThickness: number;
  serial: string;
}

export interface MotionProfile {
  name: string;
  description: string;
  sets: Set[];
}

export interface TestProfile extends MotionProfile {
  sampleProfile: SampleProfile;
}

// ─── Persistence record types (mirror the desktop dataManager layout) ───

export interface SampleProfileEntry {
  id: string;
  name: string;
  createdAt: string;
  profile: SampleProfile;
}

export interface MotionProfileEntry {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  profile: MotionProfile;
}

export interface TestRunEntry {
  id: string;
  /** Six-digit run key, reused as firmware gcode + sample-log id. */
  testName: string;
  sampleProfileId: string;
  motionProfileId: string;
  sampleProfile: SampleProfile;
  motionProfile: MotionProfile;
  gcode: string[];
  gaugeLengthMm?: number;
  initialMachinePositionMm?: number;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'downloaded' | 'error';
  /** Relative path of the CSV inside the data folder (e.g. `testRuns/000123.csv`). */
  dataFilePath?: string;
}
