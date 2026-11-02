/**
 * Vite plugin: serve the firmware releases from the app's own origin.
 *
 * The browser cannot fetch a release asset from GitHub (no CORS on the asset
 * host), so this plugin does it in Node and serves the files under `firmware/`
 * that src/firmware/release.ts describes: `manifest.json` with the newest
 * release per protocol version and every board image each carries, under its
 * own file name; and `latest.json` + `latest.bin` (the P2Eval build) + one
 * `latest-<Board>.bin` per other board, for app versions from before the
 * manifest. The Pages deploy (assemble-pages-app.mts) writes the same files
 * from the same function.
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
  FIRMWARE_INFO_ASSET,
  FIRMWARE_MANIFEST_PATH,
  RELEASE_IMAGE_PATH,
  RELEASE_MANIFEST_PATH,
  describedReleases,
  isFirmwareInfo,
  firmwareImagePath,
  newestPerProtocol,
  pickFirmwareAsset,
  pickFirmwareRelease,
  toManifest,
  toManifestEntry,
  type Board,
  type BoardImage,
  type FirmwareManifest,
  type FirmwareReleaseManifest,
  type GithubAsset,
  type GithubRelease,
} from '../src/firmware/release';

/** Everything served under `firmware/`. */
export interface FirmwareSite {
  /** The newest release of all, served as `firmware/latest.*`. */
  latest: FirmwareReleaseManifest;
  /** `firmware/manifest.json`: the newest release for each protocol version. */
  manifest: FirmwareManifest;
  /** Every file to serve, by path relative to the hosting root. */
  files: Map<string, Buffer>;
  /** Releases left out of the manifest, each with why (a malformed firmware-info.json). */
  warnings: string[];
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

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The repository's releases, and a download of any of their assets. */
async function githubReleases(fetchFn: typeof fetch, env: Record<string, string | undefined>) {
  const repo = env.MAD_FIRMWARE_REPO || 'RileyMcCarthy/MaD';
  const api = `https://api.github.com/repos/${repo}`;
  const list = await fetchFn(`${api}/releases?per_page=100`, {
    headers: headers(env, 'application/vnd.github+json'),
  });
  if (!list.ok) throw new Error(`listing releases of ${repo}: HTTP ${list.status}`);
  const releases = (await list.json()) as GithubRelease[];

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
  return { repo, releases, download };
}

/**
 * The newest release for each protocol version, read from each release's
 * firmware-info.json. A release whose file is malformed is left out, with a
 * warning: one bad release must not stop every deploy. A download that fails
 * still throws, since a retry fixes it.
 */
async function newestByProtocol(
  releases: GithubRelease[],
  download: (asset: GithubAsset) => Promise<Buffer>,
  warn: (message: string) => void,
) {
  const described = [];
  for (const candidate of describedReleases(releases)) {
    let info: unknown = null;
    try {
      info = JSON.parse((await download(candidate.info)).toString('utf8'));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (!isFirmwareInfo(info)) {
      warn(`${candidate.release.tag_name}: ${FIRMWARE_INFO_ASSET} is malformed; the release is left out of the firmware list`);
      continue;
    }
    described.push({ ...candidate, protocolVersion: info.protocolVersion });
  }
  return newestPerProtocol(described);
}

/**
 * The newest published firmware release for each protocol version, without
 * downloading any image: what MaD Control's release check asks of GitHub.
 */
export async function releasedProtocols(
  fetchFn: typeof fetch,
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (message) => console.warn(`warning: ${message}`),
): Promise<{ tag: string; protocolVersion: number }[]> {
  const { releases, download } = await githubReleases(fetchFn, env);
  return (await newestByProtocol(releases, download, warn)).map((c) => ({
    tag: c.release.tag_name,
    protocolVersion: c.protocolVersion,
  }));
}

/** The firmware files to serve, from the repository's GitHub releases. */
export async function fetchFirmwareSite(
  fetchFn: typeof fetch,
  env: Record<string, string | undefined>,
): Promise<FirmwareSite> {
  const { repo, releases, download } = await githubReleases(fetchFn, env);
  const picked = pickFirmwareRelease(releases);
  if (!picked) throw new Error(`${repo} has no firmware release with a flashable image`);

  // Each asset is downloaded once, however many of the files below serve it.
  const downloaded = new Map<number, Promise<Buffer>>();
  const fetchAsset = (asset: GithubAsset) => {
    let bytes = downloaded.get(asset.id);
    if (!bytes) {
      bytes = download(asset);
      downloaded.set(asset.id, bytes);
    }
    return bytes;
  };
  /** Every board image a release carries: the P2Eval one must download, the
   *  others are served when the release has them. */
  const releaseImages = async (release: GithubRelease, p2eval: GithubAsset) => {
    const images: { board: Board; asset: GithubAsset; bytes: Buffer }[] = [];
    for (const board of BOARDS) {
      const asset = board === 'P2Eval' ? p2eval : pickFirmwareAsset(release, board);
      if (asset) images.push({ board, asset, bytes: await fetchAsset(asset) });
    }
    return images;
  };
  const describe = (images: { board: Board; asset: GithubAsset; bytes: Buffer }[], served: (b: Board, a: GithubAsset) => string | undefined) => {
    const boards: Partial<Record<Board, BoardImage>> = {};
    for (const { board, asset, bytes } of images) {
      const path = served(board, asset);
      boards[board] = { assetName: asset.name, size: asset.size, sha256: sha256(bytes), ...(path ? { path } : {}) };
    }
    return boards;
  };

  // The newest release of all: latest.json, latest.bin and latest-<Board>.bin.
  const latestImages = await releaseImages(picked.release, picked.asset);
  const latestBoards = describe(latestImages, () => undefined);
  const latest = toManifest(picked.release, picked.asset, latestBoards.P2Eval!.sha256, latestBoards);
  const files = new Map<string, Buffer>([[RELEASE_MANIFEST_PATH, Buffer.from(JSON.stringify(latest))]]);
  for (const { board, bytes } of latestImages) files.set(BOARD_IMAGE_PATHS[board], bytes);

  // The newest release per protocol: every board image under its own name.
  const warnings: string[] = [];
  const manifest: FirmwareManifest = { releases: [] };
  for (const c of await newestByProtocol(releases, download, (w) => void warnings.push(w))) {
    const images = await releaseImages(c.release, c.asset);
    const boards = describe(images, (_, asset) => firmwareImagePath(asset.name));
    manifest.releases.push(toManifestEntry(c.release, c.asset, boards.P2Eval!.sha256, c.protocolVersion, boards));
    for (const { asset, bytes } of images) files.set(firmwareImagePath(asset.name), bytes);
  }
  files.set(FIRMWARE_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest)));
  return { latest, manifest, files, warnings };
}

/** One line for a log: what the site serves. */
export function describeSite(site: FirmwareSite): string {
  const perProtocol = site.manifest.releases.map((r) => `${r.tag} (protocol ${r.protocolVersion})`);
  const latestImages = Object.values(site.latest.boards ?? {}).map((b) => b.assetName).join(', ') || site.latest.assetName;
  return `latest ${site.latest.tag} (${latestImages}); recommended per protocol: ${
    perProtocol.length > 0 ? perProtocol.join(', ') : 'none yet'
  }`;
}

export function firmwareRelease(deps: FirmwareReleaseDeps = {}): Plugin {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const disabled = env.MAD_FIRMWARE_RELEASE === 'off';
  const required = env.MAD_FIRMWARE_RELEASE_REQUIRED === '1';
  let cached: Promise<FirmwareSite> | null = null;
  const site = () => {
    cached ??= fetchFirmwareSite(fetchFn, env);
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
        // Which files exist is known only once GitHub has answered, so every
        // .json/.bin directly under firmware/ is looked up there first.
        const wanted = /\/(firmware\/[^/]+\.(?:json|bin))$/.exec(path)?.[1];
        if (!wanted) return next();
        site().then(
          ({ files, warnings }) => {
            for (const w of warnings) server.config.logger.warn(`[firmware-release] ${w}`, { timestamp: false });
            const body = files.get(wanted);
            if (!body) return next();
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', wanted.endsWith('.json') ? 'application/json' : 'application/octet-stream');
            res.end(body);
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
        const s = await site();
        for (const w of s.warnings) this.warn(w);
        for (const [fileName, source] of s.files) this.emitFile({ type: 'asset', fileName, source });
        this.info(`bundled ${describeSite(s)}`);
      } catch (err) {
        if (required) this.error(`no firmware release to bundle: ${String(err)}`);
        this.warn(`no firmware release bundled; the Firmware screen will offer local files only (${String(err)})`);
      }
    },
  };
}
