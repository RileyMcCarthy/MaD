/**
 * The comparison layer.
 *
 * Entry point: `compareSnapshotFile`. Everything else is exported because the
 * report renderer needs the patch and the per-key series, the config layer
 * needs the pixel diagnostic, and producers need the numeric quantizer.
 */

export {
  compareSnapshotFile,
  resolveCompareMode,
  isChange,
  isNonChange,
  isUnevaluated,
  verdictNotRun,
  verdictNotSelected,
  EXACT_MODE,
} from './registry.js';
export type {
  CompareOptions,
  CompareResult,
  ModeResolution,
  SnapshotCompareInput,
} from './registry.js';

export { compareExact, looksBinary } from './exact.js';
export type { ExactCompareResult, ExactOptions } from './exact.js';
export {
  DEFAULT_CONTEXT,
  DEFAULT_EDIT_LENGTH_CEILING,
  DEFAULT_MAX_FILE_BYTES,
} from './exact.js';

export { compareTolerance } from './tolerance.js';
export type {
  CellDiffReason,
  CellDifference,
  KeyDeviation,
  StructuralKind,
  StructuralMismatch,
  ToleranceCompareResult,
  ToleranceMode,
  ToleranceOptions,
  ToleranceReport,
  WorstDeviation,
} from './tolerance.js';

export { classifyCell, parseSeries, VOLATILE_PREFIX } from './series.js';
export type {
  CellKind,
  CellValue,
  SeriesComment,
  SeriesDelimiter,
  SeriesDocument,
  SeriesParseError,
  SeriesParseOptions,
  SeriesParseResult,
} from './series.js';

export {
  applyStep,
  bisectNormalization,
  DEFAULT_NORMALIZATION,
  describeAbsorption,
  enabledSteps,
  normalizeText,
  NORMALIZATION_ORDER,
  resolveNormalization,
} from './normalize.js';
export type { AbsorbResult, NormalizationOptions, NormalizationStep } from './normalize.js';

export {
  assertSupportedMode,
  collectPixelErrors,
  isPixelMode,
  pixelConfigError,
  PixelComparisonUnsupportedError,
  PIXEL_UNSUPPORTED_CODE,
  PIXEL_UNSUPPORTED_FIX,
  PIXEL_UNSUPPORTED_REASON,
} from './pixel.js';
export type { CompareConfigError, SupportedCompareMode } from './pixel.js';

export {
  DEFAULT_SIGNIFICANT_DIGITS,
  DEFAULT_TIE_MARGIN,
  DEFAULT_ULP_MARGIN,
  ulpOf,
  formatNumber,
  isTieAmbiguous,
  quantizeForOutput,
  roundSeriesToSignificantDigits,
  roundToSignificantDigits,
  TieMarginError,
} from './numeric.js';
export type { RoundOptions } from './numeric.js';
