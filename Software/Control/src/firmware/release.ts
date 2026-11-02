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
 *    protocol version, with each board's image beside it under its own file
 *    name. An app offers the one that speaks its own protocol, for the board
 *    chosen: the recommended firmware.
 *  - `latest.json` + `latest.bin` (+ `latest-MaDEdge.bin`): the newest release
 *    of all, read by app versions from before the manifest.
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
 * The boards a firmware build targets, named after its PlatformIO env.
 *  - P2Eval: the production build. The protocol runs on P62/P63 (the debug
 *    header J1) at 2,000,000 baud, the port the app also programs through.
 *  - MaDEdge: the debug build. The protocol moves to the Edge carrier's Pi
 *    link and J1 carries a debug log instead.
 */
export const BOARDS = ['P2Eval', 'MaDEdge'] as const;
export type Board = (typeof BOARDS)[number];

/**
 * Release asset suffixes per board, newest first. Releases up to 0.14 predate
 * the board names: the P2Eval build was `-release.bin`, the MaDEdge build
 * `-madEdge.bin` (`-debug.bin` before 0.13).
 */
const BOARD_ASSET_SUFFIXES: Record<Board, readonly string[]> = {
  P2Eval: ['P2Eval', 'release'],
  MaDEdge: ['MaDEdge', 'madEdge', 'debug'],
};

/** Where each board's image is served. P2Eval keeps the original path, which
 *  every deployed app version reads. */
export const BOARD_IMAGE_PATHS: Record<Board, string> = {
  P2Eval: RELEASE_IMAGE_PATH,
  MaDEdge: 'firmware/latest-MaDEdge.bin',
};

/** The board a release image was built for, from its file name. */
export function boardOfAsset(assetName: string): Board | null {
  for (const board of BOARDS) {
    for (const suffix of BOARD_ASSET_SUFFIXES[board]) {
      if (assetName.endsWith(`-${suffix}.bin`)) return board;
    }
  }
  return null;
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

/** One served image: the release asset it came from, and how to check it. */
export interface BoardImage {
  assetName: string;
  size: number;
  /** Lowercase hex SHA-256 of the image, checked before anything is written. */
  sha256: string;
  /** Where the image is served, relative to the hosting root; the board's
   *  `latest` path (BOARD_IMAGE_PATHS) when absent. */
  path?: string;
}

/**
 * What `firmware/latest.json` says about the served images. The top-level
 * image fields describe `firmware/latest.bin`, the P2Eval build; `boards`
 * lists every board's image, and is absent from manifests written before
 * the board choice existed.
 */
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
  boards?: Partial<Record<Board, BoardImage>>;
  /** Where the P2Eval image is served, relative to the hosting root;
   *  `firmware/latest.bin` when absent. */
  path?: string;
}

/** What a release's `firmware-info.json` says. */
export interface FirmwareInfo {
  version: string;
  protocolVersion: number;
}

/** One release in `firmware/manifest.json`: every board image it has, each
 *  served under its own file name. */
export interface FirmwareManifestEntry extends FirmwareReleaseManifest {
  /** The protocol version the release's firmware speaks. */
  protocolVersion: number;
  path: string;
}

/** `firmware/manifest.json`: the newest release for each protocol version. */
export interface FirmwareManifest {
  releases: FirmwareManifestEntry[];
}

/**
 * A release's image for one board; the P2Eval build unless asked otherwise.
 * The app flashes P2Eval by default because it answers on the port the app
 * programs through; the MaDEdge build moves the protocol to the Edge
 * carrier's Pi link, so the app reaches it only over that link.
 */
export function pickFirmwareAsset(release: GithubRelease, board: Board = 'P2Eval'): GithubAsset | null {
  return release.assets.find((a) => boardOfAsset(a.name) === board) ?? null;
}

/** How the Firmware screen names a release image. */
export function releaseImageLabel(assetName: string): string {
  const board = boardOfAsset(assetName);
  if (board === 'P2Eval') return 'P2Eval production build';
  if (board === 'MaDEdge') return 'MaDEdge debug build';
  return assetName;
}

/** A served board image, with the path to fetch it from; null when the
 *  release has none for that board. */
export function boardImage(
  manifest: FirmwareReleaseManifest,
  board: Board,
): (BoardImage & { path: string }) | null {
  const listed = manifest.boards?.[board];
  if (listed) return { ...listed, path: listed.path ?? BOARD_IMAGE_PATHS[board] };
  // A manifest from before the board choice describes only the P2Eval image.
  if (board === 'P2Eval') {
    return {
      assetName: manifest.assetName,
      size: manifest.size,
      sha256: manifest.sha256,
      path: manifest.path ?? RELEASE_IMAGE_PATH,
    };
  }
  return null;
}

/**
 * The newest published firmware release that has an image to flash. Drafts
 * and prereleases are never offered: this is the default a user flashes
 * without looking further. Every release from 0.11 on carries a production
 * build, and the release job cannot publish one without it. The ones passed
 * over are firmware-v0.1, whose only image is named `program`, and any
 * release made by hand without one. firmware-v0.11 is offered only if 0.12
 * and 0.13 are gone; its build runs at 230,400 baud, so the app would not
 * reach it at the 2,000,000 it reconnects at.
 */
export function pickFirmwareRelease(
  releases: readonly GithubRelease[],
): { release: GithubRelease; asset: GithubAsset } | null {
  for (const release of publishedFirmware(releases)) {
    const asset = pickFirmwareAsset(release);
    if (asset) return { release, asset };
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
 * with its P2Eval image (the one every release has) and its
 * `firmware-info.json`, newest first. A release without that file predates
 * the compatibility handshake: its firmware cannot tell an app which protocol
 * it speaks, so no app recommends it.
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

/** The manifest for a picked release, once its images' digests are known.
 *  `boards` lists every served board image, the P2Eval one included. */
export function toManifest(
  release: GithubRelease,
  asset: GithubAsset,
  sha256: string,
  boards?: Partial<Record<Board, BoardImage>>,
): FirmwareReleaseManifest {
  return {
    ...(boards ? { boards } : {}),
    tag: release.tag_name,
    version: release.tag_name.slice(FIRMWARE_TAG_PREFIX.length),
    assetName: asset.name,
    size: asset.size,
    sha256: sha256.toLowerCase(),
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
  };
}

/**
 * The manifest entry for a release whose firmware speaks `protocolVersion`.
 * `boards` lists each board image it has, each with the path it is served at
 * (`firmwareImagePath`); the top-level fields describe its P2Eval image.
 */
export function toManifestEntry(
  release: GithubRelease,
  asset: GithubAsset,
  sha256: string,
  protocolVersion: number,
  boards?: Partial<Record<Board, BoardImage>>,
): FirmwareManifestEntry {
  return { ...toManifest(release, asset, sha256, boards), protocolVersion, path: firmwareImagePath(asset.name) };
}

/**
 * The firmware this app recommends: the newest listed release that speaks its
 * protocol, or null when no release does yet. Which board's image to flash is
 * the Firmware screen's Board choice (`boardImage`).
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

function isBoardImage(value: unknown): value is BoardImage {
  if (typeof value !== 'object' || value === null) return false;
  const i = value as Record<string, unknown>;
  return (
    typeof i.assetName === 'string' &&
    typeof i.size === 'number' &&
    typeof i.sha256 === 'string' &&
    (i.path === undefined || typeof i.path === 'string')
  );
}

function isManifest(value: unknown): value is FirmwareReleaseManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.boards !== undefined) {
    if (typeof m.boards !== 'object' || m.boards === null) return false;
    const boards = m.boards as Record<string, unknown>;
    if (!BOARDS.every((b) => boards[b] === undefined || isBoardImage(boards[b]))) return false;
  }
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
 * Download one board's served image and check it is the one the manifest
 * describes. A truncated or swapped file must never reach the flash.
 */
export async function fetchReleaseImage(
  baseUrl: string,
  manifest: FirmwareReleaseManifest,
  fetchFn: FetchFn = (input) => fetch(input),
  board: Board = 'P2Eval',
): Promise<Uint8Array> {
  const image = boardImage(manifest, board);
  if (!image) throw new Error(`Firmware ${manifest.version} has no ${board} build.`);
  const res = await fetchFn(`${baseUrl}${image.path}`);
  if (!res.ok) throw new Error(`Downloading ${image.assetName} failed (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength !== image.size) {
    throw new Error(
      `Downloaded ${image.assetName} is ${bytes.byteLength.toLocaleString()} bytes, expected ${image.size.toLocaleString()}.`,
    );
  }
  const digest = toHex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== image.sha256) {
    throw new Error(`Downloaded ${image.assetName} does not match its release checksum.`);
  }
  return bytes;
}

/**
 * Fetch the recommended firmware for `board` once, so the service worker
 * keeps a copy (vite.config.ts) and an update still works offline. Never
 * throws: a failure only means nothing was cached this time.
 */
export async function cacheRecommendedRelease(
  baseUrl: string,
  appProtocol: number,
  fetchFn: FetchFn = (input) => fetch(input),
  board: Board = 'P2Eval',
): Promise<FirmwareManifestEntry | null> {
  try {
    const entry = recommendedRelease(await fetchFirmwareManifest(baseUrl, fetchFn), appProtocol);
    if (entry && boardImage(entry, board)) await fetchReleaseImage(baseUrl, entry, fetchFn, board);
    return entry;
  } catch {
    return null;
  }
}
