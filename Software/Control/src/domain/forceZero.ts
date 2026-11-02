/**
 * Load cell zero and noise: what the bridge reads with nothing on it, and how
 * much that reading wanders.
 *
 * The firmware turns the bridge signal into force with three profile values:
 *
 *   force = (signal − zero balance) × capacity / sensitivity
 *
 * with signal, zero balance and sensitivity all in mV/V (bridge output per
 * volt of excitation). The live samples carry the force, not the signal, so
 * the signal is recovered by running that formula backwards with the values
 * SAVED on the machine -- the ones the firmware used. The zero found that way
 * is a property of the load cell alone, so it stays right whatever capacity
 * or sensitivity is later entered.
 *
 * Report only: the panel offers the zero for the profile being edited; it is
 * written to the machine with the rest of the profile.
 */

/** The load cell values the machine has saved, as the configuration screen shows them. */
export interface SavedLoadCell {
  capacityN: number;
  /** mV/V at capacity; its sign is the load cell's polarity. */
  sensitivityMvV: number;
  /** mV/V */
  zeroBalanceMvV: number;
}

/** How long the zero reads for. Long enough to average the noise, short enough to wait for. */
export const ZERO_READ_MS = 3000;

/** Fewer samples than this is not enough to call it a zero (about a quarter second of the live stream). */
export const ZERO_MIN_SAMPLES = 20;

/** The firmware reports force in whole millinewtons, so a change smaller than that cannot be seen. */
export const FORCE_QUANTUM_N = 0.001;

/** Profiles store mV/V as whole nV/V. */
const NV_PER_MV = 1e6;

export type ZeroPlan = { ok: true } | { ok: false; reason: string };

export function planZero(saved: SavedLoadCell): ZeroPlan {
  if (!(saved.capacityN > 0) || !(Math.abs(saved.sensitivityMvV) > 0)) {
    return {
      ok: false,
      reason:
        "The machine's saved profile needs Load Cell Capacity and Load Cell Sensitivity to turn force back into the bridge signal. Enter them from the load cell's datasheet and Write to device first.",
    };
  }
  return { ok: true };
}

export interface ZeroMeasurement {
  samples: number;
  /** The bridge signal with nothing on the load cell, to whole nV/V: the new Load Cell Zero Balance. */
  zeroBalanceMvV: number;
  /** The mean force the machine reported unloaded, with the saved zero: what the new zero removes. */
  offsetN: number;
  /** Standard deviation of the force: the smallest change a single sample can resolve. */
  noiseN: number;
  /** The same noise in the load cell's own units, nV/V. */
  noiseNvV: number;
  peakToPeakN: number;
  /** Mean of the last third of the readings minus the first third. */
  driftN: number;
  /** The reading moved more than its noise explains while it was being read. */
  drifting: boolean;
}

export type ZeroResult = { ok: true; measurement: ZeroMeasurement } | { ok: false; reason: string };

/**
 * Judge readings taken with the load cell unloaded.
 *
 * A reading still settling (a load cell warming up, a grip just let go)
 * shows as the last third of the readings sitting apart from the first
 * third by more than twice the noise; the zero is then reported but flagged.
 */
export function measureZero(forcesN: readonly number[], saved: SavedLoadCell): ZeroResult {
  const plan = planZero(saved);
  if (!plan.ok) return plan;
  const n = forcesN.length;
  if (n < ZERO_MIN_SAMPLES) {
    return {
      ok: false,
      reason: `Only ${n} readings arrived, at least ${ZERO_MIN_SAMPLES} are needed. Check the machine is sending live samples.`,
    };
  }
  const mean = forcesN.reduce((a, f) => a + f, 0) / n;
  const variance = forcesN.reduce((a, f) => a + (f - mean) ** 2, 0) / (n - 1);
  const noiseN = Math.sqrt(variance);
  const third = Math.floor(n / 3);
  const avg = (xs: readonly number[]) => xs.reduce((a, f) => a + f, 0) / xs.length;
  const driftN = avg(forcesN.slice(n - third)) - avg(forcesN.slice(0, third));
  const mvPerN = saved.sensitivityMvV / saved.capacityN;
  const zeroBalanceMvV = Math.round((mean * mvPerN + saved.zeroBalanceMvV) * NV_PER_MV) / NV_PER_MV;
  return {
    ok: true,
    measurement: {
      samples: n,
      zeroBalanceMvV,
      offsetN: mean,
      noiseN,
      noiseNvV: Math.abs(noiseN * mvPerN) * NV_PER_MV,
      peakToPeakN: Math.max(...forcesN) - Math.min(...forcesN),
      driftN,
      drifting: Math.abs(driftN) > Math.max(2 * noiseN, 2 * FORCE_QUANTUM_N),
    },
  };
}
