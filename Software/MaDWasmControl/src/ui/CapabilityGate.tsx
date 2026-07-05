import { ReactNode } from 'react';

/** Chromium-only browser APIs this app depends on. */
export function hasRequiredCapabilities(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serial' in navigator &&
    typeof window !== 'undefined' &&
    'showDirectoryPicker' in window
  );
}

/** Renders children only when Web Serial + File System Access are available. */
export default function CapabilityGate({ children }: { children: ReactNode }) {
  if (hasRequiredCapabilities()) return <>{children}</>;

  const missing: string[] = [];
  if (!('serial' in navigator)) missing.push('Web Serial');
  if (!('showDirectoryPicker' in window)) missing.push('File System Access');

  return (
    <div className="gate">
      <div className="panel card">
        <h1>Unsupported browser</h1>
        <p className="muted">
          MaD Control talks to the tester directly over USB and stores data on
          your disk. That needs APIs available only in Chromium-based browsers.
        </p>
        <p>
          Missing: <strong>{missing.join(', ')}</strong>
        </p>
        <p className="muted">
          Please open this app in <strong>Google Chrome</strong> or{' '}
          <strong>Microsoft Edge</strong> on desktop.
        </p>
      </div>
    </div>
  );
}
