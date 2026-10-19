/**
 * Assemble the public site's /app/ folder from the released MaD Control builds.
 *
 *   site/app/v<version>/      each release, unpacked from its mad-control-v<version>.zip
 *   site/app/versions.json    { latest, versions: [{ version, publishedAt }] }, newest first
 *   site/app/index.html       redirects to the latest release, keeping the route
 *   site/app/firmware/        the latest firmware release, shared by every version
 *   site/app/sw.js            removes the service worker of the old unversioned app
 *
 * Each release is built once, when it is tagged (pages.yml), so merging to main
 * changes no published app; a deploy only re-assembles what was released.
 *
 *   OUT=site/app GITHUB_TOKEN=… vite-node tools/assemble-pages-app.mts
 *   OUT=/tmp/app ZIP_DIR=/tmp/zips vite-node tools/assemble-pages-app.mts   # local dry run
 *
 * With ZIP_DIR the releases are read from mad-control-v*.zip files in that
 * folder instead of GitHub. Fails when there is no release to publish, so a
 * deploy never replaces the site with an empty app folder.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchLatestFirmware, type Bundled } from './firmwareRelease';
import { RELEASE_IMAGE_PATH, RELEASE_MANIFEST_PATH } from '../src/firmware/release';

const REPO = process.env.MAD_REPO || 'RileyMcCarthy/MaD';
const TAG_PREFIX = 'madcontrol-v';

export interface Release {
  version: string;
  publishedAt: string | null;
  zip: string;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** Newest first, by version number. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)?.slice(1, 4).map(Number) ?? [0, 0, 0];
  const pb = SEMVER.exec(b)?.slice(1, 4).map(Number) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
}

function headers(accept: string): Record<string, string> {
  const h: Record<string, string> = { Accept: accept, 'User-Agent': 'mad-pages-assemble' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function releasesFromGithub(work: string): Promise<Release[]> {
  const api = `https://api.github.com/repos/${REPO}`;
  const res = await fetch(`${api}/releases?per_page=100`, { headers: headers('application/vnd.github+json') });
  if (!res.ok) throw new Error(`listing releases of ${REPO}: HTTP ${res.status}`);
  const all = (await res.json()) as {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
    assets: { id: number; name: string }[];
  }[];
  const out: Release[] = [];
  for (const r of all) {
    if (r.draft || r.prerelease || !r.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = r.tag_name.slice(TAG_PREFIX.length);
    // Releases from before versioned hosting carry no build; they are skipped.
    const asset = r.assets.find((a) => a.name === `mad-control-v${version}.zip`);
    if (!asset) continue;
    const dl = await fetch(`${api}/releases/assets/${asset.id}`, { headers: headers('application/octet-stream') });
    if (!dl.ok) throw new Error(`downloading ${asset.name}: HTTP ${dl.status}`);
    const zip = join(work, asset.name);
    writeFileSync(zip, Buffer.from(await dl.arrayBuffer()));
    out.push({ version, publishedAt: r.published_at, zip });
  }
  return out;
}

export function releasesFromDir(dir: string): Release[] {
  return readdirSync(dir)
    .map((name) => /^mad-control-v(.+)\.zip$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      version: m[1],
      publishedAt: statSync(join(dir, m[0])).mtime.toISOString(),
      zip: join(dir, m[0]),
    }));
}

/** The /app/ entry page: straight on to the latest release, same route and query. */
export function redirectPage(latest: string): string {
  const target = `v${latest}/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MaD Control</title>
<script>location.replace(${JSON.stringify(target)} + location.search + location.hash);</script>
<noscript><meta http-equiv="refresh" content="0; url=${target}"></noscript>
</head>
<body style="background:#0f1115;color:#c9d1d9;font-family:system-ui,sans-serif">
<p>Opening MaD Control ${latest}… <a href="${target}" style="color:#4ea1ff">continue</a></p>
</body>
</html>
`;
}

/**
 * The unversioned app registered a service worker at /app/sw.js whose scope
 * covers every /app/v…/ page and would keep serving the old app. A changed
 * sw.js at that address replaces it on the next visit; this one removes itself
 * and reloads the pages it controlled, so they reach the versioned site.
 */
export const RETIRE_SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Only the old app's caches: Workbox names them after this worker's scope,
    // and each release's own worker uses its own folder's scope.
    for (const key of await caches.keys()) {
      if (key.endsWith(self.registration.scope)) await caches.delete(key);
    }
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
`;

export const EMPTY_APP_REFUSAL =
  'no MaD Control release carries a mad-control-v*.zip build; refusing to publish an empty app';

/** What one assembly reads from the outside world. The CLI below passes GitHub
 *  (or ZIP_DIR) and the real firmware lookup; tests pass a temp folder and a stub. */
export interface AssembleOptions {
  /** The folder to (re)create as the site's /app/. */
  out: string;
  /** The releases to publish; given a scratch folder to download into. */
  listReleases: (work: string) => Release[] | Promise<Release[]>;
  /** The firmware release served at /app/firmware/ for every version. */
  fetchFirmware: () => Promise<Bundled>;
  log?: (line: string) => void;
}

/** Builds `out` from the releases. Throws before touching `out` when there is
 *  no release, so a failed deploy leaves the previous folder in place. */
export async function assemble(opts: AssembleOptions): Promise<void> {
  const { out } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const work = join(tmpdir(), `mad-pages-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const releases = [...(await opts.listReleases(work))];
    if (releases.length === 0) throw new Error(EMPTY_APP_REFUSAL);
    releases.sort((a, b) => compareVersions(a.version, b.version));

    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const r of releases) {
      const dir = join(out, `v${r.version}`);
      mkdirSync(dir, { recursive: true });
      execFileSync('unzip', ['-q', r.zip, '-d', dir]);
      log(`[assemble] v${r.version} ← ${r.zip}`);
    }

    const latest = releases[0].version;
    writeFileSync(
      join(out, 'versions.json'),
      JSON.stringify({ latest, versions: releases.map((r) => ({ version: r.version, publishedAt: r.publishedAt })) }, null, 2),
    );
    writeFileSync(join(out, 'index.html'), redirectPage(latest));
    writeFileSync(join(out, 'sw.js'), RETIRE_SW);

    const { manifest, image } = await opts.fetchFirmware();
    mkdirSync(join(out, 'firmware'), { recursive: true });
    writeFileSync(join(out, RELEASE_MANIFEST_PATH), JSON.stringify(manifest));
    writeFileSync(join(out, RELEASE_IMAGE_PATH), image);
    log(`[assemble] latest app v${latest}; firmware ${manifest.tag} (${manifest.assetName})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const zipDir = process.env.ZIP_DIR;
  await assemble({
    out: resolve(process.env.OUT ?? 'site/app'),
    listReleases: (work) => (zipDir ? releasesFromDir(resolve(zipDir)) : releasesFromGithub(work)),
    fetchFirmware: () => fetchLatestFirmware(fetch, process.env),
  });
}

// pages.yml runs this file directly (and redeploys when it changes), so the
// assembler and its CLI stay in one module. vite-node does not pass the script
// path in process.argv, so "run unless a test imported it" is told by VITEST,
// which vitest sets in its workers.
if (!process.env.VITEST) {
  main().catch((err: unknown) => {
    console.error(`[assemble] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
