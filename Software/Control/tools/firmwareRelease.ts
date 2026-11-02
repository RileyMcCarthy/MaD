/**
 * Vite plugin: serve the latest firmware release from the app's own origin.
 *
 * The browser cannot fetch a release asset from GitHub (no CORS on the asset
 * host), so this plugin does it in Node and serves `firmware/latest.json`,
 * `firmware/latest.bin` (the P2Eval build) and one more image per other board
 * the release carries, e.g. `firmware/latest-MaDEdge.bin` (see
 * src/firmware/release.ts):
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
  BOARDS,
  BOARD_IMAGE_PATHS,
  RELEASE_IMAGE_PATH,
  RELEASE_MANIFEST_PATH,
  pickFirmwareAsset,
  pickFirmwareRelease,
  toManifest,
  type Board,
  type BoardImage,
  type FirmwareReleaseManifest,
  type GithubAsset,
  type GithubRelease,
} from '../src/firmware/release';

export interface Bundled {
  manifest: FirmwareReleaseManifest;
  /** The P2Eval image, served at `firmware/latest.bin`. */
  image: Buffer;
  /** Every other board's image the release carries. */
  boardImages?: Partial<Record<Board, Buffer>>;
}

/** Every file a bundle serves, by its path under the app's base URL. */
export function servedFiles(bundled: Bundled): Array<[string, string | Buffer]> {
  const files: Array<[string, string | Buffer]> = [
    [RELEASE_MANIFEST_PATH, JSON.stringify(bundled.manifest)],
    [RELEASE_IMAGE_PATH, bundled.image],
  ];
  for (const board of BOARDS) {
    const image = bundled.boardImages?.[board];
    if (image && board !== 'P2Eval') files.push([BOARD_IMAGE_PATHS[board], image]);
  }
  return files;
}

/** What the plugin reads from the outside world. Defaults to the real `fetch`
 *  and `process.env`; tests pass stubs so no network or module reload is needed. */
export interface FirmwareReleaseDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

function headers(env: Record<string, string | undefined>, accept: string): Record<string, string> {
  const h: Record<string, string> = { Accept: accept, 'User-Agent': 'mad-control-build' };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

/** The newest firmware release image and its manifest, from GitHub. */
export async function fetchLatestFirmware(
  fetchFn: typeof fetch,
  env: Record<string, string | undefined>,
): Promise<Bundled> {
  const repo = env.MAD_FIRMWARE_REPO || 'RileyMcCarthy/MaD';
  const api = `https://api.github.com/repos/${repo}`;
  const list = await fetchFn(`${api}/releases?per_page=100`, {
    headers: headers(env, 'application/vnd.github+json'),
  });
  if (!list.ok) throw new Error(`listing releases of ${repo}: HTTP ${list.status}`);
  const picked = pickFirmwareRelease((await list.json()) as GithubRelease[]);
  if (!picked) throw new Error(`${repo} has no firmware release with a flashable image`);

  const download = async (asset: GithubAsset): Promise<Buffer> => {
    const res = await fetchFn(`${api}/releases/assets/${asset.id}`, {
      headers: headers(env, 'application/octet-stream'),
    });
    if (!res.ok) throw new Error(`downloading ${asset.name}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength !== asset.size) {
      throw new Error(`${asset.name}: got ${bytes.byteLength} bytes, release says ${asset.size}`);
    }
    return bytes;
  };

  // The P2Eval image is the default and must download; each other board's is
  // served too when the release carries one.
  const boardImages: Partial<Record<Board, Buffer>> = {};
  const boards: Partial<Record<Board, BoardImage>> = {};
  for (const board of BOARDS) {
    const asset = board === 'P2Eval' ? picked.asset : pickFirmwareAsset(picked.release, board);
    if (!asset) continue;
    const bytes = await download(asset);
    boardImages[board] = bytes;
    boards[board] = {
      assetName: asset.name,
      size: asset.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  const image = boardImages.P2Eval!;
  return {
    manifest: toManifest(picked.release, picked.asset, boards.P2Eval!.sha256, boards),
    image,
    boardImages,
  };
}

export function firmwareRelease(deps: FirmwareReleaseDeps = {}): Plugin {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const disabled = env.MAD_FIRMWARE_RELEASE === 'off';
  const required = env.MAD_FIRMWARE_RELEASE_REQUIRED === '1';
  let cached: Promise<Bundled> | null = null;
  const latest = () => {
    cached ??= fetchLatestFirmware(fetchFn, env);
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
      const paths = [RELEASE_MANIFEST_PATH, ...BOARDS.map((b) => BOARD_IMAGE_PATHS[b])];
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        const wanted = paths.find((p) => path.endsWith(`/${p}`));
        if (!wanted) return next();
        latest().then(
          (bundled) => {
            const file = servedFiles(bundled).find(([p]) => p === wanted);
            if (!file) {
              // A board this release has no image for.
              res.statusCode = 404;
              res.end();
              return;
            }
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader(
              'Content-Type',
              wanted === RELEASE_MANIFEST_PATH ? 'application/json' : 'application/octet-stream',
            );
            res.end(file[1]);
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
        const bundled = await latest();
        for (const [fileName, source] of servedFiles(bundled)) {
          this.emitFile({ type: 'asset', fileName, source });
        }
        const { manifest } = bundled;
        this.info(`bundled ${manifest.tag} (${Object.values(manifest.boards ?? {}).map((b) => b.assetName).join(', ') || manifest.assetName})`);
      } catch (err) {
        if (required) this.error(`no firmware release to bundle: ${String(err)}`);
        this.warn(`no firmware release bundled; the Firmware screen will offer local files only (${String(err)})`);
      }
    },
  };
}
