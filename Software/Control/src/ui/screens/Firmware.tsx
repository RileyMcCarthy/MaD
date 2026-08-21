import { useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import { estimateSeconds } from '@/firmware/image';
import { LOADER_BAUD_RATE } from '@/firmware/webSerialTransport';
import { programPort, type ProgramMode, type ProgramProgress } from '@/firmware/program';

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

  const [mode, setMode] = useState<ProgramMode>('flash');
  const [file, setFile] = useState<File | null>(null);
  const [useOtherPort, setUseOtherPort] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);

  const connected = connection === 'connected';
  const busy = status.kind === 'running';

  const program = async () => {
    if (!file) return;
    const permanent = mode === 'flash';
    const ok = window.confirm(
      permanent
        ? `Write "${file.name}" to the device's SPI flash?\n\n` +
            'This replaces the firmware permanently. Do not disconnect until it finishes.'
        : `Load "${file.name}" into RAM?\n\nIt runs until the next reset; flash is untouched.`,
    );
    if (!ok) return;

    setStatus({ kind: 'running', progress: { phase: 'resetting' } });
    // The chip reboots as part of programming, so any live protocol session is
    // void — and on a single-port board the worker still holds the streams.
    const wasConnected = connected;
    try {
      if (wasConnected) await disconnect();

      const port = useOtherPort
        ? await deviceClient.requestPort()
        : ((await deviceClient.getPorts())[0] ?? (await deviceClient.requestPort()));

      const firmware = new Uint8Array(await file.arrayBuffer());
      const result = await programPort(port, firmware, {
        mode,
        onProgress: (progress) => setStatus({ kind: 'running', progress }),
      });

      setStatus({
        kind: 'done',
        message: permanent
          ? `Wrote ${result.imageBytes.toLocaleString()} bytes to flash. The board has rebooted into the new firmware.`
          : `Loaded ${result.imageBytes.toLocaleString()} bytes into RAM. It runs until the next reset.`,
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
          This needs the Debug/Programming header J1 (GND / RESn / P63 / P62) and an adapter
          that drives RESn from DTR, such as a Parallax Prop Plug. The isolated Raspberry Pi
          link on P53/P55 has no reset line and cannot program the board.
        </p>

        <div style={{ marginTop: 12 }}>
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === 'flash'}
              disabled={busy}
              onChange={() => setMode('flash')}
            />{' '}
            Write to flash — permanent, survives power cycling
          </label>
          <br />
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === 'ram'}
              disabled={busy}
              onChange={() => setMode('ram')}
            />{' '}
            Load into RAM — temporary, good for trying a build
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <input
            ref={fileInput}
            type="file"
            accept=".bin,.binary,application/octet-stream"
            disabled={busy}
            data-testid="firmware-file"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setStatus({ kind: 'idle' });
            }}
          />
          {file && (
            <p className="muted">
              {file.name} — {file.size.toLocaleString()} bytes, roughly{' '}
              {estimateSeconds(file.size, LOADER_BAUD_RATE).toFixed(0)}s to send
            </p>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <label>
            <input
              type="checkbox"
              checked={useOtherPort}
              disabled={busy}
              onChange={(e) => setUseOtherPort(e.target.checked)}
            />{' '}
            Choose a different port for programming
          </label>
          <p className="muted">
            Only needed on a bench setup where control and programming are on separate
            adapters. On production hardware both run over the same connection.
          </p>
        </div>

        <button
          onClick={() => void program()}
          disabled={!file || busy}
          data-testid="flash-firmware"
          style={{ marginTop: 12 }}
        >
          {busy ? 'Programming…' : mode === 'flash' ? 'Write to flash' : 'Load into RAM'}
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
