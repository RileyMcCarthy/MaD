import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import { dataStore, TestRunIndexRow } from '@/storage/DataStore';
import { buildExportCsv, NotificationType } from '@/domain';
import TestRunner from '@/ui/components/TestRunner';
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
  const navigate = useNavigate();

  const [rows, setRows] = useState<TestRunIndexRow[]>([]);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [progress, setProgress] = useState<FileDownloadProgress | null>(null);
  const [downloadingName, setDownloadingName] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const loadRows = async () => {
    if (dataStore.connected) setRows(await dataStore.getTestRunIndex());
  };
  useEffect(() => {
    void loadRows();
  }, [folderReady]);

  const download = async (testName: string) => {
    setDownloadingName(testName);
    setProgress({ fileName: testName, bytesDownloaded: 0, totalBytes: 0, status: 'downloading' });
    try {
      const result = await deviceClient.downloadTestFile(testName, (p) => setProgress(p));
      if (!result.success || result.csv === undefined) {
        throw new Error(result.error ?? 'download failed');
      }
      // A storage failure here (quota, permission revoked) must not strand the
      // run as "not downloaded" silently — surface it and keep it re-downloadable.
      const path = await dataStore.saveTestCsv(testName, result.csv);
      await dataStore.updateTestRun(testName, { status: 'downloaded', dataFilePath: path });
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

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await dataStore.deleteTestRun(deleteTarget);
    setDeleteTarget(null);
    await loadRows();
  };

  // Manual resolution for runs stuck in "running" (firmware hang, app reload
  // mid-test): the automatic completion edge can no longer be observed.
  const markRun = async (testName: string, status: 'completed' | 'error') => {
    await dataStore.updateTestRun(
      testName,
      status === 'completed'
        ? { status, completedAt: new Date().toISOString() }
        : { status },
    );
    await loadRows();
  };

  const shown = rows.slice(0, visible);

  return (
    <div>
      <h1>Test Runs</h1>

      <TestRunner onChanged={loadRows} />

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
          <p className="muted">No runs yet (choose a data folder in Settings, then run a test).</p>
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
                      <span className={`badge ${r.status}`}>{r.status}</span>
                    </td>
                    <td className="row">
                      {r.status === 'downloaded' ? (
                        <>
                          <button onClick={() => navigate(`/view/${r.testName}`)}>View</button>
                          <button onClick={() => exportCsv(r.testName)}>Export</button>
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

      <Modal open={deleteTarget !== null} title="Delete test run?" onClose={() => setDeleteTarget(null)} width={420}>
        <p>
          Permanently delete <strong>{deleteTarget}</strong> and its data file? This cannot be undone.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => setDeleteTarget(null)}>Cancel</button>
          <button className="danger" onClick={confirmDelete} data-testid="confirm-delete">
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
