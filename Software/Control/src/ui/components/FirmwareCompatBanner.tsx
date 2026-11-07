import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '@/store/useStore';
import { blocksMotion, describeAppForFirmware, describeFirmwareCompat } from '@/domain';
import { appForProtocol, fetchHostedVersions, hostedVersion, versionUrl } from '@/hosting';

/**
 * The released MaD Control that speaks a newer firmware's protocol: its
 * version, null when there is none to offer, or 'looking' while the release
 * list is on its way. An unversioned copy (a dev server) has no list beside
 * it, so it has none to offer.
 */
function useAppForFirmware(deviceProtocol: number | null): string | null | 'looking' {
  const base = import.meta.env.BASE_URL;
  const hosted = hostedVersion(base) !== null;
  const [found, setFound] = useState<{ protocol: number; release: string | null } | null>(null);
  useEffect(() => {
    if (deviceProtocol === null || !hosted) return;
    let live = true;
    void fetchHostedVersions(base).then((list) => {
      if (live) setFound({ protocol: deviceProtocol, release: list ? appForProtocol(list, deviceProtocol) : null });
    });
    return () => {
      live = false;
    };
  }, [base, hosted, deviceProtocol]);
  if (deviceProtocol === null || !hosted) return null;
  return found?.protocol === deviceProtocol ? found.release : 'looking';
}

/**
 * Open release `version` of MaD Control on the same screen. A hosted release
 * lives in its own frozen folder beside this one; the port is let go first,
 * so the release opened can take it.
 */
async function openRelease(disconnect: () => Promise<void>, version: string): Promise<void> {
  await disconnect();
  window.location.assign(versionUrl(import.meta.env.BASE_URL, version, window.location.hash));
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
  const release = useAppForFirmware(compat?.kind === 'appTooOld' ? compat.deviceProtocol : null);
  if (compat === null || compat.kind === 'ok') return null;
  const blocking = blocksMotion(compat) && compat.kind !== 'checking';
  // The Firmware screen is where every firmware way out leads.
  const toFirmware = (label: string, testId: string, primary: boolean) =>
    pathname !== '/firmware' && (
      <button className={primary ? 'primary' : undefined} onClick={() => navigate('/firmware')} data-testid={testId}>
        {label}
      </button>
    );

  if (compat.kind === 'appTooOld') {
    // Firmware a protocol ahead: open the release that speaks it, or put this
    // app's firmware back on the machine.
    const found = release === 'looking' ? null : release;
    return (
      <div className="banner error" role="alert" data-testid="firmware-compat" data-kind={compat.kind}>
        <span>
          {describeFirmwareCompat(compat)}
          {release !== 'looking' && ` ${describeAppForFirmware(compat.deviceProtocol, release)}`}
        </span>
        {found !== null && (
          <button
            className="primary"
            onClick={() => void openRelease(disconnect, found)}
            data-testid="open-app-release"
          >
            Open MaD Control {found}
          </button>
        )}{' '}
        {toFirmware('Install firmware for this app', 'install-app-firmware', found === null)}
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
