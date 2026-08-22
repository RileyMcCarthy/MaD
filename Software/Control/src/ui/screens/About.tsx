import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildReportPreview, fileBugReport, type ReportPreview } from '@/diagnostics/report';

export default function About() {
  const fw = useStore((s) => s.firmwareVersion);
  const connected = useStore((s) => s.connection === 'connected');
  const responding = useStore((s) => s.responding);

  const [summary, setSummary] = useState('');
  const [steps, setSteps] = useState('');
  const [includeSerialTail, setIncludeSerialTail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [filed, setFiled] = useState<{ fileName: string; issueUrl: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const input = { summary, steps, includeSerialTail };

  // Two steps on purpose: this ends up in a public issue, so the contents are
  // shown before anything is written or a tab is opened.
  const review = async () => {
    setBusy(true);
    setFailed(null);
    try {
      setPreview(await buildReportPreview(input));
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    setFailed(null);
    try {
      // Pass the reviewed bundle through, so what is published is what was seen.
      const result = await fileBugReport(input, preview);
      setFiled({ fileName: result.fileName, issueUrl: result.issueUrl });
      setPreview(null);
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
            onClick={() => void review()}
            disabled={busy || summary.trim() === ''}
            data-testid="report-review"
          >
            {busy && !preview ? 'Preparing…' : 'Review report'}
          </button>
        </div>

        {preview && (
          <div className="panel card" style={{ marginTop: 12 }} data-testid="report-preview">
            <h3 style={{ marginTop: 0 }}>What will be sent</h3>
            <pre className="code-block" style={{ maxHeight: 180 }} data-testid="report-triage">
              {preview.triageText}
            </pre>
            <p className="muted" style={{ marginBottom: 4 }}>Included:</p>
            <ul className="muted" style={{ marginTop: 0 }}>
              {preview.contents.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="muted" style={{ marginBottom: 4 }}>
              Identifying details — this becomes a public issue:
            </p>
            <ul className="muted" style={{ marginTop: 0 }} data-testid="report-disclosures">
              {preview.disclosures.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="muted">
              File size: {(preview.sizeBytes / 1024).toFixed(0)} KB · No sample values, no file
              contents, no folder paths.
            </p>
            <div className="row">
              <button
                className="primary"
                onClick={() => void submit()}
                disabled={busy}
                data-testid="report-submit"
              >
                {busy ? 'Preparing…' : 'Download and open issue'}
              </button>
              <button onClick={() => setPreview(null)} disabled={busy} data-testid="report-cancel">
                Cancel
              </button>
            </div>
          </div>
        )}

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
