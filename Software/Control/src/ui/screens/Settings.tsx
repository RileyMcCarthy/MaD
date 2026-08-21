import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { dataStore } from '@/storage/DataStore';
import Config from './Config';

export default function Settings() {
  // Folder state lives in the store (restored once at startup), so it stays
  // consistent across screens and survives navigation/refresh.
  const dirName = useStore((s) => s.dataFolder);
  const folderReady = useStore((s) => s.dataFolderReady);
  const needsPermission = useStore((s) => s.dataFolderNeedsPermission);
  const chooseDataFolder = useStore((s) => s.chooseDataFolder);
  const grantDataFolder = useStore((s) => s.grantDataFolder);
  const [message, setMessage] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const choose = async () => {
    try {
      await chooseDataFolder();
      setMessage('Data folder set.');
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        setMessage(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const grant = async () => {
    try {
      await grantDataFolder();
      setMessage(useStore.getState().dataFolderReady ? 'Permission granted.' : 'Permission denied.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      const rows = await dataStore.rebuildIndex();
      setMessage(`Rescanned folder: ${rows.length} test run(s) found.`);
    } catch (err) {
      setMessage(`Rescan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRescanning(false);
    }
  };

  return (
    <div>
      <h1>Settings</h1>

      <div className="panel">
        <h2>Data folder</h2>
        <p className="muted">
          Profiles, test runs, and CSV data are stored as files in a folder you
          choose — interchangeable with the desktop app's data directory.
        </p>
        <div className="row">
          <button className="primary" onClick={choose}>
            {dirName ? 'Change folder' : 'Choose folder'}
          </button>
          {needsPermission && (
            <button onClick={grant}>Grant access to “{dirName}”</button>
          )}
          {dirName && !needsPermission && (
            <span className="muted">Current: {dirName}</span>
          )}
          {folderReady && (
            <button onClick={rescan} disabled={rescanning} title="Rebuild the run history index from the files on disk (recovers runs after a folder switch or a corrupt index).">
              {rescanning ? 'Rescanning…' : 'Rescan folder'}
            </button>
          )}
          {message && <span className="muted">{message}</span>}
        </div>
      </div>

      <Config embedded />

      <div className="panel">
        <h2>About</h2>
        <p className="muted">
          Frontend-only control app. Talks to the Propeller 2 over the Web Serial
          API; the protocol runs as WebAssembly compiled from the same Rust core
          used by the firmware tooling and SIL. Firmware flashing is not available
          in the browser — use the desktop app for that.
        </p>
      </div>
    </div>
  );
}
