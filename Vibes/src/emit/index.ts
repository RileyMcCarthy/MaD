/** emit/ — public surface. */

export {
  DEFAULT_EMIT_BUDGET,
  TruncationLedger,
  capList,
  tailBytes,
} from './budget.js';
export type { EmitBudget, Truncation } from './budget.js';

export { diffTableHtml, hunkRows } from './diffTable.js';
export type { DiffTableOptions } from './diffTable.js';

export {
  byteLength,
  escapeHtml,
  escapeJsonForScript,
  escapeMarkdownInline,
  fenceFor,
  markdownCell,
  slug,
} from './escape.js';

export {
  COMPONENT_STATE_LABEL,
  DISCLOSURE_SENTENCE,
  SNAP_STATE_LABEL,
  assertHeadlineInvariant,
  headline,
  tally,
} from './headline.js';
export type { Headline, HeadlineState, ReportTally, StateTally } from './headline.js';

export { buildHtml, renderBlocksHtml } from './html.js';
export type { HtmlResult } from './html.js';

export { buildMarkdown, renderBlocksMarkdown } from './markdown.js';
export type { MarkdownResult } from './markdown.js';

export { assertNoExternalRefs, throwIfExternalRefs } from './noExternal.js';

export { prepare } from './prepare.js';
export type {
  PrepareOptions,
  PreparedComponent,
  PreparedReport,
  PreparedSnapshot,
  SnapshotContent,
  SnapshotContentProvider,
} from './prepare.js';

export { emitPrepared, emitReport } from './report.js';
export type { EmitOptions, EmitResult } from './report.js';

export { bucketMinMax, sparklineSvg, sparklineText } from './sparkline.js';
export type { SparklineOptions } from './sparkline.js';
