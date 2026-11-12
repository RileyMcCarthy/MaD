/**
 * What a finished run's data download means for its record.
 *
 * The machine answers a download for a run that recorded nothing with an
 * empty file, which reads as a successful download. Saving that would mark the
 * run downloaded and leave the viewer with nothing to plot, so an empty file
 * is its own outcome: the run gets an error and a reason the history shows.
 */

export type DownloadOutcome =
  | { kind: 'data'; csv: string }
  | { kind: 'empty'; message: string }
  | { kind: 'failed'; message: string };

export const NO_DATA_MESSAGE =
  'The machine recorded no data for this run. The test most likely failed to start or stopped straight away.';

export function classifyDownload(result: {
  success: boolean;
  csv?: string;
  sampleBytes?: number;
  error?: string;
}): DownloadOutcome {
  if (!result.success || result.csv === undefined) {
    return { kind: 'failed', message: result.error ?? 'download failed' };
  }
  const dataRows = result.csv.split('\n').filter((l) => l.trim() !== '').length - 1;
  if (result.sampleBytes === 0 || dataRows <= 0) return { kind: 'empty', message: NO_DATA_MESSAGE };
  return { kind: 'data', csv: result.csv };
}
