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
          Firmware flashing is not available in the browser (it needs the native
          <code> loadp2 </code> bootloader). Use the <code>loadp2</code> CLI to update firmware.
        </p>
        <p className="muted">
          Firmware releases:{' '}
          <a href="https://github.com/" target="_blank" rel="noreferrer">
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
        <h2>About</h2>
        <p className="muted">
          MaD Control (web) — a frontend-only control app. Talks to the Propeller 2 over the
          Web Serial API; the protocol runs as WebAssembly compiled from the same Rust core used
          by the firmware tooling and SIL. Data is stored in a folder you choose via the File
          System Access API. Chromium-only (Chrome / Edge, desktop).
        </p>
      </div>
    </div>
  );
}
