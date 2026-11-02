import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import { estimateSeconds, flashWriteMs } from '@/firmware/image';
import { LOADER_BAUD_RATE } from '@/firmware/webSerialTransport';
import { programPort, type ProgramProgress } from '@/firmware/program';
import { closeFlashPort } from '@/firmware/closeFlashPort';
import { flashWithSession } from '@/firmware/flashWithSession';
import { logger } from '@/diagnostics/log';
import {
  describePort,
  rememberFlashPort,
  resolveFlashPort,
  validateFirmwareFile,
} from '@/firmware/portPref';
import {
  fetchFirmwareManifest,
  fetchReleaseImage,
  recommendedRelease,
  releaseImageLabel,
  type FirmwareManifestEntry,
} from '@/firmware/release';
import { hostingRoot } from '@/hosting';
import { PROTOCOL_VERSION } from '@/protocol/generated/protoemb';

type Status =
  | { kind: 'idle' }
  | { kind: 'downloading'; name: string }
  | { kind: 'running'; progress: ProgramProgress }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string };

/**
 * The default image: the recommended firmware, the newest release that speaks
 * this app's protocol, served from this origin.
 */
type Release =
  | { kind: 'loading' }
  | { kind: 'ready'; manifest: FirmwareManifestEntry }
  | { kind: 'unavailable'; message: string };

/** What the Protocol row says about the connected firmware. */
function protocolLabel(deviceProtocol: number | null, checked: boolean): string {
  if (!checked) return '—';
  return deviceProtocol === null ? 'not reported (firmware from before the protocol check)' : String(deviceProtocol);
}

export default function Firmware() {
  const fw = useStore((s) => s.firmwareVersion);
  const deviceProtocol = useStore((s) => s.deviceProtocol);
  const compat = useStore((s) => s.firmwareCompat);
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
    fetchFirmwareManifest(hostingRoot(import.meta.env.BASE_URL)).then(
      (m) => {
        if (!live) return;
        const recommended = recommendedRelease(m, PROTOCOL_VERSION);
        setRelease(
          recommended
            ? { kind: 'ready', manifest: recommended }
            : {
                kind: 'unavailable',
                message: `No firmware release speaks this app's protocol (${PROTOCOL_VERSION}) yet.`,
              },
        );
      },
      (err: unknown) =>
        live &&
        setRelease({ kind: 'unavailable', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, []);

  const clearFile = () => {
    setFile(null);
    setFileError(null);
    if (fileInput.current) fileInput.current.value = '';
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

  /**
   * Program the chosen source, or (`recommended`) the recommended release
   * whatever file is chosen: the one-click update.
   */
  const program = async (use: 'chosen' | 'recommended' = 'chosen') => {
    const local = use === 'chosen' ? file : null;
    const chosen = local
      ? { name: local.name, size: local.size }
      : manifest
        ? { name: `${manifest.assetName} (${manifest.tag})`, size: manifest.size }
        : null;
    if (!chosen || !target) return;
    // Name the port in the prompt: a wrong target is the expensive mistake, and
    // this is the last point at which the user can catch it.
    const ok = window.confirm(
      `Write "${chosen.name}" to the SPI flash of ${target.label}?\n\n` +
        'This replaces the firmware permanently. Do not disconnect until it finishes.',
    );
    if (!ok) return;
    if (use === 'recommended') clearFile();

    // Which port the main session holds, read before anything is awaited.
    const heldPort = deviceClient.heldPort();
    // Fetch (and check) the release before touching the board, so a failed
    // download leaves the live session and the flash as they were.
    let firmware: Uint8Array;
    try {
      if (local) {
        firmware = new Uint8Array(await local.arrayBuffer());
      } else if (manifest) {
        setStatus({ kind: 'downloading', name: manifest.assetName });
        firmware = await fetchReleaseImage(hostingRoot(import.meta.env.BASE_URL), manifest);
      } else {
        return;
      }
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    setStatus({ kind: 'running', progress: { phase: 'resetting' } });
    // Hands the main session's port over (only when it is the target) and back.
    await flashWithSession({
      heldPort,
      target: target.port,
      targetLabel: target.label,
      disconnect,
      program: (port) =>
        programPort(port, firmware, {
          // The P2 Edge boots from SPI flash, so that is the only thing the app
          // offers. RAM loading stays available to tools/hw-p2load.mts, where
          // running a build without committing it is a bring-up convenience.
          mode: 'flash',
          onProgress: (progress) => setStatus({ kind: 'running', progress }),
        }),
      closePort: closeFlashPort,
      connect: (port) => connect({ port }),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: logger('flash'),
      onDone: (result) =>
        setStatus({
          kind: 'done',
          message: `Wrote ${result.imageBytes.toLocaleString()} bytes to flash. The board has rebooted into the new firmware.`,
        }),
      onError: (err) => setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
    });
  };

  const pct =
    status.kind === 'running' && status.progress.total
      ? Math.floor(((status.progress.sent ?? 0) / status.progress.total) * 100)
      : null;

  const installed = connected && responding ? (fw ?? 'Unknown') : null;
  // The firmware cannot be driven by this app (the banner says why); an update
  // is the way out, so the install button leads.
  const mismatched = compat?.kind === 'firmwareTooOld' || compat?.kind === 'appTooOld';
  const updateWanted = compat?.kind === 'firmwareTooOld' || compat?.kind === 'belowMinFirmware';
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
              <td>Protocol</td>
              <td data-testid="fw-protocol" className={mismatched ? 'error' : undefined}>
                {connected && responding ? (
                  protocolLabel(deviceProtocol, compat !== null)
                ) : (
                  <span className="muted">— connect to read</span>
                )}
                <span className="muted"> · this app speaks {PROTOCOL_VERSION}</span>
              </td>
              <td />
            </tr>
            <tr>
              <td>Recommended</td>
              <td data-testid="fw-latest">
                {release.kind === 'ready' ? (
                  <>
                    <a href={release.manifest.htmlUrl} target="_blank" rel="noreferrer">
                      {release.manifest.version}
                    </a>
                    {releaseDate && <span className="muted"> · {releaseDate}</span>}
                    <span className="muted"> · the newest release for protocol {release.manifest.protocolVersion}</span>
                  </>
                ) : (
                  <span className="muted">
                    {release.kind === 'loading' ? 'Checking…' : release.message}
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
                    <strong>{manifest.version}</strong>{' '}
                    <span className="muted">({releaseImageLabel(manifest.assetName)}, recommended release)</span>
                  </>
                ) : (
                  <span className="muted">
                    {release.kind === 'loading'
                      ? 'Checking for the recommended release…'
                      : 'No recommended release — choose a local file.'}
                  </span>
                )}
                {source && !fileError && (
                  <span className="muted"> · {source.size.toLocaleString()} bytes</span>
                )}
              </td>
              <td style={{ textAlign: 'right' }}>
                {manifest && (
                  <button
                    type="button"
                    className={updateWanted ? 'primary' : undefined}
                    onClick={() => void program('recommended')}
                    disabled={busy || !target}
                    data-testid="install-recommended"
                  >
                    Install recommended firmware ({manifest.version})
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
          onClick={() => void program('chosen')}
          disabled={!source || !!fileError || !target || busy}
          data-testid="flash-firmware"
          style={{ marginTop: 12 }}
        >
          {busy ? 'Programming…' : 'Write to flash'}
        </button>
        {source && !busy && !fileError && (
          <span className="muted" style={{ marginLeft: 12 }}>
            about {(estimateSeconds(source.size, LOADER_BAUD_RATE) + flashWriteMs(source.size) / 1000).toFixed(0)}s
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
                : status.progress.phase === 'writing'
                  ? `Writing flash… about ${Math.ceil((status.progress.writeMs ?? 0) / 1000)}s. Do not disconnect or reset the board.`
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
