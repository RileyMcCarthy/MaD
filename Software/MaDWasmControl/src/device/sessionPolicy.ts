/**
 * Pure policy helpers for DeviceSession.worker (M7).
 *
 * Kept free of WASM / Comlink so vitest can lock retry/abort/invalidate contracts
 * without spinning a real worker.
 */

/** Max NACK retries for download: first chunk waits longer (file may not exist). */
export const DOWNLOAD_MAX_NOT_READY_RETRIES = 80;
export const DOWNLOAD_MAX_MID_RETRIES = 20;
export const DOWNLOAD_RETRY_DELAY_MS = 100;
export const UPLOAD_DEFAULT_MAX_RETRIES = 3;

/** Retry budget for a download NACK at the given sample index. */
export function downloadNackRetryCap(sampleIndex: number): number {
  return sampleIndex === 0 ? DOWNLOAD_MAX_NOT_READY_RETRIES : DOWNLOAD_MAX_MID_RETRIES;
}

/** Whether another NACK retry is allowed after `notReadyRetries` prior failures. */
export function shouldRetryDownloadNack(notReadyRetries: number, sampleIndex: number): boolean {
  return notReadyRetries < downloadNackRetryCap(sampleIndex);
}

/** Whether an upload attempt may retry after a failure. */
export function shouldRetryUpload(attempt: number, maxRetries: number): boolean {
  return attempt < maxRetries;
}

/**
 * A failed runTest after a partial SD write must re-open (truncate) the gcode
 * file so a half-uploaded program cannot later run to EOF as "complete".
 */
export function shouldInvalidatePartialUpload(runSucceeded: boolean): boolean {
  return !runSucceeded;
}

export const ABORT_ERROR_MESSAGE = 'aborted by emergency stop';

export function isAbortError(message: string): boolean {
  return message === ABORT_ERROR_MESSAGE || message.startsWith('aborted:');
}

/**
 * Serializes async ops (same pattern as DataStore mutex / worker opChain).
 * Ensures single-in-flight: op B cannot start until A settles.
 */
export class OpMutex {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * Decide if a chunk ends the download stream.
 * Empty chunk → EOF; short of full request → last partial page.
 */
export function downloadChunkIsTerminal(
  chunkLength: number,
  samplesPerRequest: number,
  sampleWireSize: number,
): boolean {
  if (chunkLength === 0) return true;
  const received = Math.floor(chunkLength / sampleWireSize);
  return received < samplesPerRequest;
}
