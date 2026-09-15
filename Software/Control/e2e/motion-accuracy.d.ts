/** Ambient types for the JS 1 µm matcher imported from src tests. */
declare module '*motion-accuracy.mjs' {
export const CONTRACT_UM: number;
export const SHIPPED_ACCEL_MM_S2: number;

export type MotionSeries = {
  time: number[];
  pos: number[];
  setpoint: number[];
};

export type DelayFit = {
  worst: number;
  rms: number;
  n: number;
  atT: number;
  atM: number;
  atI: number;
  delayS: number;
};

export function trapezoidTravelUm(distUm: number, vUmS: number, aUmS2: number, tS: number): number;
export function trapezoidTimes(
  distUm: number,
  vUmS: number,
  aUmS2: number,
): { tAcc: number; tCruise: number; tBrake: number; tTotal: number; sAcc: number; triangular: boolean };

export function fitDelayMaxError(
  timesUs: number[],
  measuredUm: number[],
  idealAtSec: (t: number) => number,
  opts?: { delayMinS?: number; delayMaxS?: number; tMinS?: number; tMaxS?: number },
): DelayFit;

export function restIndex(series: MotionSeries): { rest: number; restCount: number; n: number };

export function assertArrivedAtUm(
  series: MotionSeries,
  targetUm: number,
  label: string,
  opts?: { log?: (line: string) => void },
): void;

export function assertFollowsLinearUm(
  series: MotionSeries,
  opts: {
    velocityMmS: number;
    distanceMm?: number;
    targetMm?: number;
    accelMmS2?: number;
    label: string;
    log?: (line: string) => void;
  },
): void;

export function assertFollowsSineWindowUm(
  series: MotionSeries,
  opts: {
    amplitudeMm: number;
    frequencyHz: number;
    centreMm: number;
    tMinS: number;
    tMaxS: number;
    label: string;
    log?: (line: string) => void;
    followBoundUm?: number;
  },
): void;
}
