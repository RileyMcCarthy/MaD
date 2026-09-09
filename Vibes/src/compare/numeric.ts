/**
 * Numeric normalization — the helper producers call BEFORE writing a snapshot.
 *
 * WHY THIS EXISTS (measured, not folklore): `Math.sin` is implementation-
 * approximated per ECMA-262, and on the SAME Node version it differs by 1 ULP
 * between arm64 (dev laptops) and x64 (CI). A snapshot carrying a raw
 * `Math.sin` result is therefore red on its very first CI run, for no
 * behavioural reason. Rounding to 12 significant digits collapses that
 * divergence (1 ULP is ~1e-16 relative; 12 sig digits cuts at ~1e-12 relative,
 * four orders of magnitude above the noise and far below any real change).
 *
 * WHY THE TIE-MARGIN GUARD: rounding is only deterministic when the value is
 * not sitting on a rounding boundary. If it is, the two architectures round in
 * OPPOSITE directions and quantization makes the divergence WORSE — a 1-ULP
 * difference becomes a full quantum. There is no way to fix that value; the
 * fixture has to move. So the guard ABORTS (throws) naming the value instead of
 * silently emitting a coin-flip. A quantizer without this guard is a quantizer
 * that fails ~1e-9 of the time and blames the platform.
 *
 * This module is deliberately free of any Vibes types: producers import it as
 * a leaf utility.
 */

/** Verified sufficient to collapse a 1-ULP arm64/x64 `Math.sin` divergence. */
export const DEFAULT_SIGNIFICANT_DIGITS = 12;

/**
 * How close to a rounding boundary is "too close", as a fraction of the
 * ROUNDING STEP (the quantum), not of the value.
 *
 * MEASURED, and the reason this is not "1e-9 of |value|" as first written: at
 * 12 significant digits the quantum is ~6.7e-12 of the value, so a margin of
 * 1e-9 × |value| is **150 quanta wide** — it swallows every value in the
 * number line and the guard aborts on literally everything (verified on 1.5).
 * Expressed against the quantum, 1e-9 means what it was meant to mean.
 */
export const DEFAULT_TIE_MARGIN = 1e-9;

/**
 * The margin that actually does the protecting, in ULPs of the value.
 *
 * Also measured: at 12 significant digits, one ULP is ~2.2e-5 of a quantum. So
 * a boundary-distance threshold expressed only in quanta (1e-9 of one) is four
 * orders of magnitude too NARROW to notice that an arm64 value and its x64
 * 1-ULP neighbour straddle a rounding boundary — the exact case the whole
 * helper exists for. 4 ULPs covers a 1-ULP divergence with margin to spare and
 * still fires on well under 0.1% of arbitrary values.
 */
export const DEFAULT_ULP_MARGIN = 4;

/** Exact ULP spacing at `value`, by bit increment. No approximation. */
export function ulpOf(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const abs = Math.abs(value);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, abs);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  const next = view.getFloat64(0);
  return Number.isFinite(next) ? next - abs : Number.NaN;
}

/** Thrown when quantization would not be deterministic for this value. */
export class TieMarginError extends Error {
  readonly value: number;
  readonly digits: number;
  /** Absolute distance from the value to the nearest rounding boundary. */
  readonly distanceToBoundary: number;
  /** The threshold it failed, in absolute units. */
  readonly threshold: number;
  readonly label: string | null;

  constructor(args: {
    value: number;
    digits: number;
    distanceToBoundary: number;
    threshold: number;
    label: string | null;
  }) {
    const where = args.label === null ? '' : ` (${args.label})`;
    super(
      `value ${args.value}${where} sits ${args.distanceToBoundary} from a ` +
        `${args.digits}-significant-digit rounding boundary, inside the ` +
        `${args.threshold} tie margin; quantization would not be reproducible ` +
        `across platforms. Move the fixture rather than widening the tolerance.`,
    );
    this.name = 'TieMarginError';
    this.value = args.value;
    this.digits = args.digits;
    this.distanceToBoundary = args.distanceToBoundary;
    this.threshold = args.threshold;
    this.label = args.label;
  }
}

export interface RoundOptions {
  /** Distance-to-boundary floor as a fraction of the quantum. Default 1e-9. */
  readonly tieMargin?: number;
  /** Distance-to-boundary floor in ULPs of the value. Default 4. */
  readonly ulpMargin?: number;
  /** Case/column name, quoted verbatim in the abort message. */
  readonly label?: string;
}

/** Decompose |value| into (quantum, scaled) for `digits` significant digits. */
function quantumFor(abs: number, digits: number): { quantum: number; scaled: number } | null {
  // Math.log10 is itself implementation-approximated, so its exponent can be off
  // by one at decade boundaries. Correct it by measurement rather than trusting
  // it: `scaled` must land in [10^(digits-1), 10^digits).
  let exponent = Math.floor(Math.log10(abs));
  const lower = 10 ** (digits - 1);
  const upper = 10 ** digits;
  for (let attempt = 0; attempt < 3; attempt++) {
    const quantum = 10 ** (exponent - digits + 1);
    if (!(quantum > 0) || !Number.isFinite(quantum)) return null;
    const scaled = abs / quantum;
    if (!Number.isFinite(scaled)) return null;
    if (scaled >= upper) {
      exponent += 1;
      continue;
    }
    if (scaled < lower) {
      exponent -= 1;
      continue;
    }
    return { quantum, scaled };
  }
  return null;
}

interface TieCheck {
  readonly distanceToBoundary: number;
  readonly threshold: number;
  readonly ambiguous: boolean;
}

function tieCheck(
  value: number,
  digits: number,
  tieMargin: number,
  ulpMargin: number,
): TieCheck | null {
  const abs = Math.abs(value);
  const parts = quantumFor(abs, digits);
  if (parts === null) return null;
  const frac = parts.scaled - Math.floor(parts.scaled);
  // Distance from the tie point, in absolute units. `scaled` itself carries
  // ~1e-16 relative float error, which is ~1e-4 of a quantum at 12 digits —
  // below the ULP-based threshold, so it cannot flip this decision either way.
  const distanceToBoundary = Math.abs(frac - 0.5) * parts.quantum;
  const ulp = ulpOf(value);
  const ulpFloor = Number.isFinite(ulp) ? ulpMargin * ulp : 0;
  const threshold = Math.max(tieMargin * parts.quantum, ulpFloor);
  return { distanceToBoundary, threshold, ambiguous: distanceToBoundary <= threshold };
}

/**
 * True when `value` is too close to a `digits`-significant-digit rounding
 * boundary for rounding to be reproducible.
 *
 * Non-finite values and zero have no boundary and are never ambiguous.
 */
export function isTieAmbiguous(
  value: number,
  digits: number = DEFAULT_SIGNIFICANT_DIGITS,
  tieMargin: number = DEFAULT_TIE_MARGIN,
  ulpMargin: number = DEFAULT_ULP_MARGIN,
): boolean {
  if (!Number.isFinite(value) || value === 0) return false;
  const check = tieCheck(value, digits, tieMargin, ulpMargin);
  return check !== null && check.ambiguous;
}

/**
 * Round to `digits` significant digits, or THROW if the value sits on a
 * rounding boundary.
 *
 * Non-finite values and signed zeros pass through untouched: NaN/±Infinity
 * carry no digits, and -0 must survive because `-0` and `0` are a real
 * behavioural distinction in this codebase's snapshots.
 */
export function roundToSignificantDigits(
  value: number,
  digits: number = DEFAULT_SIGNIFICANT_DIGITS,
  options: RoundOptions = {},
): number {
  if (!Number.isInteger(digits) || digits < 1 || digits > 17) {
    throw new RangeError(`significant digits must be an integer in 1..17, got ${digits}`);
  }
  if (!Number.isFinite(value) || value === 0) return value;

  const tieMargin = options.tieMargin ?? DEFAULT_TIE_MARGIN;
  const ulpMargin = options.ulpMargin ?? DEFAULT_ULP_MARGIN;
  const check = tieCheck(value, digits, tieMargin, ulpMargin);
  // Denormals and other magnitudes where the quantum underflows cannot be
  // meaningfully quantized; passing them through unchanged is the honest
  // option (they are also far outside any physical range this tool measures).
  if (check === null) return value;

  if (check.ambiguous) {
    throw new TieMarginError({
      value,
      digits,
      distanceToBoundary: check.distanceToBoundary,
      threshold: check.threshold,
      label: options.label ?? null,
    });
  }
  return Number(value.toPrecision(digits));
}

/** `roundToSignificantDigits` over an array; the label carries the index. */
export function roundSeriesToSignificantDigits(
  values: readonly number[],
  digits: number = DEFAULT_SIGNIFICANT_DIGITS,
  options: RoundOptions = {},
): number[] {
  const tieMargin = options.tieMargin ?? DEFAULT_TIE_MARGIN;
  const ulpMargin = options.ulpMargin ?? DEFAULT_ULP_MARGIN;
  const label = options.label ?? '';
  return values.map((v, i) =>
    roundToSignificantDigits(v, digits, { tieMargin, ulpMargin, label: `${label}[${i}]` }),
  );
}

/**
 * Deterministic text for a number, for producers writing snapshot cells.
 *
 * `String(n)` is the ECMA-262 shortest round-trip representation and is
 * identical across engines and platforms — but it renders -0 as "0", NaN and
 * both infinities as tokens that `Number()` happens to round-trip. Those four
 * are spelled explicitly here so a reader (and the series comparator) can tell
 * them apart from an ordinary 0 or a blank cell.
 */
export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

/** Round then format — the one call a producer needs per numeric cell. */
export function quantizeForOutput(
  value: number,
  digits: number = DEFAULT_SIGNIFICANT_DIGITS,
  options: RoundOptions = {},
): string {
  return formatNumber(roundToSignificantDigits(value, digits, options));
}
