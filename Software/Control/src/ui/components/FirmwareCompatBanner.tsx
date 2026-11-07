import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '@/store/useStore';
import { blocksMotion, describeFirmwareCompat } from '@/domain';
import { appForProtocol, fetchHostedVersions, hostedVersion, versionUrl } from '@/hosting';

/**
 * Where a firmware a protocol ahead of this app leaves the operator:
 *   'reload'   an unversioned copy (a dev server): reloading may bring a newer build
 *   'looking'  the release list is on its way
 *   string     the newest hosted release that speaks the firmware's protocol
 *   'none'     no released app speaks it: the firmware is unreleased, so the
 *              way out is the recommended firmware, not another app
 */
type NewerApp = 'reload' | 'looking' | 'none' | { version: string };

function useNewerApp(deviceProtocol: number | null): NewerApp | null {
  const base = import.meta.env.BASE_URL;
  const [found, setFound] = useState<{ protocol: number; app: NewerApp } | null>(null);
  useEffect(() => {
    if (deviceProtocol === null || hostedVersion(base) === null) return;
    let live = true;
    void fetchHostedVersions(base).then((list) => {
      const version = list ? appForProtocol(list, deviceProtocol) : null;
      if (live) setFound({ protocol: deviceProtocol, app: version ? { version } : 'none' });
    });
    return () => {
      live = false;
    };
  }, [base, deviceProtocol]);
  if (deviceProtocol === null) return null;
  if (hostedVersion(base) === null) return 'reload';
  return found?.protocol === deviceProtocol ? found.app : 'looking';
}

/**
 * Open the release that speaks the firmware's protocol, on the same screen. A
 * hosted release lives in its own frozen folder, so it is opened by its
 * address; an unversioned copy reloads, which also applies a waiting
 * service-worker update.
 */
async function openApp(disconnect: () => Promise<void>, version: string | null): Promise<void> {
  await disconnect();
  if (version === null) window.location.reload();
  else window.location.assign(versionUrl(import.meta.env.BASE_URL, version, window.location.hash));
}

/** The second sentence of a too-old app's banner: where to go from here. */
function appTooOldWayOut(app: NewerApp, deviceProtocol: number): string {
  if (app === 'reload') return 'Reload to load a newer build of MaD Control, or install the recommended firmware.';
  if (app === 'looking') return 'Looking for a MaD Control release that speaks it…';
  if (app === 'none') {
    return `No released MaD Control speaks protocol ${deviceProtocol}, so the machine is running unreleased firmware: install the recommended firmware.`;
  }
  return `MaD Control ${app.version} speaks it.`;
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
  const newerApp = useNewerApp(compat?.kind === 'appTooOld' ? compat.deviceProtocol : null);
  if (compat === null || compat.kind === 'ok') return null;
  const blocking = blocksMotion(compat) && compat.kind !== 'checking';

  // Whether opening another app is the way out; otherwise the firmware is.
  const openable = newerApp === 'reload' || (typeof newerApp === 'object' && newerApp !== null);
  const updateButton = pathname !== '/firmware' && (
    <button
      className={blocking && !openable ? 'primary' : undefined}
      onClick={() => navigate('/firmware')}
      data-testid="update-firmware"
    >
      Update firmware
    </button>
  );

  return (
    <div
      className={`banner ${blocking ? 'error' : 'warn'}`}
      role={compat.kind === 'checking' ? 'status' : 'alert'}
      data-testid="firmware-compat"
      data-kind={compat.kind}
    >
      <span>
        {describeFirmwareCompat(compat)}
        {compat.kind === 'appTooOld' && newerApp !== null && ` ${appTooOldWayOut(newerApp, compat.deviceProtocol)}`}
      </span>
      {compat.kind === 'checking' ? null : compat.kind === 'appTooOld' ? (
        <>
          {openable && (
            <button
              className="primary"
              onClick={() => void openApp(disconnect, newerApp === 'reload' ? null : newerApp.version)}
              data-testid="open-latest-app"
            >
              {newerApp === 'reload' ? 'Reload MaD Control' : `Open MaD Control ${newerApp.version}`}
            </button>
          )}{' '}
          {updateButton}
        </>
      ) : (
        updateButton
      )}
    </div>
  );
}
