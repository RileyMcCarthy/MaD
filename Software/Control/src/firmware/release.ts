/**
 * The published firmware releases, as the Firmware screen offers them.
 *
 * GitHub's release API answers cross-origin requests, but the asset bytes are
 * served from a host that sends no CORS header, so the browser cannot download
 * a release itself. The app's own origin serves it instead: the Vite plugin in
 * `tools/firmwareRelease.ts` proxies GitHub on the dev server and bundles the
 * files into a production build, and the Pages deploy writes the same files
 * once for every hosted app version (`tools/assemble-pages-app.mts`). Under
 * `firmware/` they are:
 *  - `manifest.json` ({@link FirmwareManifest}): the newest release for each
 *    protocol version, its image beside it under its own file name. An app
 *    offers the one that speaks its own protocol: the recommended firmware.
 *  - `latest.json` + `latest.bin`: the newest release of all, read by app
 *    versions from before the manifest.
 *
 * The selection logic is shared with that plugin, so it stays free of DOM and
 * Node APIs alike.
 */

/** Tags that are firmware releases; the repo also tags app and hardware releases. */
export const FIRMWARE_TAG_PREFIX = 'firmware-v';

/** Where the newest release and its image are served, relative to the hosting root. */
export const RELEASE_MANIFEST_PATH = 'firmware/latest.json';
export const RELEASE_IMAGE_PATH = 'firmware/latest.bin';

/** Where the newest release per protocol version is listed, relative to the hosting root. */
export const FIRMWARE_MANIFEST_PATH = 'firmware/manifest.json';

/**
 * The asset each firmware release carries beside its images, saying which
 * protocol its firmware speaks (written by ci.yml's firmware build from the
 * generated header). Releases from before the compatibility handshake have
 * none.
 */
export const FIRMWARE_INFO_ASSET = 'firmware-info.json';

/**
 * There is one firmware build (PlatformIO env `MaD`), its release asset
 * `MaD-Firmware-<version>.bin`. Its protocol runs on the secondary serial
 * (P30/P32), the control port; J1 is for programming only.
 *
 * Releases up to 0.14 carried single-port builds instead, named by board: the
 * production build (`-P2Eval.bin`, `-release.bin` before) answered on J1, the
 * port the app programs through, and the debug build (`-MaDEdge.bin`,
 * `-madEdge.bin`, `-debug.bin`) on pins this app cannot reach. Neither is ever
 * recommended: no app on the control port could talk to them.
 */
const LEGACY_SUFFIXES = ['P2Eval', 'release', 'MaDEdge', 'madEdge', 'debug'] as const;
/** The single-port production build of releases up to 0.14. */
const LEGACY_PRODUCTION_SUFFIXES = ['P2Eval', 'release'] as const;

/** Whether a release asset is the firmware image (the two-port build). */
export function isFirmwareImage(assetName: string): boolean {
  return (
    assetName.startsWith('MaD-Firmware-') &&
    assetName.endsWith('.bin') &&
    !LEGACY_SUFFIXES.some((suffix) => assetName.endsWith(`-${suffix}.bin`))
  );
}

/** The fields of a GitHub release this module reads. */
export interface GithubRelease {
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  assets: GithubAsset[];
}

export interface GithubAsset {
  id: number;
  name: string;
  size: number;
}

/** What `firmware/latest.json` says about the served image, `firmware/latest.bin`. */
export interface FirmwareReleaseManifest {
  tag: string;
  /** The tag without its prefix, e.g. "0.12". */
  version: string;
  assetName: string;
  size: number;
  /** Lowercase hex SHA-256 of the image, checked before anything is written. */
  sha256: string;
  publishedAt: string | null;
  htmlUrl: string;
  /** Where the image is served, relative to the hosting root;
   *  `firmware/latest.bin` when absent. */
  path?: string;
}

/** What a release's `firmware-info.json` says. */
export interface FirmwareInfo {
  version: string;
  protocolVersion: number;
}

/** One release in `firmware/manifest.json`: its image, served under its own file name. */
export interface FirmwareManifestEntry extends FirmwareReleaseManifest {
  /** The protocol version the release's firmware speaks. */
  protocolVersion: number;
  path: string;
}

/** `firmware/manifest.json`: the newest release for each protocol version. */
export interface FirmwareManifest {
  releases: FirmwareManifestEntry[];
}

/** A release's firmware image, or null when it carries none (every release up to 0.14). */
export function pickFirmwareAsset(release: GithubRelease): GithubAsset | null {
  return release.assets.find((a) => isFirmwareImage(a.name)) ?? null;
}

/**
 * What `latest.bin` serves from a release: its firmware image, else (a release
 * up to 0.14) its single-port production build, which the app versions that
 * read `latest.*` flash and reconnect to on the same port.
 */
function pickLatestAsset(release: GithubRelease): GithubAsset | null {
  return (
    pickFirmwareAsset(release) ??
    release.assets.find((a) => LEGACY_PRODUCTION_SUFFIXES.some((suffix) => a.name.endsWith(`-${suffix}.bin`))) ??
    null
  );
}

/** Where a manifest's image is served, relative to the hosting root. */
export function imagePath(manifest: FirmwareReleaseManifest): string {
  return manifest.path ?? RELEASE_IMAGE_PATH;
}

/**
 * The newest published firmware release to serve as `latest.*`: the newest
 * with a firmware image, or, before any release has one, the newest with a
 * single-port production build (`pickLatestAsset`). Drafts and prereleases
 * are never served. Passed over: firmware-v0.1, whose only image is named
 * `program`, and any release made by hand without an image.
 */
export function pickFirmwareRelease(
  releases: readonly GithubRelease[],
): { release: GithubRelease; asset: GithubAsset } | null {
  const published = publishedFirmware(releases);
  for (const pick of [pickFirmwareAsset, pickLatestAsset]) {
    for (const release of published) {
      const asset = pick(release);
      if (asset) return { release, asset };
    }
  }
  return null;
}

/** Published firmware releases (no drafts or prereleases), newest first. */
function publishedFirmware(releases: readonly GithubRelease[]): GithubRelease[] {
  return releases
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(FIRMWARE_TAG_PREFIX))
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
}

/**
 * The published firmware releases that say which protocol they speak, each
 * with its firmware image and its `firmware-info.json`, newest first. A
 * release without that file predates the compatibility handshake: its
 * firmware cannot tell an app which protocol it speaks, so no app recommends
 * it. A release without a firmware image (up to 0.14) has only single-port
 * builds, which no app on the control port reaches.
 */
export function describedReleases(
  releases: readonly GithubRelease[],
): { release: GithubRelease; asset: GithubAsset; info: GithubAsset }[] {
  const out: { release: GithubRelease; asset: GithubAsset; info: GithubAsset }[] = [];
  for (const release of publishedFirmware(releases)) {
    const asset = pickFirmwareAsset(release);
    const info = release.assets.find((a) => a.name === FIRMWARE_INFO_ASSET);
    if (asset && info) out.push({ release, asset, info });
  }
  return out;
}

/** The first of `candidates` for each protocol version; given newest first, the newest. */
export function newestPerProtocol<T extends { protocolVersion: number }>(candidates: readonly T[]): T[] {
  const seen = new Set<number>();
  return candidates.filter((c) => !seen.has(c.protocolVersion) && seen.add(c.protocolVersion));
}

export function isFirmwareInfo(value: unknown): value is FirmwareInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === 'string' && Number.isInteger(v.protocolVersion);
}

/** The path a release image is served at, relative to the hosting root. */
export function firmwareImagePath(assetName: string): string {
  return `firmware/${assetName}`;
}

/** The manifest for a picked release, once its image's digest is known. */
export function toManifest(release: GithubRelease, asset: GithubAsset, sha256: string): FirmwareReleaseManifest {
  return {
    tag: release.tag_name,
    version: release.tag_name.slice(FIRMWARE_TAG_PREFIX.length),
    assetName: asset.name,
    size: asset.size,
    sha256: sha256.toLowerCase(),
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
  };
}

/** The manifest entry for a release whose firmware speaks `protocolVersion`,
 *  its image served at `firmwareImagePath`. */
export function toManifestEntry(
  release: GithubRelease,
  asset: GithubAsset,
  sha256: string,
  protocolVersion: number,
): FirmwareManifestEntry {
  return { ...toManifest(release, asset, sha256), protocolVersion, path: firmwareImagePath(asset.name) };
}

/**
 * The firmware this app recommends: the newest listed release that speaks its
 * protocol, or null when no release does yet.
 */
export function recommendedRelease(
  manifest: FirmwareManifest,
  appProtocol: number,
): FirmwareManifestEntry | null {
  const matching = manifest.releases
    .filter((r) => r.protocolVersion === appProtocol)
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  return matching[0] ?? null;
}

function isManifest(value: unknown): value is FirmwareReleaseManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.tag === 'string' &&
    typeof m.version === 'string' &&
    typeof m.assetName === 'string' &&
    typeof m.size === 'number' &&
    typeof m.sha256 === 'string' &&
    typeof m.htmlUrl === 'string'
  );
}

function isManifestEntry(value: unknown): value is FirmwareManifestEntry {
  if (!isManifest(value)) return false;
  const m = value as unknown as Record<string, unknown>;
  return Number.isInteger(m.protocolVersion) && typeof m.path === 'string';
}

function isFirmwareManifest(value: unknown): value is FirmwareManifest {
  if (typeof value !== 'object' || value === null) return false;
  const releases = (value as Record<string, unknown>).releases;
  return Array.isArray(releases) && releases.every(isManifestEntry);
}

type FetchFn = (input: string) => Promise<Response>;

/**
 * Read the served list of releases per protocol. Throws with a message fit
 * for the screen when there is none — a build made offline, or a dev server
 * that could not reach GitHub.
 */
export async function fetchFirmwareManifest(
  baseUrl: string,
  fetchFn: FetchFn = (input) => fetch(input),
): Promise<FirmwareManifest> {
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}${FIRMWARE_MANIFEST_PATH}`);
  } catch {
    throw new Error('Could not reach the app server for the firmware releases.');
  }
  if (!res.ok) throw new Error('No firmware release is bundled with this copy of the app.');
  // try/catch rather than `.catch(() => null)`: @vitest/coverage-v8 5 counts
  // that inline callback as a function, and the firmware loader's coverage
  // gate requires every function to run.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: reported as malformed below */
  }
  if (!isFirmwareManifest(body)) throw new Error('The bundled firmware release description is malformed.');
  return body;
}

function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Download the served image and check it is the one the manifest describes.
 * A truncated or swapped file must never reach the flash.
 */
export async function fetchReleaseImage(
  baseUrl: string,
  manifest: FirmwareReleaseManifest,
  fetchFn: FetchFn = (input) => fetch(input),
): Promise<Uint8Array> {
  const res = await fetchFn(`${baseUrl}${imagePath(manifest)}`);
  if (!res.ok) throw new Error(`Downloading ${manifest.assetName} failed (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength !== manifest.size) {
    throw new Error(
      `Downloaded ${manifest.assetName} is ${bytes.byteLength.toLocaleString()} bytes, expected ${manifest.size.toLocaleString()}.`,
    );
  }
  const digest = toHex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== manifest.sha256) {
    throw new Error(`Downloaded ${manifest.assetName} does not match its release checksum.`);
  }
  return bytes;
}

/**
 * Fetch the recommended firmware once, so the service worker keeps a copy
 * (vite.config.ts) and an update still works offline. Never throws: a failure
 * only means nothing was cached this time.
 */
export async function cacheRecommendedRelease(
  baseUrl: string,
  appProtocol: number,
  fetchFn: FetchFn = (input) => fetch(input),
): Promise<FirmwareManifestEntry | null> {
  try {
    const entry = recommendedRelease(await fetchFirmwareManifest(baseUrl, fetchFn), appProtocol);
    if (entry) await fetchReleaseImage(baseUrl, entry, fetchFn);
    return entry;
  } catch {
    return null;
  }
}
