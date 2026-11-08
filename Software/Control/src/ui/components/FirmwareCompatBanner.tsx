import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '@/store/useStore';
import { blocksMotion, describeAppForFirmware, describeFirmwareCompat, type AppForFirmware } from '@/domain';
import {
  appForFirmware,
  fetchHostedVersions,
  hostedVersion,
  hostingRoot,
  versionUrl,
  type HostedVersions,
} from '@/hosting';

/**
 * Where an app too old for firmware on `deviceProtocol` can send the operator
 * (appForFirmware), from the release list beside this release, read once per
 * connection that needs it.
 */
function useAppForFirmware(deviceProtocol: number | null): AppForFirmware | null {
  const base = import.meta.env.BASE_URL;
  const hosted = hostedVersion(base) !== null;
  const [found, setFound] = useState<{ protocol: number; list: HostedVersions | null } | null>(null);
  useEffect(() => {
    if (deviceProtocol === null || !hosted) return;
    let live = true;
    void fetchHostedVersions(base).then((list) => {
      if (live) setFound({ protocol: deviceProtocol, list });
    });
    return () => {
      live = false;
      // A list that could not be read is asked for again on the next connection.
      setFound(null);
    };
  }, [base, hosted, deviceProtocol]);
  if (deviceProtocol === null) return null;
  return appForFirmware(hosted, found?.protocol === deviceProtocol ? found.list : undefined, deviceProtocol);
}

/**
 * Open another copy of MaD Control at `url`, on the same screen. Each hosted
 * release lives in its own frozen folder beside this one; the port is let go
 * first, so the app opened can take it.
 */
async function openApp(disconnect: () => Promise<void>, url: string): Promise<void> {
  await disconnect();
  window.location.assign(`${url}${window.location.hash}`);
}

/**
 * Whether this app can drive the connected firmware, shown on every screen
 * while it cannot (still checking, no answer, another protocol) or an update
 * is recommended, with the way out. `data-kind` names the verdict.
 */
export default function FirmwareCompatBanner() {
  const compat = useStore((s) => s.firmwareCompat);
  const disconnect = useStore((s) => s.disconnect);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const app = useAppForFirmware(compat?.kind === 'appTooOld' ? compat.deviceProtocol : null);
  if (compat === null || compat.kind === 'ok') return null;
  const blocking = blocksMotion(compat) && compat.kind !== 'checking';
  // The Firmware screen is where every firmware way out leads.
  const toFirmware = (label: string, testId: string, primary: boolean) =>
    pathname !== '/firmware' && (
      <button className={primary ? 'primary' : undefined} onClick={() => navigate('/firmware')} data-testid={testId}>
        {label}
      </button>
    );

  if (compat.kind === 'appTooOld' && app !== null) {
    // Firmware a protocol ahead: open the release that speaks it, or put this
    // app's firmware back on the machine. With the release list unread, the
    // latest release is the best guess, and reflashing is not urged.
    const base = import.meta.env.BASE_URL;
    const way = describeAppForFirmware(compat.deviceProtocol, app);
    const open =
      app.kind === 'release'
        ? { label: `Open MaD Control ${app.version}`, url: versionUrl(base, app.version), testId: 'open-app-release' }
        : app.kind === 'unknown'
          ? { label: 'Open the latest MaD Control', url: hostingRoot(base), testId: 'open-latest-app' }
          : null;
    return (
      <div className="banner error" role="alert" data-testid="firmware-compat" data-kind={compat.kind}>
        <span>
          {describeFirmwareCompat(compat)}
          {way !== null && ` ${way}`}
        </span>
        {open !== null && (
          <button className="primary" onClick={() => void openApp(disconnect, open.url)} data-testid={open.testId}>
            {open.label}
          </button>
        )}{' '}
        {toFirmware('Install firmware for this app', 'install-app-firmware', app.kind === 'none')}
      </div>
    );
  }

  return (
    <div
      className={`banner ${blocking ? 'error' : 'warn'}`}
      role={compat.kind === 'checking' ? 'status' : 'alert'}
      data-testid="firmware-compat"
      data-kind={compat.kind}
    >
      <span>{describeFirmwareCompat(compat)}</span>
      {compat.kind !== 'checking' && toFirmware('Update firmware', 'update-firmware', blocking)}
    </div>
  );
}
