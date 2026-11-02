import { useState } from 'react';
import {
  buildReportPreview,
  canFileDirectly,
  fileBugReport,
  fileBugReportViaApi,
  type ReportPreview,
} from '@/diagnostics/report';

interface Props {
  /** Prefill for "What went wrong?" — e.g. the crash message. */
  initialSummary?: string;
  /** Prefill for the reproduction steps. */
  initialSteps?: string;
  /** Show the "connect GitHub in Settings" tip. Off where there is no router to follow it. */
  settingsTip?: boolean;
}

/**
 * The review-then-file bug report flow. Shared by the About screen and the
 * crash fallback, so it must not depend on the router: the root error boundary
 * renders it outside the HashRouter.
 */
export default function BugReportForm({
  initialSummary = '',
  initialSteps = '',
  settingsTip = true,
}: Props) {
  const [summary, setSummary] = useState(initialSummary);
  const [steps, setSteps] = useState(initialSteps);
  const [includeSerialTail, setIncludeSerialTail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [filed, setFiled] = useState<{ fileName: string; issueUrl: string } | null>(null);
  const [posted, setPosted] = useState<{ number: number; htmlUrl: string; gistUrl?: string } | null>(
    null,
  );
  const [failed, setFailed] = useState<string | null>(null);
  const githubConnected = canFileDirectly();

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
      if (githubConnected) {
        const issue = await fileBugReportViaApi(input, preview);
        setPosted(issue);
      } else {
        const result = await fileBugReport(input, preview);
        setFiled({ fileName: result.fileName, issueUrl: result.issueUrl });
      }
      setPreview(null);
    } catch (err) {
      // Falling back would publish without the review the user just gave, so
      // surface the failure and let them retry or use Settings instead.
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {settingsTip && !githubConnected && (
        <p className="muted">
          Tip: connect GitHub in <a href="#/settings">Settings</a> to file in one click, with the
          log attached automatically.
        </p>
      )}

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
              {busy ? 'Filing…' : githubConnected ? 'File issue on GitHub' : 'Download and open issue'}
            </button>
            <button onClick={() => setPreview(null)} disabled={busy} data-testid="report-cancel">
              Cancel
            </button>
          </div>
        </div>
      )}

      {posted && (
        <p className="muted" style={{ marginTop: 12 }} data-testid="report-posted">
          Filed as{' '}
          <a href={posted.htmlUrl} target="_blank" rel="noreferrer">
            issue #{posted.number}
          </a>
          {posted.gistUrl ? ' with the full session log attached.' : ' (log upload failed — the summary was still filed).'}
        </p>
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
    </>
  );
}
