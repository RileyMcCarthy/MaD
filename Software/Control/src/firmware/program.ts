/**
 * Orchestrates a full programming run: open the port, wake the boot ROM, build
 * the right image, stream it, hand the port back.
 */
import { buildFlashImage, buildRamImage } from './image';
import { detectP2, loadImage, type LoaderEvent, type P2Transport } from './p2loader';
import { LOADER_BAUD_RATE, WebSerialTransport } from './webSerialTransport';
import { logger, nowMs } from '@/diagnostics/log';

const log = logger('flash');

/** Progress is logged at decile boundaries — a full image is ~4000 chunks. */
const PROGRESS_STEP = 0.1;

/**
 * Translate loader events into log entries.
 *
 * Flashing is the longest, most failure-prone serial operation in the app and
 * it runs against the boot ROM rather than the MaD protocol, so none of the
 * `proto` instrumentation covers it. Without this a "flashing failed" report
 * contains nothing at all about the flash.
 */
function makeLoaderLogger(): (event: LoaderEvent) => void {
  let nextProgress = PROGRESS_STEP;
  return (event) => {
    switch (event.kind) {
      case 'reset':
        log.info('reset', 'pulsing DTR to reset the P2');
        break;
      case 'detect-attempt':
        log.debug('detect', 'probing boot ROM', {
          attempt: event.attempt,
          retries: event.retries,
        });
        break;
      case 'detect-reply':
        // Silence means wiring; garbage means baud or a port someone else holds.
        // Either way the raw reply is the diagnosis, so keep it printable.
        if (event.bytes > 0) {
          log.debug('detect-reply', undefined, {
            attempt: event.attempt,
            bytes: event.bytes,
            reply: JSON.stringify(event.text),
          });
        }
        break;
      case 'detected':
        log.info('detected', `ROM version ${event.version}`, { attempt: event.attempt });
        break;
      case 'upload-begin':
        nextProgress = PROGRESS_STEP;
        log.info('upload-begin', undefined, {
          bytes: event.bytes,
          chunks: event.chunks,
          verifyChecksum: event.verifyChecksum,
        });
        break;
      case 'upload-progress': {
        const fraction = event.total > 0 ? event.sent / event.total : 1;
        if (fraction < nextProgress) break;
        nextProgress = Math.floor(fraction / PROGRESS_STEP) * PROGRESS_STEP + PROGRESS_STEP;
        log.debug('upload', `${Math.round(fraction * 100)}%`, {
          sent: event.sent,
          total: event.total,
        });
        break;
      }
      case 'verify':
        if (event.ok) log.info('verify', 'checksum accepted');
        else log.error('verify', 'checksum rejected', { reply: JSON.stringify(event.reply) });
        break;
      default:
        break;
    }
  };
}

export type ProgramMode = 'ram' | 'flash';

export type ProgramPhase = 'resetting' | 'uploading' | 'verifying' | 'done';

export interface ProgramProgress {
  phase: ProgramPhase;
  /** Bytes streamed so far, during 'uploading'. */
  sent?: number;
  total?: number;
}

export interface ProgramOptions {
  mode: ProgramMode;
  onProgress?: (p: ProgramProgress) => void;
  signal?: AbortSignal;
}

export interface ProgramResult {
  /** ROM version character reported during detection ('G' on shipping silicon). */
  romVersion: string;
  imageBytes: number;
}

/**
 * Program `firmware` into the device behind `transport`.
 *
 * Split out from {@link programPort} so the Node CLI harness can drive the same
 * sequence over `serialport` for hardware validation without a browser.
 */
export async function programTransport(
  transport: P2Transport,
  firmware: Uint8Array,
  { mode, onProgress, signal }: ProgramOptions,
): Promise<ProgramResult> {
  const onEvent = makeLoaderLogger();
  const startedAt = nowMs();
  let phase: ProgramPhase = 'resetting';
  log.info('start', `programming to ${mode}`, { mode, firmwareBytes: firmware.byteLength });

  try {
    onProgress?.({ phase: 'resetting' });
    const romVersion = await detectP2(transport, 5, onEvent);
    signal?.throwIfAborted();

    const image = mode === 'flash' ? buildFlashImage(firmware) : buildRamImage(firmware);

    phase = 'uploading';
    onProgress?.({ phase: 'uploading', sent: 0, total: image.byteLength });
    await loadImage(transport, image, {
      // loadp2 disables the ROM checksum handshake when the payload is the flash
      // stub — the running sum collides with the stub's own header checksum.
      verifyChecksum: mode === 'ram',
      onProgress: (sent, total) => onProgress?.({ phase: 'uploading', sent, total }),
      onEvent,
      signal,
    });

    phase = 'verifying';
    onProgress?.({ phase: 'verifying' });
    onProgress?.({ phase: 'done' });
    log.info('done', 'programming complete', {
      mode,
      romVersion,
      imageBytes: image.byteLength,
      durMs: Math.round(nowMs() - startedAt),
    });
    return { romVersion, imageBytes: image.byteLength };
  } catch (err) {
    // Which phase it died in is the first question: reset/detect points at
    // wiring or a busy port, upload at the link, verify at dropped bytes.
    log.error('failed', err instanceof Error ? err.message : String(err), {
      mode,
      phase,
      code: (err as { code?: string }).code,
      aborted: signal?.aborted ?? false,
      durMs: Math.round(nowMs() - startedAt),
    });
    throw err;
  }
}

/**
 * Browser entry point. The caller must have disconnected the device session
 * first — this opens the port exclusively at {@link LOADER_BAUD_RATE}.
 */
export async function programPort(
  port: SerialPort,
  firmware: Uint8Array,
  options: ProgramOptions,
): Promise<ProgramResult> {
  const transport = await WebSerialTransport.open(port, LOADER_BAUD_RATE);
  try {
    return await programTransport(transport, firmware, options);
  } finally {
    await transport.close();
  }
}
