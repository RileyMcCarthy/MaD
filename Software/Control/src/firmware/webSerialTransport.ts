/**
 * {@link P2Transport} over the Web Serial API.
 *
 * Flashing owns the port exclusively for its duration: the device worker must
 * be disconnected first (it holds the stream locks, and the chip reboots
 * mid-flash anyway, so any live protocol session is void regardless).
 */
import type { P2Transport } from './p2loader';

/**
 * The rate the boot ROM autobauds to. Independent of the protocol baud the app
 * connects at — the ROM locks onto whatever we open the port with, and 2 Mbaud
 * is loadp2's default and divides the P2's 200 MHz clock exactly.
 */
export const LOADER_BAUD_RATE = 2_000_000;

export class WebSerialTransport implements P2Transport {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /** Bytes read from the stream but not yet consumed by a short read(). */
  private pending = new Uint8Array(0);
  /**
   * A `read()` that was issued but whose timeout fired first.
   *
   * Racing a read against a timer and walking away loses data: the read stays
   * pending on the stream, and whatever arrives next resolves that orphan
   * instead of the caller. Holding it here means the next call races the same
   * promise and picks the bytes up.
   */
  private inflight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  private constructor(private readonly port: SerialPort) {}

  /** Open `port` at the loader baud rate and take its streams. */
  static async open(port: SerialPort, baudRate = LOADER_BAUD_RATE): Promise<WebSerialTransport> {
    await port.open({ baudRate });
    const t = new WebSerialTransport(port);
    if (!port.readable || !port.writable) {
      await port.close();
      throw new Error('Serial port has no readable/writable stream.');
    }
    t.reader = port.readable.getReader();
    t.writer = port.writable.getWriter();
    return t;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('Transport is closed.');
    await this.writer.write(data);
  }

  async drain(): Promise<void> {
    // Web Serial has no explicit drain; `ready` resolves once the sink has
    // taken everything queued, which is the closest available signal.
    await this.writer?.ready;
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.byteLength < maxBytes && Date.now() < deadline) {
      const chunk = await this.readChunk(deadline - Date.now());
      if (!chunk) break;
      const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength);
      merged.set(this.pending);
      merged.set(chunk, this.pending.byteLength);
      this.pending = merged;
    }
    const take = Math.min(maxBytes, this.pending.byteLength);
    const out = this.pending.slice(0, take);
    this.pending = this.pending.slice(take);
    return out;
  }

  /** One stream read bounded by `timeoutMs`; null on timeout or end-of-stream. */
  private async readChunk(timeoutMs: number): Promise<Uint8Array | null> {
    if (!this.reader || timeoutMs <= 0) return null;
    // Resume a read left over from a previous timeout rather than starting a
    // second one, which would queue behind it and strand the first result.
    this.inflight ??= this.reader.read();
    const pendingRead = this.inflight;

    const TIMED_OUT = Symbol('timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });

    try {
      const result = await Promise.race([pendingRead, timeout]);
      if (result === TIMED_OUT) return null; // keep this.inflight for next time
      this.inflight = null;
      if (result.done || !result.value) return null;
      return result.value;
    } catch {
      this.inflight = null;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async flushInput(): Promise<void> {
    this.pending = new Uint8Array(0);
    // Drain anything already sitting in the stream, but don't wait on silence.
    while (await this.readChunk(5)) {
      /* discard */
    }
  }

  async setDtr(asserted: boolean): Promise<void> {
    await this.port.setSignals({ dataTerminalReady: asserted });
  }

  /** Release the streams and close the port. Safe to call twice. */
  async close(): Promise<void> {
    try {
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    try {
      this.reader?.releaseLock();
      this.writer?.releaseLock();
    } catch {
      /* already released */
    }
    this.reader = null;
    this.writer = null;
    this.inflight = null;
    try {
      await this.port.close();
    } catch {
      /* already closed */
    }
  }
}
