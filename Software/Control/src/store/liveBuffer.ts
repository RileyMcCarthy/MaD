/**
 * Live sample ring buffer, kept OUTSIDE React.
 *
 * Samples arrive from the device worker at up to ~100 Hz. Pushing each one
 * through React/Zustand would thrash rendering, so the live chart reads from
 * this module-level buffer on a requestAnimationFrame cadence instead. The
 * store only mirrors a throttled "latest sample" for numeric readouts.
 *
 * Implementation: a true circular buffer. `push` is O(1) (write at head, advance)
 * — the old version did an O(capacity) `copyWithin` shift on EVERY push once full
 * (~28 MB/s of memmove on the main thread at 100 Hz). The O(capacity) reorder now
 * happens only inside `getLiveSeries` (≤ once per animation frame, ~60 Hz, and
 * only after the buffer wraps), into reused scratch arrays.
 */

import { SampleData } from '@/domain';

/** Retained points (~1 minute at 100 Hz). */
const CAPACITY = 6000;

export interface LiveSeries {
  /** Seconds since the buffer was reset. */
  t: Float64Array;
  machineForce: Float64Array;
  machinePosition: Float64Array;
  machineSetpoint: Float64Array;
  sampleForce: Float64Array;
  samplePosition: Float64Array;
  /** Number of valid points (≤ CAPACITY). */
  length: number;
}

let t0 = performance.now();
/** Monotonic count of samples written (not wrapped); head = writePos % CAPACITY. */
let writePos = 0;
/** Valid points currently held (≤ CAPACITY). */
let count = 0;

const RING = {
  t: new Float64Array(CAPACITY),
  machineForce: new Float64Array(CAPACITY),
  machinePosition: new Float64Array(CAPACITY),
  machineSetpoint: new Float64Array(CAPACITY),
  sampleForce: new Float64Array(CAPACITY),
  samplePosition: new Float64Array(CAPACITY),
};
// Reused output buffers for the wrapped (ordered) read — never reallocated.
const OUT = {
  t: new Float64Array(CAPACITY),
  machineForce: new Float64Array(CAPACITY),
  machinePosition: new Float64Array(CAPACITY),
  machineSetpoint: new Float64Array(CAPACITY),
  sampleForce: new Float64Array(CAPACITY),
  samplePosition: new Float64Array(CAPACITY),
};

const FIELDS: Array<keyof typeof RING> = [
  't',
  'machineForce',
  'machinePosition',
  'machineSetpoint',
  'sampleForce',
  'samplePosition',
];

function writeAt(
  idx: number,
  t: number,
  s: SampleData,
): void {
  RING.t[idx] = t;
  RING.machineForce[idx] = s['Machine Force (N)'];
  RING.machinePosition[idx] = s['Machine Position (mm)'];
  RING.machineSetpoint[idx] = s['Machine Setpoint (mm)'];
  RING.sampleForce[idx] = s['Sample Force (N)'];
  RING.samplePosition[idx] = s['Sample Position (mm)'];
}

export function pushSample(s: SampleData): void {
  const now = (performance.now() - t0) / 1000;
  writeAt(writePos % CAPACITY, now, s);
  writePos += 1;
  if (count < CAPACITY) count += 1;
}

/** Shape attached to `globalThis.__madLive` (see the bottom of this file). */
export interface MadLiveHook {
  latest(): LiveSample | null;
  count(): number;
}

/** One live sample in engineering units, at the precision the wire carried. */
export interface LiveSample {
  /** Seconds since the buffer was reset. */
  t: number;
  machineForce: number;
  machinePosition: number;
  machineSetpoint: number;
  sampleForce: number;
  samplePosition: number;
}

/**
 * The most recent live sample, at FULL precision.
 *
 * The on-screen readout rounds to three decimals of a millimetre — one
 * micrometre — which is the right thing for a person to read and the wrong
 * thing for a test to measure. The wire carries nanometres, so a harness that
 * scrapes the DOM throws away three digits before it ever compares anything.
 * This is the same value the chart plots, unrounded.
 */
export function latestLiveSample(): LiveSample | null {
  if (count === 0) return null;
  const idx = (writePos - 1 + CAPACITY) % CAPACITY;
  return {
    t: RING.t[idx],
    machineForce: RING.machineForce[idx],
    machinePosition: RING.machinePosition[idx],
    machineSetpoint: RING.machineSetpoint[idx],
    sampleForce: RING.sampleForce[idx],
    samplePosition: RING.samplePosition[idx],
  };
}

export function resetLiveBuffer(): void {
  t0 = performance.now();
  writePos = 0;
  count = 0;
}

/**
 * Backfill the buffer from device-side sample history (oldest → newest),
 * back-dating timestamps at the sample period. Only applies while the buffer
 * is still empty — once live samples are flowing there is nothing to seed.
 */
export function seedSamples(samples: SampleData[], periodMs: number): void {
  if (count > 0 || samples.length === 0) return;
  const take = samples.slice(-CAPACITY);
  const start = (performance.now() - t0) / 1000 - (take.length * periodMs) / 1000;
  for (let i = 0; i < take.length; i++) {
    writeAt(i, start + (i * periodMs) / 1000, take[i]);
  }
  writePos = take.length;
  count = take.length;
}

/**
 * Snapshot the current valid range in chronological order. Before the buffer
 * wraps this returns zero-copy subarray views; after it wraps it assembles the
 * two ring segments into reused scratch buffers (so x stays monotonically
 * increasing for uPlot). Do not retain the returned arrays across frames.
 */
export function getLiveSeries(): LiveSeries {
  if (count < CAPACITY) {
    // Not wrapped: data sits at [0, count) in order — return views, no copy.
    return {
      t: RING.t.subarray(0, count),
      machineForce: RING.machineForce.subarray(0, count),
      machinePosition: RING.machinePosition.subarray(0, count),
      machineSetpoint: RING.machineSetpoint.subarray(0, count),
      sampleForce: RING.sampleForce.subarray(0, count),
      samplePosition: RING.samplePosition.subarray(0, count),
      length: count,
    };
  }
  // Wrapped: oldest is at head; concatenate [head, CAPACITY) then [0, head).
  const head = writePos % CAPACITY;
  const tail = CAPACITY - head;
  for (const f of FIELDS) {
    OUT[f].set(RING[f].subarray(head), 0);
    OUT[f].set(RING[f].subarray(0, head), tail);
  }
  return {
    t: OUT.t,
    machineForce: OUT.machineForce,
    machinePosition: OUT.machinePosition,
    machineSetpoint: OUT.machineSetpoint,
    sampleForce: OUT.sampleForce,
    samplePosition: OUT.samplePosition,
    length: CAPACITY,
  };
}

// Debug hook, mirroring `__madLog` in diagnostics/log: the e2e harness reads
// the live stream at full precision with
//   `page.evaluate(() => globalThis.__madLive?.latest())`
// which is the only way to check a MANUAL move — a jog or a home never enters a
// recorded test, so there is no downloaded CSV to check it against.
//
// Dev only. Shipped builds have no reason to expose the ring, and nothing in
// the app may depend on it being here.
if (import.meta.env.DEV) {
  globalThis.__madLive = { latest: latestLiveSample, count: () => count };
}
