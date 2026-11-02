/**
 * Service-worker registration with a *deferred* update flow.
 *
 * The app may be holding a live serial connection / running a test, so we never
 * auto-reload. When a new version is waiting we tell the store; the user applies
 * it only when idle (see `applyUpdate` in the store).
 */
import { registerSW } from 'virtual:pwa-register';
import { useStore } from '@/store/useStore';
import { cacheRecommendedRelease } from '@/firmware/release';
import { hostingRoot } from '@/hosting';
import { PROTOCOL_VERSION } from '@/protocol/generated/protoemb';

export function setupPwa(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      useStore.getState().notifyUpdateAvailable(() => {
        void updateSW(true); // skip waiting + reload — only called when idle
      });
    },
  });
  // Once a service worker controls the page, fetch the recommended firmware so
  // it is cached for an offline update. A first visit is not controlled yet
  // (no clientsClaim); the next one caches it.
  if (navigator.serviceWorker?.controller) {
    void cacheRecommendedRelease(hostingRoot(import.meta.env.BASE_URL), PROTOCOL_VERSION);
  }
}
