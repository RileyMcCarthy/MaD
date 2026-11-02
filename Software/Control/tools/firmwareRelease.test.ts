import { describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { createHash } from 'node:crypto';
import {
  describeSite,
  fetchFirmwareSite,
  firmwareRelease,
  releasedProtocols,
  type FirmwareReleaseDeps,
} from './firmwareRelease';
import type { FirmwareManifest, GithubRelease } from '../src/firmware/release';

/* The plugin is driven the way Vite drives it: `configureServer` with a fake
 * server whose `middlewares.use` captures the handler, and `generateBundle`
 * with a fake Rollup context. `fetch` is stubbed per test; nothing touches the
 * network. */

const IMAGE = new Uint8Array([1, 2, 3, 4]);

const RELEASE: GithubRelease = {
  tag_name: 'firmware-v0.12',
  name: null,
  draft: false,
  prerelease: false,
  published_at: '2026-09-08T00:00:00Z',
  html_url: 'https://example.invalid/r',
  assets: [{ id: 7, name: 'MaD-Firmware-0.12-release.bin', size: IMAGE.byteLength }],
};

type Route = () => Response | Promise<Response>;
type AssetRoute = (id: number) => Response | Promise<Response>;

/** A fetch that answers the releases listing and the asset downloads (by
 *  asset id) from the given routes, recording every URL it was asked for. */
function github(routes: { list?: Route; asset?: AssetRoute }) {
  const list: Route = routes.list ?? (() => new Response(JSON.stringify([RELEASE])));
  const asset: AssetRoute = routes.asset ?? (() => new Response(IMAGE));
  const fn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    const id = /\/releases\/assets\/(\d+)$/.exec(url)?.[1];
    if (id !== undefined) return asset(Number(id));
    if (url.includes('/releases?')) return list();
    throw new Error(`unexpected fetch ${url}`);
  });
  return fn;
}

/** A published firmware release whose production image is asset `id` (bytes
 *  `[id]`), with a firmware-info.json (asset `id + 100`) when it speaks a protocol. */
function described(version: string, id: number, publishedAt: string, protocol: number | null): GithubRelease {
  return {
    ...RELEASE,
    tag_name: `firmware-v${version}`,
    published_at: publishedAt,
    assets: [
      { id, name: `MaD-Firmware-${version}-release.bin`, size: 1 },
      ...(protocol === null ? [] : [{ id: id + 100, name: 'firmware-info.json', size: info(version, protocol).length }]),
    ],
  };
}

const info = (version: string, protocol: number) => Buffer.from(JSON.stringify({ version, protocolVersion: protocol }));

function plugin(fetchFn: ReturnType<typeof github>, env: Record<string, string> = {}) {
  const deps: FirmwareReleaseDeps = { fetch: fetchFn as unknown as typeof fetch, env };
  return firmwareRelease(deps);
}

/** Runs `generateBundle` against a fake Rollup context. `error` throws, as
 *  Rollup's does, so a required-but-missing release aborts the hook. */
async function bundle(p: ReturnType<typeof firmwareRelease>) {
  const emitted: { fileName: string; source: unknown }[] = [];
  const warnings: string[] = [];
  const ctx = {
    emitFile: (f: { fileName: string; source: unknown }) => {
      emitted.push(f);
      return f.fileName;
    },
    info: () => undefined,
    warn: (m: string) => {
      warnings.push(m);
    },
    error: (m: string): never => {
      throw new Error(m);
    },
  };
  const hook = p.generateBundle as unknown as (this: typeof ctx) => Promise<void>;
  let error: Error | null = null;
  try {
    await hook.call(ctx);
  } catch (e) {
    error = e as Error;
  }
  return { emitted, warnings, error };
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  done: Promise<void>;
  setHeader(k: string, v: string): void;
  end(b?: unknown): void;
}

function fakeRes(): FakeRes {
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    done,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(b) {
      this.body = b;
      resolve();
    },
  };
}

type Handler = (req: { url?: string }, res: FakeRes, next: () => void) => void;

/** Runs `configureServer` and returns the dev middleware it registered (or
 *  null when it registered none), plus what it logged as warnings. */
function devServer(p: ReturnType<typeof firmwareRelease>) {
  let handler: Handler | null = null;
  const warnings: string[] = [];
  const server = {
    middlewares: {
      use: (h: Handler) => {
        handler = h;
      },
    },
    config: { logger: { warn: (m: string) => warnings.push(m) } },
  };
  (p.configureServer as unknown as (s: typeof server) => void)(server);
  const request = async (url: string) => {
    if (!handler) throw new Error('no middleware registered');
    const res = fakeRes();
    let passed = false;
    await new Promise<void>((resolve) => {
      handler!({ url }, res, () => {
        passed = true;
        resolve();
      });
      void res.done.then(resolve);
    });
    return { passed, res };
  };
  return { registered: () => handler !== null, request, warnings };
}

describe('firmwareRelease build', () => {
  behaviour(
    {
      id: 'firmware-release.failed-fetch-retried',
      covers: 'tools/firmwareRelease.ts#firmwareRelease',
      given: 'the build-time lookup of the latest firmware release fails once, then GitHub answers',
      expect: {
        'retried-not-cached': 'the next attempt asks GitHub again',
        'bundled-on-retry': 'the retry bundles the release description and image',
      },
      why: {
        'retried-not-cached':
          'a dev server lives for hours; one offline moment must not leave it serving nothing until restart',
      },
    },
    async () => {
      let calls = 0;
      const fetchFn = github({
        list: () => {
          calls += 1;
          if (calls === 1) throw new TypeError('fetch failed');
          return new Response(JSON.stringify([RELEASE]));
        },
      });
      const p = plugin(fetchFn);
      const first = await bundle(p);
      expect(first.emitted).toHaveLength(0);
      const second = await bundle(p);
      expect(calls).toBe(2);
      expect(second.emitted.map((f) => f.fileName)).toEqual([
        'firmware/latest.json',
        'firmware/latest.bin',
        'firmware/manifest.json',
      ]);
    },
  );

  behaviour(
    {
      id: 'firmware-release.size-mismatch-refused',
      covers: 'tools/firmwareRelease.ts#fetchFirmwareSite',
      given: 'a release image whose downloaded length differs from the size the release lists',
      expect: {
        'names-both-sizes': 'the image is refused with a message naming the size received and the size the release lists',
      },
    },
    async () => {
      const p = plugin(github({ asset: () => new Response(new Uint8Array([1, 2, 3])) }));
      const r = await bundle(p);
      expect(r.emitted).toHaveLength(0);
      expect(r.warnings.join('\n')).toMatch(/got 3 bytes, release says 4/);
    },
  );

  behaviour(
    {
      id: 'firmware-release.listing-http-error',
      covers: 'tools/firmwareRelease.ts#fetchFirmwareSite',
      given: "GitHub answers the build's request for the repository's releases with an error status",
      expect: { 'names-status': 'the lookup fails naming the HTTP status' },
    },
    async () => {
      const p = plugin(github({ list: () => new Response('rate limited', { status: 403 }) }));
      const r = await bundle(p);
      expect(r.warnings.join('\n')).toMatch(/listing releases of RileyMcCarthy\/MaD: HTTP 403/);
    },
  );

  behaviour(
    {
      id: 'firmware-release.asset-http-error',
      covers: 'tools/firmwareRelease.ts#fetchFirmwareSite',
      given: 'GitHub answers the download of the chosen release image with an error status',
      expect: { 'names-status': 'the lookup fails naming the image and the HTTP status' },
    },
    async () => {
      const p = plugin(github({ asset: () => new Response('gone', { status: 404 }) }));
      const r = await bundle(p);
      expect(r.warnings.join('\n')).toMatch(/downloading MaD-Firmware-0\.12-release\.bin: HTTP 404/);
    },
  );

  behaviour(
    {
      id: 'firmware-release.required-fails-build',
      covers: 'tools/firmwareRelease.ts#firmwareRelease',
      given: 'a build that requires a bundled firmware release, and no release can be fetched',
      expect: {
        'build-error': 'the build fails with an error saying no firmware release could be bundled',
        'nothing-emitted': 'no release description or image is emitted',
      },
      why: {
        'build-error':
          'the published app is what operators flash from; shipping it silently without the default firmware is worse than a red build',
      },
    },
    async () => {
      const p = plugin(github({ list: () => new Response('', { status: 500 }) }), {
        MAD_FIRMWARE_RELEASE_REQUIRED: '1',
      });
      const r = await bundle(p);
      expect(r.error?.message).toMatch(/no firmware release to bundle: .*HTTP 500/);
      expect(r.emitted).toHaveLength(0);
    },
  );

  behaviour(
    {
      id: 'firmware-release.optional-only-warns',
      covers: 'tools/firmwareRelease.ts#firmwareRelease',
      given: 'a build that does not require a bundled firmware release, and no release can be fetched',
      expect: {
        'build-continues': 'the build carries on without failing',
        'warns-local-only': 'a warning says the Firmware screen will offer local files only',
      },
    },
    async () => {
      const p = plugin(github({ list: () => new Response('', { status: 500 }) }));
      const r = await bundle(p);
      expect(r.error).toBeNull();
      expect(r.warnings.join('\n')).toMatch(/local files only/);
    },
  );

  behaviour(
    {
      id: 'firmware-release.off-bundles-nothing',
      covers: 'tools/firmwareRelease.ts#firmwareRelease',
      given: 'a build with the firmware release switched off',
      expect: {
        'nothing-emitted': 'no release description or image is emitted and GitHub is never asked',
      },
    },
    async () => {
      const fetchFn = github({});
      const r = await bundle(plugin(fetchFn, { MAD_FIRMWARE_RELEASE: 'off' }));
      expect(r.emitted).toHaveLength(0);
      expect(r.error).toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
});

describe('fetchFirmwareSite', () => {
  behaviour(
    {
      id: 'firmware-release.site-newest-per-protocol',
      covers: 'tools/firmwareRelease.ts#fetchFirmwareSite',
      given:
        'releases 0.16 speaking protocol 3, 0.15 and 0.14 speaking protocol 2, and 0.13 from before releases said which protocol they speak',
      expect: {
        'listed-per-protocol': 'the list of releases names 0.16 for protocol 3 and 0.15 for protocol 2, each with its checksum',
        'images-beside': 'the images of 0.16 and 0.15 are served under their own file names',
        'older-not-downloaded': "0.14's image is never downloaded",
        'latest-kept': 'the newest release, 0.16, is still served as the latest release for older apps',
      },
    },
    async () => {
      const releases = [
        described('0.13', 1, '2026-10-01T00:00:00Z', null),
        described('0.14', 2, '2026-10-20T00:00:00Z', 2),
        described('0.16', 4, '2026-11-20T00:00:00Z', 3),
        described('0.15', 3, '2026-11-10T00:00:00Z', 2),
      ];
      const infos: Record<number, Buffer> = { 102: info('0.14', 2), 103: info('0.15', 2), 104: info('0.16', 3) };
      const asked: number[] = [];
      const fetchFn = github({
        list: () => new Response(JSON.stringify(releases)),
        asset: (id) => {
          asked.push(id);
          return new Response(infos[id] ?? new Uint8Array([id]));
        },
      });
      const site = await fetchFirmwareSite(fetchFn as unknown as typeof fetch, {});
      const sha = (b: number) => createHash('sha256').update(Buffer.from([b])).digest('hex');
      expect(site.manifest.releases.map((r) => [r.tag, r.protocolVersion, r.sha256])).toEqual([
        ['firmware-v0.16', 3, sha(4)],
        ['firmware-v0.15', 2, sha(3)],
      ]);
      expect([...site.files.get('firmware/MaD-Firmware-0.16-release.bin')!]).toEqual([4]);
      expect([...site.files.get('firmware/MaD-Firmware-0.15-release.bin')!]).toEqual([3]);
      expect(asked).not.toContain(2);
      expect(site.latest.tag).toBe('firmware-v0.16');
      expect(JSON.parse(site.files.get('firmware/manifest.json')!.toString())).toEqual(site.manifest);
      expect(describeSite(site)).toContain('firmware-v0.15 (protocol 2)');
    },
  );

  behaviour(
    {
      id: 'firmware-release.site-none-described',
      covers: 'tools/firmwareRelease.ts#fetchFirmwareSite',
      given: 'releases that all come from before releases said which protocol they speak',
      expect: {
        'empty-list': 'the list of releases per protocol is served empty',
        'latest-kept': 'the newest release is still served as the latest release',
      },
    },
    async () => {
      const site = await fetchFirmwareSite(github({}) as unknown as typeof fetch, {});
      expect(site.manifest).toEqual({ releases: [] });
      expect(site.latest.tag).toBe('firmware-v0.12');
      expect(describeSite(site)).toContain('none yet');
    },
  );

  behaviour(
    {
      id: 'firmware-release.site-malformed-info',
      covers: 'tools/firmwareRelease.ts#fetchFirmwareSite',
      given: "a release whose file saying which protocol it speaks is not JSON, or has no protocol version",
      expect: { 'names-release': 'the lookup fails naming the release and the malformed file' },
    },
    async () => {
      for (const body of ['not json', JSON.stringify({ version: '0.14' })]) {
        const release = described('0.14', 2, '2026-10-20T00:00:00Z', 2);
        release.assets[1].size = body.length;
        const fetchFn = github({
          list: () => new Response(JSON.stringify([release])),
          asset: (id) => new Response(id === 102 ? body : new Uint8Array([id])),
        });
        await expect(fetchFirmwareSite(fetchFn as unknown as typeof fetch, {})).rejects.toThrow(
          'firmware-v0.14: firmware-info.json is malformed',
        );
      }
    },
  );

  behaviour(
    {
      id: 'firmware-release.site-info-http-error',
      covers: 'tools/firmwareRelease.ts#fetchFirmwareSite',
      given: "GitHub answers the download of a release's protocol file with an error status",
      expect: { 'names-status': 'the lookup fails naming the file and the HTTP status' },
    },
    async () => {
      const fetchFn = github({
        list: () => new Response(JSON.stringify([described('0.14', 2, '2026-10-20T00:00:00Z', 2)])),
        asset: (id) => (id === 102 ? new Response('', { status: 502 }) : new Response(new Uint8Array([id]))),
      });
      await expect(fetchFirmwareSite(fetchFn as unknown as typeof fetch, {})).rejects.toThrow(
        'downloading firmware-info.json: HTTP 502',
      );
    },
  );
});

describe('releasedProtocols', () => {
  behaviour(
    {
      id: 'firmware-release.protocols-without-images',
      covers: 'tools/firmwareRelease.ts#releasedProtocols',
      given: 'releases 0.15 and 0.14 speaking protocol 2, and 0.13 from before releases said which protocol they speak',
      expect: {
        'newest-per-protocol': 'protocol 2 is reported as spoken by 0.15, its newest release',
        'no-image-downloaded': 'no firmware image is downloaded to find out',
      },
    },
    async () => {
      const releases = [
        described('0.13', 1, '2026-10-01T00:00:00Z', null),
        described('0.14', 2, '2026-10-20T00:00:00Z', 2),
        described('0.15', 3, '2026-11-10T00:00:00Z', 2),
      ];
      const infos: Record<number, Buffer> = { 102: info('0.14', 2), 103: info('0.15', 2) };
      const asked: number[] = [];
      const fetchFn = github({
        list: () => new Response(JSON.stringify(releases)),
        asset: (id) => {
          asked.push(id);
          return new Response(infos[id] ?? new Uint8Array([id]));
        },
      });
      expect(await releasedProtocols(fetchFn as unknown as typeof fetch, {})).toEqual([
        { tag: 'firmware-v0.15', protocolVersion: 2 },
      ]);
      expect(asked.every((id) => id > 100)).toBe(true);
    },
  );
});

describe('firmwareRelease dev server', () => {
  behaviour(
    {
      id: 'firmware-release.dev-off-serves-nothing',
      covers: 'tools/firmwareRelease.ts#firmwareRelease',
      given: 'the dev server with the firmware release switched off',
      expect: {
        'no-route': 'no firmware route is added, so requests for the release fall through to the rest of the app',
      },
    },
    () => {
      const dev = devServer(plugin(github({}), { MAD_FIRMWARE_RELEASE: 'off' }));
      expect(dev.registered()).toBe(false);
    },
  );

  behaviour(
    {
      id: 'firmware-release.dev-serves-release',
      covers: 'tools/firmwareRelease.ts#firmwareRelease',
      given: "the dev server asked for the release description and the release image under the app's sub-path, with a query string",
      expect: {
        'description-served': 'the release description is answered as JSON describing the latest release',
        'image-served': 'the image is answered byte for byte as downloaded',
        'not-cached-by-browser': 'both answers tell the browser not to cache them',
      },
    },
    async () => {
      const dev = devServer(plugin(github({})));
      const m = await dev.request('/MaD/app/firmware/latest.json?t=1');
      expect(m.passed).toBe(false);
      expect(m.res.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(String(m.res.body)).tag).toBe('firmware-v0.12');
      const i = await dev.request('/MaD/app/firmware/latest.bin?t=1');
      expect(i.res.headers['Content-Type']).toBe('application/octet-stream');
      expect([...(i.res.body as Buffer)]).toEqual([...IMAGE]);
      expect([m.res.headers['Cache-Control'], i.res.headers['Cache-Control']]).toEqual(['no-store', 'no-store']);
    },
  );

  behaviour(
    {
      id: 'firmware-release.dev-other-paths-pass',
      covers: 'tools/firmwareRelease.ts#firmwareRelease',
      given: 'the dev server asked for paths that are not firmware release files',
      expect: {
        'passed-through': 'each request outside the firmware folder is handed on to the rest of the app and GitHub is never asked',
        'unknown-file-passed': 'a firmware-folder file that no release provides is handed on to the rest of the app',
      },
    },
    async () => {
      const fetchFn = github({});
      const dev = devServer(plugin(fetchFn));
      for (const url of ['/', '/firmware/latest.json.map', '/index.html?x=firmware/latest.json']) {
        expect((await dev.request(url)).passed).toBe(true);
      }
      expect(fetchFn).not.toHaveBeenCalled();
      expect((await dev.request('/firmware/other.bin')).passed).toBe(true);
    },
  );

  behaviour(
    {
      id: 'firmware-release.dev-serves-per-protocol',
      covers: 'tools/firmwareRelease.ts#firmwareRelease',
      given: 'the dev server asked for the list of releases per protocol and a listed image, with a release that speaks protocol 2',
      expect: {
        'manifest-served': 'the list is answered as JSON naming that release and its protocol',
        'image-served': "the listed image is answered under its own file name, byte for byte",
      },
    },
    async () => {
      const release = described('0.14', 5, '2026-11-01T00:00:00Z', 2);
      const fetchFn = github({
        list: () => new Response(JSON.stringify([release])),
        asset: (id) => new Response(id === 105 ? info('0.14', 2) : new Uint8Array([id])),
      });
      const dev = devServer(plugin(fetchFn));
      const m = await dev.request('/MaD/app/firmware/manifest.json');
      expect(m.res.headers['Content-Type']).toBe('application/json');
      const manifest = JSON.parse(String(m.res.body)) as FirmwareManifest;
      expect(manifest.releases.map((r) => [r.tag, r.protocolVersion])).toEqual([['firmware-v0.14', 2]]);
      const i = await dev.request(`/MaD/app/${manifest.releases[0].path}`);
      expect([...(i.res.body as Buffer)]).toEqual([5]);
    },
  );

  behaviour(
    {
      id: 'firmware-release.dev-failure-503',
      covers: 'tools/firmwareRelease.ts#firmwareRelease',
      given: 'the dev server asked for the release description while GitHub cannot be reached',
      expect: {
        unavailable: 'the request is answered as service unavailable',
        'warns-reason': 'the dev server logs a warning carrying the reason',
      },
    },
    async () => {
      const dev = devServer(
        plugin(
          github({
            list: () => {
              throw new TypeError('fetch failed');
            },
          }),
        ),
      );
      const r = await dev.request('/firmware/latest.json');
      expect(r.res.statusCode).toBe(503);
      expect(dev.warnings.join('\n')).toMatch(/\[firmware-release\].*fetch failed/);
    },
  );
});
