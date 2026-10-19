import { ReactNode, useState } from 'react';
import { useStore } from '@/store/useStore';

/**
 * Renders children only once a data folder is open.
 *
 * Profiles, test runs and settings (the GitHub token among them) all live in
 * that folder, so the app asks for it before anything else rather than letting
 * a user set up a test that has nowhere to be saved.
 */
export default function DataFolderGate({ children }: { children: ReactNode }) {
  const checked = useStore((s) => s.dataFolderChecked);
  const ready = useStore((s) => s.dataFolderReady);
  const needsPermission = useStore((s) => s.dataFolderNeedsPermission);
  const folder = useStore((s) => s.dataFolder);
  const chooseDataFolder = useStore((s) => s.chooseDataFolder);
  const grantDataFolder = useStore((s) => s.grantDataFolder);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ready) return <>{children}</>;

  const attempt = async (action: () => Promise<void>, deniedMessage?: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (deniedMessage && !useStore.getState().dataFolderReady) setError(deniedMessage);
    } catch (err) {
      // Closing the folder picker is a change of mind, not a failure.
      if ((err as DOMException)?.name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate" data-testid="data-folder-gate">
      <div className="panel card">
        <h1>Choose a data folder</h1>
        {!checked ? (
          <p className="muted">Opening your data folder…</p>
        ) : (
          <>
            <p className="muted">
              MaD Control keeps sample profiles, motion profiles, test runs and its settings as
              plain files in a folder on your computer, so you can back them up and move them like
              any other files. Choose that folder to start.
            </p>
            {needsPermission && folder ? (
              <>
                <p>
                  The browser needs your permission again to use <strong>{folder}</strong>.
                </p>
                <div className="row">
                  <button
                    className="primary"
                    disabled={busy}
                    data-testid="grant-data-folder"
                    onClick={() =>
                      void attempt(grantDataFolder, `Access to “${folder}” was not granted.`)
                    }
                  >
                    Allow access to “{folder}”
                  </button>
                  <button
                    disabled={busy}
                    data-testid="choose-data-folder"
                    onClick={() => void attempt(chooseDataFolder)}
                  >
                    Choose a different folder
                  </button>
                </div>
              </>
            ) : (
              <div className="row">
                <button
                  className="primary"
                  disabled={busy}
                  data-testid="choose-data-folder"
                  onClick={() => void attempt(chooseDataFolder)}
                >
                  Choose data folder
                </button>
              </div>
            )}
            {error && (
              <p className="error" data-testid="data-folder-error">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
