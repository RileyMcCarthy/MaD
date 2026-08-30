import { useState } from 'react';
import {
  clearToken,
  getToken,
  looksLikeToken,
  setToken,
  verifyToken,
  GitHubError,
  ISSUE_OWNER,
  ISSUE_REPO_NAME,
  type TokenCheck,
} from '@/diagnostics/github';

/**
 * New **classic** token with the two scopes filing needs, pre-selected.
 *
 * Classic rather than fine-grained deliberately. A fine-grained token can only
 * be scoped to repositories you own or collaborate on, so its "Issues: write"
 * option is unavailable to anyone else — the instructions would work for the
 * maintainer and dead-end for every other user. `public_repo` is not limited to
 * your own repositories, so this path is identical for everyone.
 */
const NEW_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=public_repo,gist&description=MaD%20Control%20bug%20reports';

/**
 * Optional GitHub connection for one-click bug reports.
 *
 * Without a token the report flow still works — it downloads a bundle and opens
 * a pre-filled issue for the user to submit. A token removes the manual
 * attachment step, which is where reports otherwise get abandoned.
 */
export default function GitHubTokenSettings() {
  const [stored, setStored] = useState<boolean>(getToken() !== null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<TokenCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    setCheck(null);
    const token = value.trim();
    try {
      // Verified against the real repo before storing, so a token that cannot
      // actually file an issue is rejected here rather than at report time.
      const result = await verifyToken(token);
      if (!result.canFileIssues) {
        setError(
          `That token authenticated as ${result.login}, but has no access to ${ISSUE_OWNER}/${ISSUE_REPO_NAME}. Grant it read access to that repository.`,
        );
        return;
      }
      setToken(token);
      setStored(true);
      setCheck(result);
      setValue('');
    } catch (err) {
      if (err instanceof GitHubError && err.code === 'unauthorized') {
        setError('GitHub rejected that token. It may be expired, revoked, or mistyped.');
      } else if (err instanceof GitHubError && err.code === 'network') {
        setError('Could not reach GitHub. Check your connection and try again.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    clearToken();
    setStored(false);
    setCheck(null);
    setError(null);
  };

  return (
    <div className="panel">
      <h2>GitHub (optional)</h2>
      <p className="muted">
        Connect a GitHub token to file bug reports in one click, with the full session log
        attached automatically. Without it, reporting still works — it saves a file and opens a
        pre-filled issue for you to submit yourself.
      </p>

      {stored ? (
        <>
          <p data-testid="github-connected">
            <span className="badge downloaded">Connected</span>{' '}
            {check ? (
              <span className="muted">
                as {check.login}
                {check.canCreateGists ? '' : ' — no gist access, logs will not be attached'}
              </span>
            ) : (
              <span className="muted">a token is stored in this browser</span>
            )}
          </p>
          <div className="row">
            <button className="danger" onClick={disconnect} data-testid="github-disconnect">
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <ol className="muted" style={{ marginTop: 0 }}>
            <li>
              <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">
                Create a token
              </a>{' '}
              — the <code>public_repo</code> and <code>gist</code> scopes are pre-selected. The
              first lets it open an issue on{' '}
              <code>
                {ISSUE_OWNER}/{ISSUE_REPO_NAME}
              </code>
              , the second attaches your session log.
            </li>
            <li>Paste it below. It is stored in this browser only and never leaves it except to GitHub.</li>
          </ol>
          <label className="field">
            Personal access token
            <input
              type="password"
              value={value}
              placeholder="ghp_…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              data-testid="github-token-input"
            />
          </label>
          {value.trim() !== '' && !looksLikeToken(value) && (
            <p className="muted" data-testid="github-token-hint">
              That does not look like a GitHub token — they start with <code>github_pat_</code> or{' '}
              <code>ghp_</code>.
            </p>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="primary"
              onClick={() => void save()}
              disabled={busy || value.trim() === ''}
              data-testid="github-token-save"
            >
              {busy ? 'Verifying…' : 'Connect'}
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="fault" style={{ marginTop: 12 }} data-testid="github-token-error">
          {error}
        </p>
      )}
      <p className="muted" style={{ marginTop: 12 }}>
        The token is held in this browser&apos;s local storage, so anyone with access to this
        computer&apos;s browser profile could read it — revoke it from GitHub if you stop using
        this machine. Note that <code>public_repo</code> covers every public repository you can
        reach, not just this one; that breadth is what makes a single set of instructions work
        for everybody.
      </p>
    </div>
  );
}
