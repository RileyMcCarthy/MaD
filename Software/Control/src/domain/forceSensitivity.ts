import { NV_PER_MV, planZero, type SavedLoadCell } from './forceZero';

/**
 * Load cell sensitivity from known weights.
 *
 * Each point is a reading with the load cell unloaded and a reading with a
 * known mass hanging from it. The machine turns the bridge signal into force
 * on a straight line whose slope is capacity / sensitivity, so the CHANGE in
 * reported force between the two readings is
 *
 *   measured = true force × true sensitivity / saved sensitivity
 *
 * whatever the zero balance is. The true sensitivity is therefore the saved
 * one scaled by measured / true force, and neither the zero balance nor the
 * capacity has to be right first. With several weights the scale is a
 * least-squares fit through the origin, and how far each point sits from that
 * line is the load cell's linearity.
 *
 * Report only: the panel offers the sensitivity for the profile being edited.
 */

/** Standard gravity, m/s². Local gravity differs by up to about 0.3%; the panel lets the operator enter theirs. */
export const STANDARD_GRAVITY = 9.80665;

/** A largest weight below this share of capacity is flagged: the fit then extrapolates a long way to full scale. */
export const LIGHT_LOAD_SHARE = 0.2;

/** A weight must move the reading by at least this much to count, so a weight that never registered is caught. */
export const MIN_RESPONSE_N = 0.05;

/** One known weight: the mean reading unloaded just before, and with the weight hanging. */
export interface WeightPoint {
  massKg: number;
  unloadedN: number;
  loadedN: number;
}

export interface FittedPoint {
  massKg: number;
  /** mass × gravity */
  knownN: number;
  /** What the machine reported the weight as, on the saved sensitivity. */
  measuredN: number;
  /** measured against known, in percent. */
  errorPct: number;
  /** After the new sensitivity: how far this point sits off the fitted line, in newtons. */
  residualN: number;
}

export interface SensitivityFit {
  /** The new Load Cell Sensitivity, to whole nV/V. */
  sensitivityMvV: number;
  /** Measured over known force: the true sensitivity over the saved one (1 = right). */
  scale: number;
  /** The weights read as pushing: the load cell's polarity is the other way round from the saved sensitivity. */
  polarityReversed: boolean;
  points: FittedPoint[];
  /** Largest distance of a point from the fitted line, as a percentage of the largest weight; null with one weight. */
  linearityPct: number | null;
  /** The largest weight is under LIGHT_LOAD_SHARE of capacity. */
  lightLoad: boolean;
}

export type SensitivityResult = { ok: true; fit: SensitivityFit } | { ok: false; reason: string };

export function fitSensitivity(
  points: readonly WeightPoint[],
  saved: SavedLoadCell,
  gravity: number = STANDARD_GRAVITY,
): SensitivityResult {
  const plan = planZero(saved);
  if (!plan.ok) return plan;
  if (!(gravity > 0)) return { ok: false, reason: 'Gravity must be greater than zero.' };
  if (points.length === 0) return { ok: false, reason: 'Read at least one weight.' };
  const rows = points.map((p) => ({ massKg: p.massKg, knownN: p.massKg * gravity, measuredN: p.loadedN - p.unloadedN }));
  if (rows.some((r) => !(r.massKg > 0))) return { ok: false, reason: 'Every weight needs a mass greater than zero.' };
  const faint = rows.find((r) => Math.abs(r.measuredN) < MIN_RESPONSE_N);
  if (faint) {
    return {
      ok: false,
      reason: `The ${faint.massKg} kg weight moved the reading by under ${MIN_RESPONSE_N * 1000} mN. Check it is hanging from the load cell, and that capacity and sensitivity are entered.`,
    };
  }
  // measured = scale × known, fitted through the origin.
  const scale = rows.reduce((a, r) => a + r.knownN * r.measuredN, 0) / rows.reduce((a, r) => a + r.knownN ** 2, 0);
  const maxKnown = Math.max(...rows.map((r) => r.knownN));
  const fitted = rows.map((r) => ({
    ...r,
    errorPct: ((r.measuredN - r.knownN) / r.knownN) * 100,
    residualN: r.measuredN / scale - r.knownN,
  }));
  return {
    ok: true,
    fit: {
      sensitivityMvV: Math.round(saved.sensitivityMvV * scale * NV_PER_MV) / NV_PER_MV,
      scale,
      polarityReversed: scale < 0,
      points: fitted,
      linearityPct: rows.length < 2 ? null : (Math.max(...fitted.map((p) => Math.abs(p.residualN))) / maxKnown) * 100,
      lightLoad: maxKnown < LIGHT_LOAD_SHARE * saved.capacityN,
    },
  };
}
