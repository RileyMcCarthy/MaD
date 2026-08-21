/**
 * Service-worker registration with a *deferred* update flow.
 *
 * The app may be holding a live serial connection / running a test, so we never
 * auto-reload. When a new version is waiting we tell the store; the user applies
 * it only when idle (see `applyUpdate` in the store).
 */
import { registerSW } from 'virtual:pwa-register';
import { useStore } from '@/store/useStore';

export function setupPwa(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      useStore.getState().notifyUpdateAvailable(() => {
        void updateSW(true); // skip waiting + reload — only called when idle
      });
    },
  });
}
