import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { fileBugReport } from '@/diagnostics/report';

export default function About() {
  const fw = useStore((s) => s.firmwareVersion);
  const connected = useStore((s) => s.connection === 'connected');
  const responding = useStore((s) => s.responding);

  const [summary, setSummary] = useState('');
  const [steps, setSteps] = useState('');
  const [includeSerialTail, setIncludeSerialTail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState<{ fileName: string; issueUrl: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const result = await fileBugReport({ summary, steps, includeSerialTail });
      setFiled({ fileName: result.fileName, issueUrl: result.issueUrl });
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
          <a href="https://github.com/RileyMcCarthy/MaD/releases" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </p>
      </div>

      <div className="panel">
        <h2>Report a bug</h2>
        <p className="muted">
          Saves this session&apos;s log — connection events, protocol traffic, errors and
          timings — then opens a pre-filled GitHub issue. Attach the downloaded file to the
          issue so the problem can be traced without reproducing it.
        </p>

        <label className="field">
          What went wrong?
          <input
            type="text"
            value={summary}
            placeholder="e.g. jogging stops responding after a test"
            onChange={(e) => setSummary(e.target.value)}
            data-testid="report-summary"
          />
        </label>

        <label className="field">
          Steps to reproduce (optional)
          <textarea
            rows={3}
            value={steps}
            placeholder={'1. Connect\n2. Run a test\n3. Try to jog'}
            onChange={(e) => setSteps(e.target.value)}
            data-testid="report-steps"
          />
        </label>

        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeSerialTail}
            onChange={(e) => setIncludeSerialTail(e.target.checked)}
            data-testid="report-include-serial"
          />
          <span>
            Include the raw serial window
            <span className="muted"> — needed for protocol bugs; no sample values or file contents</span>
          </span>
        </label>

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={busy || summary.trim() === ''}
            data-testid="report-submit"
          >
            {busy ? 'Preparing…' : 'Report a bug'}
          </button>
        </div>

        {filed && (
          <p className="muted" style={{ marginTop: 12 }} data-testid="report-filed">
            Saved <code>{filed.fileName}</code> — attach it to the issue that just opened. If no
            tab appeared, your browser blocked the pop-up:{' '}
            <a href={filed.issueUrl} target="_blank" rel="noreferrer">
              open the issue form
            </a>
            .
          </p>
        )}
        {failed && (
          <p className="fault" style={{ marginTop: 12 }} data-testid="report-error">
            Could not build the report: {failed}
          </p>
        )}
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
