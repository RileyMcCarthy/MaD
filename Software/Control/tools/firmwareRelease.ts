/**
 * Vite plugin: serve the latest firmware release from the app's own origin.
 *
 * The browser cannot fetch a release asset from GitHub (no CORS on the asset
 * host), so this plugin does it in Node and serves `firmware/latest.json` +
 * `firmware/latest.bin` (see src/firmware/release.ts):
 *  - dev server: fetched from GitHub on the first request, then cached for the
 *    life of the server;
 *  - build: fetched once and emitted into the bundle.
 *
 * Environment:
 *  - MAD_FIRMWARE_REPO               owner/name to read releases from (default RileyMcCarthy/MaD)
 *  - GITHUB_TOKEN                    optional; lifts the 60 requests/hour anonymous limit
 *  - MAD_FIRMWARE_RELEASE=off        serve nothing (offline work; the screen then offers only a local file)
 *  - MAD_FIRMWARE_RELEASE_REQUIRED=1 fail the build when no release can be bundled (CI)
 */
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import {
  RELEASE_IMAGE_PATH,
  RELEASE_MANIFEST_PATH,
  pickFirmwareRelease,
  toManifest,
  type FirmwareReleaseManifest,
  type GithubRelease,
} from '../src/firmware/release';

const REPO = process.env.MAD_FIRMWARE_REPO || 'RileyMcCarthy/MaD';

interface Bundled {
  manifest: FirmwareReleaseManifest;
  image: Buffer;
}

function headers(accept: string): Record<string, string> {
  const h: Record<string, string> = { Accept: accept, 'User-Agent': 'mad-control-build' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function fetchLatest(): Promise<Bundled> {
  const api = `https://api.github.com/repos/${REPO}`;
  const list = await fetch(`${api}/releases?per_page=100`, {
    headers: headers('application/vnd.github+json'),
  });
  if (!list.ok) throw new Error(`listing releases of ${REPO}: HTTP ${list.status}`);
  const picked = pickFirmwareRelease((await list.json()) as GithubRelease[]);
  if (!picked) throw new Error(`${REPO} has no firmware release with a flashable image`);

  const asset = await fetch(`${api}/releases/assets/${picked.asset.id}`, {
    headers: headers('application/octet-stream'),
  });
  if (!asset.ok) throw new Error(`downloading ${picked.asset.name}: HTTP ${asset.status}`);
  const image = Buffer.from(await asset.arrayBuffer());
  if (image.byteLength !== picked.asset.size) {
    throw new Error(`${picked.asset.name}: got ${image.byteLength} bytes, release says ${picked.asset.size}`);
  }
  const sha256 = createHash('sha256').update(image).digest('hex');
  return { manifest: toManifest(picked.release, picked.asset, sha256), image };
}

export function firmwareRelease(): Plugin {
  const disabled = process.env.MAD_FIRMWARE_RELEASE === 'off';
  const required = process.env.MAD_FIRMWARE_RELEASE_REQUIRED === '1';
  let cached: Promise<Bundled> | null = null;
  const latest = () => {
    cached ??= fetchLatest();
    // A failure is not cached: the next request (say, once back online) retries.
    cached.catch(() => {
      cached = null;
    });
    return cached;
  };

  return {
    name: 'mad-firmware-release',

    configureServer(server) {
      if (disabled) return;
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        const wantsManifest = path.endsWith(`/${RELEASE_MANIFEST_PATH}`);
        const wantsImage = path.endsWith(`/${RELEASE_IMAGE_PATH}`);
        if (!wantsManifest && !wantsImage) return next();
        latest().then(
          ({ manifest, image }) => {
            res.setHeader('Cache-Control', 'no-store');
            if (wantsManifest) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(manifest));
            } else {
              res.setHeader('Content-Type', 'application/octet-stream');
              res.end(image);
            }
          },
          (err: unknown) => {
            server.config.logger.warn(`[firmware-release] ${String(err)}`);
            res.statusCode = 503;
            res.end();
          },
        );
      });
    },

    async generateBundle() {
      if (disabled) return;
      try {
        const { manifest, image } = await latest();
        this.emitFile({ type: 'asset', fileName: RELEASE_MANIFEST_PATH, source: JSON.stringify(manifest) });
        this.emitFile({ type: 'asset', fileName: RELEASE_IMAGE_PATH, source: image });
        this.info(`bundled ${manifest.tag} (${manifest.assetName}, ${manifest.size} bytes)`);
      } catch (err) {
        if (required) this.error(`no firmware release to bundle: ${String(err)}`);
        this.warn(`no firmware release bundled; the Firmware screen will offer local files only (${String(err)})`);
      }
    },
  };
}
