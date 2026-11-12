import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import { dataStore, TestRunIndexRow } from '@/storage/DataStore';
import { buildExportCsv, NotificationType } from '@/domain';
import { classifyDownload } from '@/domain/runDownload';
import Modal from '@/ui/components/Modal';
import { FileDownloadProgress } from '@/device/events';

const PAGE_SIZE = 10;

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Runs() {
  const connected = useStore((s) => s.connection === 'connected');
  const folderReady = useStore((s) => s.dataFolderReady);
  // Run records also change off this screen (a run finishing, stale runs
  // cleaned up on connect), so reload when the store says so.
  const runsChangedAt = useStore((s) => s.runsChangedAt);
  const navigate = useNavigate();

  const [rows, setRows] = useState<TestRunIndexRow[]>([]);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [progress, setProgress] = useState<FileDownloadProgress | null>(null);
  const [downloadingName, setDownloadingName] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadRows = async () => {
    if (dataStore.connected) setRows(await dataStore.getTestRunIndex());
  };
  useEffect(() => {
    void loadRows();
  }, [folderReady, runsChangedAt]);

  const download = async (testName: string) => {
    setDownloadingName(testName);
    setProgress({ fileName: testName, bytesDownloaded: 0, totalBytes: 0, status: 'downloading' });
    try {
      const outcome = classifyDownload(await deviceClient.downloadTestFile(testName, (p) => setProgress(p)));
      if (outcome.kind === 'failed') throw new Error(outcome.message);
      if (outcome.kind === 'empty') {
        await dataStore.updateTestRun(testName, { status: 'error', errorMessage: outcome.message });
        setProgress({ fileName: testName, bytesDownloaded: 0, totalBytes: 0, status: 'error', error: 'no data recorded' });
        useStore.getState().notify(NotificationType.ERROR, `Test ${testName}: ${outcome.message}`);
        await loadRows();
        return;
      }
      // A storage failure here (quota, permission revoked) must not strand the
      // run as "not downloaded" silently — surface it and keep it re-downloadable.
      const path = await dataStore.saveTestCsv(testName, outcome.csv);
      const saved = await dataStore.updateTestRun(testName, { status: 'downloaded', dataFilePath: path, errorMessage: undefined });
      if (!saved) {
        useStore
          .getState()
          .notify(NotificationType.WARN, `Downloaded ${testName}, but its run record is missing, so it is not marked downloaded.`);
      }
      await loadRows();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProgress({ fileName: testName, bytesDownloaded: 0, totalBytes: 0, status: 'error', error: message });
      useStore.getState().notify(NotificationType.ERROR, `Download of ${testName} failed: ${message}`);
    } finally {
      setDownloadingName(null);
      setTimeout(() => setProgress(null), 2500);
    }
  };

  const exportCsv = async (testName: string) => {
    const run = await dataStore.getTestRun(testName);
    const csv = await dataStore.readTestCsv(testName);
    if (run && csv) downloadBlob(`${testName}_export.csv`, buildExportCsv(run, csv));
  };

  // Deleting rewrites files in the data folder, which can take seconds; the
  // dialog stays open with a spinner until it is done.
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await dataStore.deleteTestRun(deleteTarget);
      await loadRows();
      setDeleteTarget(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useStore.getState().notify(NotificationType.ERROR, `Could not delete ${deleteTarget}: ${message}`);
    } finally {
      setDeleting(false);
    }
  };

  // Manual resolution for runs stuck in "running" (firmware hang, app reload
  // mid-test): the automatic completion edge can no longer be observed.
  const markRun = async (testName: string, status: 'completed' | 'error') => {
    const saved = await dataStore.updateTestRun(
      testName,
      status === 'completed'
        ? { status, completedAt: new Date().toISOString() }
        : { status },
    );
    if (!saved) {
      useStore.getState().notify(NotificationType.WARN, `Could not mark ${testName}: its run record is missing.`);
    }
    await loadRows();
  };

  const shown = rows.slice(0, visible);

  return (
    <div>
      <h1>Test runs</h1>
      <p className="muted">Start a new test from the Control page.</p>

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>History</h2>
          <button onClick={loadRows}>Refresh</button>
        </div>

        {progress && (
          <div className="readout" style={{ marginBottom: 12 }} data-testid="download-progress">
            <div className="label">
              {progress.status === 'downloading'
                ? `Downloading ${progress.fileName}… ${Math.round(progress.bytesDownloaded / 1024)} KB`
                : progress.status === 'complete'
                  ? `${progress.fileName}: downloaded ${Math.round(progress.bytesDownloaded / 1024)} KB`
                  : `${progress.fileName}: ${progress.error ?? 'error'}`}
            </div>
            <div className="progress">
              <div
                className="progress-bar"
                style={{
                  width:
                    progress.totalBytes > 0
                      ? `${Math.min(100, (progress.bytesDownloaded / progress.totalBytes) * 100)}%`
                      : undefined,
                }}
                data-indeterminate={progress.totalBytes === 0 && progress.status === 'downloading'}
              />
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="muted">No test runs yet.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Sample</th>
                  <th>Motion</th>
                  <th>Started</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td>{r.testName}</td>
                    <td className="muted">{r.sampleProfileName || '—'}</td>
                    <td className="muted">{r.motionProfileName || '—'}</td>
                    <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
                    <td>
                      <span className={`badge ${r.status}`} title={r.errorMessage}>
                        {r.status}
                      </span>
                      {r.errorMessage && (
                        <div className="run-error" data-testid="run-error">
                          {r.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="row">
                      {r.status === 'downloaded' ? (
                        <>
                          <button onClick={() => navigate(`/view/${r.testName}`)}>View</button>
                          <button onClick={() => exportCsv(r.testName)}>Export CSV</button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => download(r.testName)}
                            disabled={!connected || downloadingName === r.testName}
                          >
                            {downloadingName === r.testName ? 'Downloading…' : 'Download data'}
                          </button>
                          {r.status === 'running' && (
                            <>
                              <button
                                onClick={() => markRun(r.testName, 'completed')}
                                title="The firmware finished but the app missed it — mark this run completed."
                                data-testid="mark-completed"
                              >
                                Mark done
                              </button>
                              <button
                                onClick={() => markRun(r.testName, 'error')}
                                title="Give up on this run and mark it failed."
                                data-testid="mark-error"
                              >
                                Mark failed
                              </button>
                            </>
                          )}
                        </>
                      )}
                      <button className="danger" onClick={() => setDeleteTarget(r.testName)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible < rows.length && (
              <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
                <button onClick={() => setVisible((v) => v + PAGE_SIZE)}>
                  Load older runs ({rows.length - visible} more)
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        open={deleteTarget !== null}
        title="Delete test run?"
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        width={420}
      >
        <p>
          Permanently delete <strong>{deleteTarget}</strong> and its data file? This cannot be undone.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </button>
          <button className="danger" onClick={confirmDelete} disabled={deleting} aria-busy={deleting} data-testid="confirm-delete">
            {deleting ? (
              <>
                <span className="spinner" aria-hidden="true" /> Deleting…
              </>
            ) : (
              'Delete'
            )}
          </button>
        </div>
      </Modal>
    </div>
  );
}
