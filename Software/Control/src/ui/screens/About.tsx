import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { downloadDiagnostics } from '@/diagnostics/exportBundle';

export default function About() {
  const fw = useStore((s) => s.firmwareVersion);
  const connected = useStore((s) => s.connection === 'connected');
  const responding = useStore((s) => s.responding);
  const [exporting, setExporting] = useState(false);

  const exportDiagnostics = async () => {
    setExporting(true);
    try {
      await downloadDiagnostics();
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <h1>Firmware &amp; About</h1>

      <div className="panel">
        <h2>Firmware</h2>
        <table>
          <tbody>
            <tr>
              <td>Current version</td>
              <td data-testid="fw-version">
                {connected && responding ? fw ?? 'Unknown' : '— (connect a device)'}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 12 }}>
          To update firmware, see the <a href="#/firmware">Firmware</a> page.
        </p>
        <p className="muted">
          Firmware releases:{' '}
          <a
            href="https://github.com/RileyMcCarthy/MaD/releases"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </p>
      </div>

      <div className="panel">
        <h2>Diagnostics</h2>
        <p className="muted">
          Export a session log (connection events, protocol errors/timeouts, and throughput
          counters) to help debug a hardware issue. No sample data or file contents are included.
        </p>
        <button onClick={() => void exportDiagnostics()} disabled={exporting} data-testid="export-diagnostics">
          {exporting ? 'Preparing…' : 'Download diagnostics'}
        </button>
      </div>

      <div className="panel">
        <h2>MaD Control</h2>
        <table>
          <tbody>
            <tr>
              <td>Version</td>
              <td data-testid="app-version">
                {typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown'}
                {typeof __GIT_SHA__ === 'string' && __GIT_SHA__ !== 'unknown'
                  ? ` (${__GIT_SHA__})`
                  : ''}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 12 }}>
          Frontend-only control app. Talks to the Propeller 2 over the Web Serial API; the
          protocol runs as WebAssembly compiled from the same Rust core used by the firmware
          tooling and SIL. Data is stored in a folder you choose via the File System Access
          API. Chromium-only (Chrome / Edge, desktop).
        </p>
        <p className="muted">
          MaD Control releases:{' '}
          <a href="https://github.com/RileyMcCarthy/MaD/releases" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </p>
      </div>
    </div>
  );
}
