import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '@/store/useStore';
import { blocksMotion, describeFirmwareCompat } from '@/domain';
import { hostedVersion, hostingRoot } from '@/hosting';

/**
 * Open the newest MaD Control. A hosted release lives in its own frozen folder,
 * so reloading it would bring the same version back: go to the hosting root,
 * which redirects to the latest release. An unversioned copy reloads, which
 * also applies a waiting service-worker update.
 */
async function openLatestApp(disconnect: () => Promise<void>): Promise<void> {
  await disconnect();
  const base = import.meta.env.BASE_URL;
  if (hostedVersion(base) !== null) window.location.assign(hostingRoot(base));
  else window.location.reload();
}

/**
 * Whether this app can drive the connected firmware, shown on every screen
 * while it cannot (or an update is recommended), with the way out.
 */
export default function FirmwareCompatBanner() {
  const compat = useStore((s) => s.firmwareCompat);
  const disconnect = useStore((s) => s.disconnect);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (compat === null || compat.kind === 'ok') return null;
  const blocking = blocksMotion(compat);

  return (
    <div className={`banner ${blocking ? 'error' : 'warn'}`} role="alert" data-testid="firmware-compat">
      <span>{describeFirmwareCompat(compat)}</span>
      {compat.kind === 'appTooOld' ? (
        <button className="primary" onClick={() => void openLatestApp(disconnect)} data-testid="open-latest-app">
          Open the latest MaD Control
        </button>
      ) : (
        pathname !== '/firmware' && (
          <button
            className={blocking ? 'primary' : undefined}
            onClick={() => navigate('/firmware')}
            data-testid="update-firmware"
          >
            Update firmware
          </button>
        )
      )}
    </div>
  );
}
