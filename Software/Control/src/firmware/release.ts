/**
 * The latest published firmware release, as the Firmware screen offers it.
 *
 * GitHub's release API answers cross-origin requests, but the asset bytes are
 * served from a host that sends no CORS header, so the browser cannot download
 * a release itself. The app's own origin serves it instead: the Vite plugin in
 * `tools/firmwareRelease.ts` proxies GitHub on the dev server and bundles the
 * files into a production build. Both serve the same two files under
 * `firmware/`, described by {@link FirmwareReleaseManifest}.
 *
 * The selection logic is shared with that plugin, so it stays free of DOM and
 * Node APIs alike.
 */

/** Tags that are firmware releases; the repo also tags app and hardware releases. */
export const FIRMWARE_TAG_PREFIX = 'firmware-v';

/** Where the manifest and image are served, relative to the app's base URL. */
export const RELEASE_MANIFEST_PATH = 'firmware/latest.json';
export const RELEASE_IMAGE_PATH = 'firmware/latest.bin';

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

/** What `firmware/latest.json` says about `firmware/latest.bin`. */
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
}

/**
 * The image to flash from a release: always the MadEdge build, the one made
 * for the MadEdge PCBA (`-madEdge.bin`). Releases from before that name carry
 * the same build as `-debug.bin`. A release without it offers nothing; its
 * single-port `-release.bin` is flashed as a local file when wanted.
 */
export function pickFirmwareAsset(release: GithubRelease): GithubAsset | null {
  return (
    release.assets.find((a) => /-madEdge\.bin$/i.test(a.name)) ??
    release.assets.find((a) => /-debug\.bin$/i.test(a.name)) ??
    null
  );
}

/**
 * The newest published firmware release that has an image to flash. Drafts
 * and prereleases are never offered: this is the default a user flashes
 * without looking further.
 */
export function pickFirmwareRelease(
  releases: readonly GithubRelease[],
): { release: GithubRelease; asset: GithubAsset } | null {
  const published = releases
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(FIRMWARE_TAG_PREFIX))
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  for (const release of published) {
    const asset = pickFirmwareAsset(release);
    if (asset) return { release, asset };
  }
  return null;
}

/** The manifest for a picked release, once its image's digest is known. */
export function toManifest(
  release: GithubRelease,
  asset: GithubAsset,
  sha256: string,
): FirmwareReleaseManifest {
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

type FetchFn = (input: string) => Promise<Response>;

/**
 * Read the served manifest. Throws with a message fit for the screen when
 * there is none — a build made offline, or a dev server that could not reach
 * GitHub.
 */
export async function fetchReleaseManifest(
  baseUrl: string,
  fetchFn: FetchFn = (input) => fetch(input),
): Promise<FirmwareReleaseManifest> {
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}${RELEASE_MANIFEST_PATH}`);
  } catch {
    throw new Error('Could not reach the app server for the latest release.');
  }
  if (!res.ok) throw new Error('No firmware release is bundled with this copy of the app.');
  const body: unknown = await res.json().catch(() => null);
  if (!isManifest(body)) throw new Error('The bundled firmware release description is malformed.');
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
  const res = await fetchFn(`${baseUrl}${RELEASE_IMAGE_PATH}`);
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
