import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import { estimateSeconds } from '@/firmware/image';
import { LOADER_BAUD_RATE } from '@/firmware/webSerialTransport';
import { programPort, type ProgramProgress } from '@/firmware/program';
import {
  describePort,
  rememberFlashPort,
  resolveFlashPort,
  validateFirmwareFile,
} from '@/firmware/portPref';

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ProgramProgress }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string };

export default function Firmware() {
  const fw = useStore((s) => s.firmwareVersion);
  const connection = useStore((s) => s.connection);
  const responding = useStore((s) => s.responding);
  const connect = useStore((s) => s.connect);
  const disconnect = useStore((s) => s.disconnect);

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ port: SerialPort; label: string } | null>(null);
  const [needsChoice, setNeedsChoice] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);

  const connected = connection === 'connected';
  const busy = status.kind === 'running';

  /**
   * Work out which port we'd program, so it can be shown before anything is
   * written. Never picks arbitrarily — an ambiguous set asks the user instead.
   */
  const refreshTarget = useCallback(async () => {
    let ports: SerialPort[] = [];
    try {
      ports = await deviceClient.getPorts();
    } catch {
      ports = [];
    }
    const resolution = resolveFlashPort(ports);
    if (resolution.kind === 'resolved') {
      setTarget({ port: resolution.port, label: describePort(resolution.port, resolution.index) });
      setNeedsChoice(false);
    } else {
      setTarget(null);
      setNeedsChoice(resolution.kind === 'ambiguous');
    }
  }, []);

  useEffect(() => {
    void refreshTarget();
  }, [refreshTarget, connection]);

  /** Explicit port pick — the browser chooser, then remember the choice. */
  const choosePort = async () => {
    try {
      const port = await deviceClient.requestPort();
      const ports = await deviceClient.getPorts();
      const index = Math.max(0, ports.indexOf(port));
      rememberFlashPort(port, index);
      setTarget({ port, label: describePort(port, index) });
      setNeedsChoice(false);
      setStatus({ kind: 'idle' });
    } catch {
      /* user dismissed the chooser */
    }
  };

  const program = async () => {
    if (!file || !target) return;
    // Name the port in the prompt: a wrong target is the expensive mistake, and
    // this is the last point at which the user can catch it.
    const ok = window.confirm(
      `Write "${file.name}" to the SPI flash of ${target.label}?\n\n` +
        'This replaces the firmware permanently. Do not disconnect until it finishes.',
    );
    if (!ok) return;

    setStatus({ kind: 'running', progress: { phase: 'resetting' } });
    // The chip reboots as part of programming, so any live protocol session is
    // void — and on a single-port board the worker still holds the streams.
    const wasConnected = connected;
    try {
      if (wasConnected) await disconnect();

      const firmware = new Uint8Array(await file.arrayBuffer());
      const result = await programPort(target.port, firmware, {
        // The P2 Edge boots from SPI flash, so that is the only thing the app
        // offers. RAM loading stays available to tools/hw-p2load.mts, where
        // running a build without committing it is a bring-up convenience.
        mode: 'flash',
        onProgress: (progress) => setStatus({ kind: 'running', progress }),
      });

      setStatus({
        kind: 'done',
        message: `Wrote ${result.imageBytes.toLocaleString()} bytes to flash. The board has rebooted into the new firmware.`,
      });

      if (wasConnected) {
        // Give the firmware a moment to come up before re-opening the port.
        await new Promise((r) => setTimeout(r, 1500));
        await connect();
      }
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const pct =
    status.kind === 'running' && status.progress.total
      ? Math.floor(((status.progress.sent ?? 0) / status.progress.total) * 100)
      : null;

  return (
    <div>
      <h1>Firmware</h1>

      <div className="panel">
        <h2>Current firmware</h2>
        <table>
          <tbody>
            <tr>
              <td>Version</td>
              <td data-testid="fw-version">
                {connected && responding ? (fw ?? 'Unknown') : '— (connect a device)'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Update</h2>
        <p className="muted">
          Programs the Propeller 2 directly from the browser over the same USB-serial adapter
          used for control — the loader resets the chip with DTR and talks to its boot ROM.
          This uses the Debug/Programming header J1 (pin 1 P62, 2 P63, 3 RESn, 4 GND) and
          needs an adapter that drives RESn from DTR, such as a Parallax Prop Plug. The isolated Raspberry Pi
          link on P53/P55 has no reset line and cannot program the board.
        </p>

        <div style={{ marginTop: 12 }}>
          {/* No `accept` filter: PlatformIO emits an extensionless `program`
              file, which a .bin filter hides from the picker. The size check
              below catches an obviously wrong choice instead. */}
          <input
            ref={fileInput}
            type="file"
            disabled={busy}
            data-testid="firmware-file"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              setFileError(picked ? validateFirmwareFile(picked.size) : null);
              setStatus({ kind: 'idle' });
            }}
          />
          <p className="muted">
            A release <code>.bin</code>, or a local build — PlatformIO writes it to{' '}
            <code>.pio/build/propeller2/program</code>, with no extension.
          </p>
          {file && !fileError && (
            <p className="muted">
              {file.name} — {file.size.toLocaleString()} bytes, roughly{' '}
              {estimateSeconds(file.size, LOADER_BAUD_RATE).toFixed(0)}s to send
            </p>
          )}
          {fileError && (
            <p className="error" data-testid="file-error">
              {fileError}
            </p>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <strong>Target</strong>
          <p data-testid="flash-target" className={target ? 'muted' : 'error'}>
            {target
              ? target.label
              : needsChoice
                ? 'Several serial devices are available — choose which one to program.'
                : 'No serial device yet — choose one to program.'}
          </p>
          <button onClick={() => void choosePort()} disabled={busy} data-testid="choose-flash-port">
            {target ? 'Use a different port' : 'Choose port'}
          </button>
          <p className="muted">
            The browser only reports a device's USB vendor and product IDs, so two identical
            adapters look the same here. Check this matches the board you mean to program.
          </p>
        </div>

        <button
          onClick={() => void program()}
          disabled={!file || !!fileError || !target || busy}
          data-testid="flash-firmware"
          style={{ marginTop: 12 }}
        >
          {busy ? 'Programming…' : 'Write to flash'}
        </button>

        {status.kind === 'running' && (
          <p data-testid="flash-status" style={{ marginTop: 12 }}>
            {status.progress.phase === 'uploading' && pct !== null
              ? `Uploading… ${pct}%`
              : status.progress.phase === 'resetting'
                ? 'Resetting the board and waking its boot ROM…'
                : 'Finishing…'}
          </p>
        )}
        {status.kind === 'done' && (
          <p data-testid="flash-status" style={{ marginTop: 12 }}>
            {status.message}
          </p>
        )}
        {status.kind === 'error' && (
          <p className="error" data-testid="flash-status" style={{ marginTop: 12 }}>
            {status.message}
          </p>
        )}
      </div>
    </div>
  );
}
