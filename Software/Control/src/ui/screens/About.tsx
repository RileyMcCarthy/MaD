import { ISSUE_REPO } from '@/diagnostics/report';
import BugReportForm from '@/ui/components/BugReportForm';
import { DOCS, GUIDES, USER_GUIDE_PATH } from '@/ui/docsLinks';
import VersionPicker from '@/ui/components/VersionPicker';

export default function About() {
  return (
    <div>
      <h1>About</h1>

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
        <div style={{ marginTop: 12 }}>
          <VersionPicker />
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          Control app for the MaD tensile tester. Runs in Chrome or Edge on desktop.{' '}
          <a href={`https://github.com/${ISSUE_REPO}`} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </p>
      </div>

      <div className="panel">
        <h2>Documentation</h2>
        <ul data-testid="docs-links" style={{ margin: 0, paddingLeft: 18 }}>
          {GUIDES.map((g) => (
            <li key={g.path} style={{ marginBottom: 4 }}>
              <a href={`${DOCS}${g.path}`} target="_blank" rel="noreferrer">
                {g.title}
              </a>
              <span className="muted"> — {g.what}</span>
            </li>
          ))}
        </ul>
        <p className="muted" style={{ marginTop: 12 }}>
          Everything else is in the{' '}
          <a href={`${DOCS}${USER_GUIDE_PATH}`} target="_blank" rel="noreferrer">
            user guide
          </a>
          .
        </p>
      </div>

      <div className="panel">
        <h2>Report a bug</h2>
        <p className="muted">
          Saves this session&apos;s log — connection events, protocol traffic, errors and
          timings — then opens a pre-filled GitHub issue. Attach the downloaded file to the
          issue so the problem can be traced without reproducing it.
        </p>
        <BugReportForm />
      </div>
    </div>
  );
}
