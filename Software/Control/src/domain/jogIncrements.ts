/**
 * Selectable manual-jog increments for the Live controls (and any future
 * NavKey mapping that shares the same manual-move path).
 *
 * 0.1 mm is required for gauge-length / preload setup on short samples
 * (see MaD #1). Values must stay inside MOVE_FIELD_RANGE.x so the worker's
 * validateAndEncodeMove path accepts them.
 */

/** Preset jog distances offered in the UI, in millimetres. */
export const JOG_INCREMENTS_MM = [0.1, 1, 5, 10] as const;

export type JogIncrementMm = (typeof JOG_INCREMENTS_MM)[number];

/** Default jog distance when the Live screen mounts. */
export const DEFAULT_JOG_MM: JogIncrementMm = 1;

/** True when `current` matches a preset (float-safe). */
export function isSelectedJogIncrement(current: number, preset: number): boolean {
  return Number.isFinite(current) && Math.abs(current - preset) < 1e-9;
}

/** Compact label for a preset button (keeps one decimal for sub-mm steps). */
export function formatJogIncrementLabel(mm: number): string {
  if (!Number.isFinite(mm)) return '—';
  const rounded = Math.round(mm * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
