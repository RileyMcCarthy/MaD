/**
 * Exit codes. These are a CI contract: a workflow keys off them, so they are
 * documented here and never reused for a second meaning.
 */
export const EXIT = {
  /** Everything ran and nothing at error severity was found. */
  OK: 0,
  /** The run completed and reported findings at error severity. This is the
   *  gate failing on purpose — it is NOT a crash. */
  FINDINGS: 1,
  /** Bad arguments. */
  USAGE: 2,
  /** Config or manifest is invalid. No producer ran. */
  CONFIG: 3,
  /** The comparison base could not be resolved exactly, or base === HEAD.
   *  Deliberately distinct from CONFIG: there is nothing to compare against,
   *  so any "unchanged" claim would be a lie rather than an error. */
  BASE: 4,
  /** A producer failed, timed out, or wrote nothing. */
  PRODUCER: 5,
  /** `accept` refused. The reason is printed; see accept/guards.ts. */
  REFUSED: 6,
  /** Internal error. */
  INTERNAL: 70,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
