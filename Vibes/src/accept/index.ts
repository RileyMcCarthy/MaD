/**
 * `vibes accept` — the only thing in this tool that writes a committed baseline.
 *
 * The order of operations IS the safety property, and it is stated once here so
 * no future edit can quietly reorder it:
 *
 *   SELECT → PLAN → REFUSE → REVIEW → APPLY → RECEIPT
 *
 * Every refusal is computed before a single byte is written, so "exits non-zero
 * and writes nothing" is structural rather than a promise each of the eight
 * checks has to keep on its own.
 *
 * What this module can and cannot do, stated plainly, because the difference is
 * the entire product: it CANNOT make blind acceptance impossible. An agent with
 * a shell can write any bytes it likes into a baseline directory. What it does
 * instead is make every acceptance leave a signed, greppable statement in the
 * same diff a reviewer is already reading — mode, who, why, how many, and the
 * sha256 of every byte it vouches for. Content that matches no receipt and no
 * base blob is `unreceipted-baseline`, an error, so `git add -A && git commit`
 * launders nothing.
 *
 * Import from here. The per-file modules are implementation detail.
 */

export {
  DEFAULT_ACCEPT_OPTIONS,
  EXIT_APPLY_FAILED,
  EXIT_OK,
  EXIT_QUIT,
  EXIT_REFUSED,
  GITATTRIBUTES_BASENAME,
  GITATTRIBUTES_CONTENT,
  RECEIPT_BASENAME,
  RECEIPT_FILE_RE,
  RECEIPT_SCHEMA,
  RESERVED_BASELINE_FILES,
  acceptModeOf,
  acceptedByOf,
  formatRefusal,
  isEquivalentVerdict,
  isReservedBaselineFile,
  isWritableVerdict,
  targetId,
} from './model.js';
export type {
  AcceptDecision,
  AcceptOptions,
  AcceptPlan,
  AcceptSummaryCounts,
  AcceptTarget,
  AcceptedFile,
  Candidate,
  CandidateAction,
  Refusal,
  RefusalCode,
  RunAcceptResult,
  TargetPlan,
} from './model.js';

export { ACCEPT_USAGE, parseAcceptArgs } from './args.js';
export type { ParsedArgs } from './args.js';

export { buildPlan, describeCandidate, planTarget, selectTargets } from './plan.js';
export type { SelectionResult } from './plan.js';

export { checkRefusals, isCiEnv } from './guards.js';
export type { AcceptGitPort, BaseFacts, GuardInput } from './guards.js';

export {
  BOOTSTRAP_MIN_REPEAT,
  DOCTOR_ATTESTATION_PATH,
  DOCTOR_ATTESTATION_SCHEMA,
  checkAttestation,
  hashProducerTree,
  parseDoctorAttestation,
  readDoctorAttestation,
  serializeDoctorAttestation,
} from './doctor.js';
export type {
  AttestationCheck,
  DoctorAttestation,
  DoctorProducerAttestation,
} from './doctor.js';

export {
  TOOL_VERSION,
  canonicalJson,
  emptyReceiptFile,
  findingsForReceipt,
  parseReceiptFile,
  pruneReceipts,
  receiptId,
  serializeReceiptFile,
  vouchesFor,
  withId,
} from './receipt.js';
export type {
  ParsedReceiptFile,
  PruneProbe,
  ReceiptDeletion,
  ReceiptFile,
  ReceiptFindingOptions,
  ReceiptSourceContext,
  StoredReceipt,
} from './receipt.js';

export { ReceiptFileCorruptError, applyTarget, readReceipts } from './apply.js';
export type { ApplyTargetInput, ApplyTargetResult } from './apply.js';

export {
  candidateKey,
  createStdioIo,
  renderCandidate,
  reviewCandidates,
} from './interactive.js';
export type { AcceptIo, ReviewOutcome, ReviewRenderOptions } from './interactive.js';

export { loadRunReport, runAccept, targetsFromRunReport } from './run.js';
export type {
  AcceptRepoPort,
  AcceptRunInput,
  AcceptRunOutcome,
  LoadedRunReport,
  TargetsFromReport,
  TargetsFromReportInput,
} from './run.js';
