import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import { estimateSeconds } from '@/firmware/image';
import { LOADER_BAUD_RATE } from '@/firmware/webSerialTransport';
import { programPort, type ProgramProgress } from '@/firmware/program';
import { closeFlashPort } from '@/firmware/closeFlashPort';
import { logger } from '@/diagnostics/log';
import {
  describePort,
  rememberFlashPort,
  resolveFlashPort,
  validateFirmwareFile,
} from '@/firmware/portPref';
import {
  fetchReleaseImage,
  fetchReleaseManifest,
  type FirmwareReleaseManifest,
} from '@/firmware/release';
import { hostingRoot } from '@/hosting';

type Status =
  | { kind: 'idle' }
  | { kind: 'downloading'; name: string }
  | { kind: 'running'; progress: ProgramProgress }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string };

/** The default image: the latest firmware release, served from this origin. */
type Release =
  | { kind: 'loading' }
  | { kind: 'ready'; manifest: FirmwareReleaseManifest }
  | { kind: 'unavailable'; message: string };

export default function Firmware() {
  const fw = useStore((s) => s.firmwareVersion);
  const connection = useStore((s) => s.connection);
  const responding = useStore((s) => s.responding);
  const connect = useStore((s) => s.connect);
  const disconnect = useStore((s) => s.disconnect);

  const [release, setRelease] = useState<Release>({ kind: 'loading' });
  // A local file, when chosen, replaces the release until it is cleared.
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ port: SerialPort; label: string } | null>(null);
  const [needsChoice, setNeedsChoice] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);

  const connected = connection === 'connected';
  const busy = status.kind === 'running' || status.kind === 'downloading';
  const manifest = release.kind === 'ready' ? release.manifest : null;
  // What "Write to flash" would program: the chosen file, else the release.
  const source = file
    ? { name: file.name, size: file.size }
    : manifest
      ? { name: `${manifest.assetName} (${manifest.tag})`, size: manifest.size }
      : null;

  useEffect(() => {
    let live = true;
    fetchReleaseManifest(hostingRoot(import.meta.env.BASE_URL)).then(
      (m) => live && setRelease({ kind: 'ready', manifest: m }),
      (err: unknown) =>
        live &&
        setRelease({ kind: 'unavailable', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, []);

  const useRelease = () => {
    setFile(null);
    setFileError(null);
    if (fileInput.current) fileInput.current.value = '';
    setStatus({ kind: 'idle' });
  };

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
    if (!source || !target) return;
    // Name the port in the prompt: a wrong target is the expensive mistake, and
    // this is the last point at which the user can catch it.
    const ok = window.confirm(
      `Write "${source.name}" to the SPI flash of ${target.label}?\n\n` +
        'This replaces the firmware permanently. Do not disconnect until it finishes.',
    );
    if (!ok) return;

    // The main device session is touched only when it is on the port being
    // flashed (one adapter for both). Flashing over a separate programming
    // adapter, as on the MadEdge PCBA, leaves the main connection running.
    const sharesPort = deviceClient.heldPort() === target.port;
    // Set once the session has handed its port over; it is then always given
    // back afterwards, whether the flash worked or not.
    let tookSessionPort = false;
    try {
      // Fetch (and check) the release before touching the board, so a failed
      // download leaves the live session and the flash as they were.
      let firmware: Uint8Array;
      if (file) {
        firmware = new Uint8Array(await file.arrayBuffer());
      } else if (manifest) {
        setStatus({ kind: 'downloading', name: manifest.assetName });
        firmware = await fetchReleaseImage(hostingRoot(import.meta.env.BASE_URL), manifest);
      } else {
        return;
      }

      setStatus({ kind: 'running', progress: { phase: 'resetting' } });
      // On a shared port the worker holds the streams (also while connecting or
      // after a lost link), and the chip reboots, so that session has to go.
      if (sharesPort) {
        await disconnect();
        tookSessionPort = true;
      }

      let result;
      try {
        result = await programPort(target.port, firmware, {
          // The P2 Edge boots from SPI flash, so that is the only thing the app
          // offers. RAM loading stays available to tools/hw-p2load.mts, where
          // running a build without committing it is a bring-up convenience.
          mode: 'flash',
          onProgress: (progress) => setStatus({ kind: 'running', progress }),
        });
      } finally {
        // The page opened this port; it must not keep it, whatever happened.
        if (!(await closeFlashPort(target.port))) {
          logger('flash').warn('port-left-open', 'the flash port did not close; unplug and replug the adapter', {
            port: target.label,
          });
        }
      }

      setStatus({
        kind: 'done',
        message: `Wrote ${result.imageBytes.toLocaleString()} bytes to flash. The board has rebooted into the new firmware.`,
      });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }

    if (tookSessionPort) {
      // Give the firmware a moment to come up, then reconnect to the same port:
      // no chooser, and the user is never left disconnected by a flash.
      await new Promise((r) => setTimeout(r, 1500));
      await connect({ port: target.port });
    }
  };

  const pct =
    status.kind === 'running' && status.progress.total
      ? Math.floor(((status.progress.sent ?? 0) / status.progress.total) * 100)
      : null;

  const installed = connected && responding ? (fw ?? 'Unknown') : null;
  const releaseDate = manifest?.publishedAt
    ? new Date(manifest.publishedAt).toLocaleDateString()
    : null;

  return (
    <div>
      <h1>Firmware</h1>

      <div className="panel">
        <table>
          <tbody>
            <tr>
              <td>Installed</td>
              <td data-testid="fw-version">{installed ?? <span className="muted">— connect to read</span>}</td>
              <td />
            </tr>
            <tr>
              <td>Latest release</td>
              <td data-testid="fw-latest">
                {release.kind === 'ready' ? (
                  <>
                    <a href={release.manifest.htmlUrl} target="_blank" rel="noreferrer">
                      {release.manifest.version}
                    </a>
                    {releaseDate && <span className="muted"> · {releaseDate}</span>}
                  </>
                ) : (
                  <span className="muted">
                    {release.kind === 'loading' ? 'Checking…' : 'Unavailable'}
                  </span>
                )}
              </td>
              <td />
            </tr>
            <tr>
              <td>Will flash</td>
              <td data-testid="firmware-source">
                {file ? (
                  <>
                    <strong>{file.name}</strong> <span className="muted">(local file)</span>
                  </>
                ) : manifest ? (
                  <>
                    <strong>{manifest.version}</strong> <span className="muted">(MadEdge, latest release)</span>
                  </>
                ) : (
                  <span className="muted">
                    {release.kind === 'loading'
                      ? 'Checking for the latest release…'
                      : 'No release available — choose a local file.'}
                  </span>
                )}
                {source && !fileError && (
                  <span className="muted"> · {source.size.toLocaleString()} bytes</span>
                )}
              </td>
              <td style={{ textAlign: 'right' }}>
                {file && manifest && (
                  <button type="button" onClick={useRelease} disabled={busy} data-testid="use-release">
                    Use latest release
                  </button>
                )}{' '}
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy}
                  data-testid="choose-local-file"
                >
                  {file ? 'Choose another file' : 'Use a local file…'}
                </button>
                {/* No `accept` filter: PlatformIO's build is an extensionless
                    `program` file, which a .bin filter would hide. */}
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  disabled={busy}
                  data-testid="firmware-file"
                  onChange={(e) => {
                    const picked = e.target.files?.[0] ?? null;
                    setFile(picked);
                    setFileError(picked ? validateFirmwareFile(picked.size) : null);
                    setStatus({ kind: 'idle' });
                  }}
                />
              </td>
            </tr>
            <tr>
              <td>Port</td>
              <td data-testid="flash-target" className={target ? undefined : 'error'}>
                {target
                  ? target.label
                  : needsChoice
                    ? 'Several serial devices — choose which one to program.'
                    : 'No serial device yet — choose one.'}
              </td>
              <td style={{ textAlign: 'right' }}>
                <button onClick={() => void choosePort()} disabled={busy} data-testid="choose-flash-port">
                  {target ? 'Change' : 'Choose port'}
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        {fileError && (
          <p className="error" data-testid="file-error">
            {fileError}
          </p>
        )}

        <button
          className="primary"
          onClick={() => void program()}
          disabled={!source || !!fileError || !target || busy}
          data-testid="flash-firmware"
          style={{ marginTop: 12 }}
        >
          {busy ? 'Programming…' : 'Write to flash'}
        </button>
        {source && !busy && !fileError && (
          <span className="muted" style={{ marginLeft: 12 }}>
            about {estimateSeconds(source.size, LOADER_BAUD_RATE).toFixed(0)}s
          </span>
        )}

        {status.kind === 'downloading' && (
          <p data-testid="flash-status" style={{ marginTop: 12 }}>
            Downloading {status.name}…
          </p>
        )}
        {status.kind === 'running' && (
          <p data-testid="flash-status" style={{ marginTop: 12 }}>
            {status.progress.phase === 'uploading' && pct !== null
              ? `Uploading… ${pct}%`
              : status.progress.phase === 'resetting'
                ? 'Resetting the board…'
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

        <p className="muted" style={{ marginTop: 16 }}>
          Needs a Prop Plug on header J1, which resets the board through DTR.
        </p>
      </div>
    </div>
  );
}
