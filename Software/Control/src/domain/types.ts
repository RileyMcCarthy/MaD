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
  /** Where the trajectory says the machine should be right now (the setpoint is where the move ends). */
  'Machine Commanded (mm)': number;
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
  SERVO_STALL,
  FORCE_OVERLOAD,
  /* Domain-only, past the end of the wire enum: the app sets this when the
   * user disables the machine, and the firmware never sends it. It therefore
   * has to stay LAST -- a new wire variant takes the next ordinal, and if
   * USER_REQUEST still held it every stall arriving from the machine would be
   * displayed as the operator's own button press. */
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
  /** Wire fields loadCell* (MaDProtocol.yaml) — intrinsic load-cell constants. */
  'Load Cell Capacity (N)': number;
  'Load Cell Sensitivity (mV/V)': number;
  'Load Cell Zero Balance (mV/V)': number;
  'Position Max (mm)': number;
  'Velocity Max (mm/s)': number;
  'Acceleration Max (mm/s^2)': number;
  'Tensile Force Max (N)': number;
  'Homing Velocity (mm/s)': number;
  'Homing Offset (mm)': number;
  'Jaw Offset (mm)': number;
  /* Speed ceiling while the machine is RESTRICTED -- on an endstop, with the
   * door open, or over a tension limit. Zero means no ceiling. */
  'Restricted Velocity (mm/s)': number;
  /** Servo loop proportional gain (1/s). */
  'Servo Kp (1/s)': number;
  /** Servo loop integral gain (1/s^2); 0 switches the integral off. */
  'Servo Ki (1/s^2)': number;
  /** Which level of the drive's enable input enables it: false = energized
   *  (high) enables, the DMM DYN4's default; true = energized disables, as
   *  on most stepper drivers. A property of the drive, not the board. */
  'Drive Enable Active Low': boolean;
}

export interface FirmwareVersion {
  version: string;
}

/** The compatibility handshake's reply: the protocol version the firmware speaks. */
export interface DeviceInfo {
  protocolVersion: number;
}

/**
 * The waveform a `math` move runs:
 *  - `sine`: a cosine from rest where the gantry is (amplitude, frequency): it
 *    swings out twice the amplitude, in the direction of the amplitude's sign,
 *    and back. One move is one cycle; repeat it with the set's executions.
 *  - `sigmoid`: an S-curve move to a position: like a linear move, but its
 *    acceleration rises and falls smoothly instead of switching on and off.
 *  - `chirp`: a sine whose frequency sweeps linearly from `frequency` to
 *    `endFrequency` over `duration`, from rest where the gantry is.
 */
export type WaveformFn = 'sine' | 'sigmoid' | 'chirp';

/** Every position is absolute: sample extension, mm, from zero length. */
export interface MoveParameters {
  /** Linear, sigmoid: where the move ends, mm. */
  position: number;
  /** Linear, sigmoid: cruise speed, mm/s. */
  velocity: number;
  /** Dwell time, ms. */
  time: number;
  // ── Waveform ("math") move parameters ──
  /** Waveform type; `sine` when absent. */
  waveform?: WaveformFn;
  /** Sine, chirp: peak deviation, mm; its sign is the direction it sets off in. */
  amplitude?: number;
  /** Sine: cycles per second, Hz. Chirp: the frequency it starts at. */
  frequency?: number;
  /** Chirp: the frequency it sweeps to, Hz. */
  endFrequency?: number;
  /** Chirp: how long the sweep takes, s (rounded to whole cycles). */
  duration?: number;
  /** Sigmoid: peak acceleration, mm/s². */
  acceleration?: number;
}

export interface Move {
  moveType: 'linear' | 'dwell' | 'math';
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
  /** Why the run is in error, shown in the history. */
  errorMessage?: string;
}
