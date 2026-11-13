/**
 * Deciding when a test run has finished, from the machine's own reports.
 *
 * The machine runs a test from its SD card and only says `testRunning`, polled
 * about once a second. The app learns a run is over by watching that flag go
 * from running to idle. This lives outside any screen so the run is still
 * tracked while the operator is on another page.
 *
 * Two cases need care:
 *  - Before the start is confirmed the machine is idle while the program is
 *    still uploading, so idle then means "not started yet", not "finished".
 *  - A run shorter than the poll can start and end between two reports and
 *    never be seen running. Once the start is confirmed, an idle machine for
 *    `graceMs` means it already finished.
 *
 * Runs still marked running that nothing is tracking (the page was reloaded
 * mid-test, or the app was closed) are stale once the machine is idle: their
 * test is over, whatever the app missed. `staleRunningRuns` finds them.
 */

export interface RunTrack {
  testName: string;
  /** The machine has been seen running this test. */
  sawRunning: boolean;
  /** When the machine accepted the start (ms), or null while still starting. */
  startedAtMs: number | null;
}

export interface RunTrackStep {
  track: RunTrack | null;
  /** Set when this step decided the tracked run has finished. */
  finished?: string;
}

/** Default wait before an accepted run that was never seen running counts as finished. */
export const RUN_UNSEEN_GRACE_MS = 3000;

export function stepRunTrack(
  track: RunTrack | null,
  machine: { testRunning: boolean } | null,
  nowMs: number,
  graceMs: number = RUN_UNSEEN_GRACE_MS,
): RunTrackStep {
  if (track === null || machine === null) return { track };
  if (machine.testRunning) {
    return { track: track.sawRunning ? track : { ...track, sawRunning: true } };
  }
  if (track.sawRunning) return { track: null, finished: track.testName };
  if (track.startedAtMs !== null && nowMs - track.startedAtMs >= graceMs) {
    return { track: null, finished: track.testName };
  }
  return { track };
}

/** Names of runs marked running that are over: the machine is idle and nothing tracks them. */
export function staleRunningRuns(
  runs: ReadonlyArray<{ testName: string; status: string }>,
  machine: { testRunning: boolean } | null,
  trackedName: string | null,
): string[] {
  if (machine === null || machine.testRunning) return [];
  return runs.filter((r) => r.status === 'running' && r.testName !== trackedName).map((r) => r.testName);
}
