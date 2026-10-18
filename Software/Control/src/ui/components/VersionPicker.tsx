import { useEffect, useState } from 'react';
import { fetchHostedVersions, hostedVersion, versionUrl, type HostedVersions } from '@/hosting';

/**
 * Which MaD Control release this is, and a way to open another one. Each
 * release lives at its own address, so switching is a navigation that keeps
 * the current page.
 */
export default function VersionPicker() {
  const base = import.meta.env.BASE_URL;
  const current = hostedVersion(base);
  const [hosted, setHosted] = useState<HostedVersions | null>(null);

  useEffect(() => {
    let live = true;
    void fetchHostedVersions(base).then((v) => live && setHosted(v));
    return () => {
      live = false;
    };
  }, [base]);

  if (current === null) {
    return <p className="muted">Development build — not a published release.</p>;
  }
  if (!hosted || hosted.versions.length < 2) return null;

  return (
    <label className="field" style={{ maxWidth: 320 }}>
      Open another release
      <select
        value={current}
        data-testid="version-picker"
        onChange={(e) => {
          window.location.href = versionUrl(base, e.target.value, window.location.hash);
        }}
      >
        {hosted.versions.map((v) => (
          <option key={v.version} value={v.version}>
            {v.version}
            {v.version === hosted.latest ? ' (latest)' : ''}
            {v.publishedAt ? ` — ${new Date(v.publishedAt).toLocaleDateString()}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
