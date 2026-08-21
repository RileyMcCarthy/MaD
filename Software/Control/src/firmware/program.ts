/**
 * Orchestrates a full programming run: open the port, wake the boot ROM, build
 * the right image, stream it, hand the port back.
 */
import { buildFlashImage, buildRamImage } from './image';
import { detectP2, loadImage, type P2Transport } from './p2loader';
import { LOADER_BAUD_RATE, WebSerialTransport } from './webSerialTransport';

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
  onProgress?.({ phase: 'resetting' });
  const romVersion = await detectP2(transport);
  signal?.throwIfAborted();

  const image = mode === 'flash' ? buildFlashImage(firmware) : buildRamImage(firmware);

  onProgress?.({ phase: 'uploading', sent: 0, total: image.byteLength });
  await loadImage(transport, image, {
    // loadp2 disables the ROM checksum handshake when the payload is the flash
    // stub — the running sum collides with the stub's own header checksum.
    verifyChecksum: mode === 'ram',
    onProgress: (sent, total) => onProgress?.({ phase: 'uploading', sent, total }),
    signal,
  });

  onProgress?.({ phase: 'verifying' });
  onProgress?.({ phase: 'done' });
  return { romVersion, imageBytes: image.byteLength };
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
