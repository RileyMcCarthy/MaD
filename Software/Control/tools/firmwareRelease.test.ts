import { describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { firmwareRelease, type FirmwareReleaseDeps } from './firmwareRelease';
import type { GithubRelease } from '../src/firmware/release';

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
  assets: [{ id: 7, name: 'MaD-Firmware-0.12-madEdge.bin', size: IMAGE.byteLength }],
};

type Route = () => Response | Promise<Response>;

/** A fetch that answers the releases listing and the asset download from the
 *  given routes, recording every URL it was asked for. */
function github(routes: { list?: Route; asset?: Route }) {
  const list: Route = routes.list ?? (() => new Response(JSON.stringify([RELEASE])));
  const asset: Route = routes.asset ?? (() => new Response(IMAGE));
  const fn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('/releases/assets/')) return asset();
    if (url.includes('/releases?')) return list();
    throw new Error(`unexpected fetch ${url}`);
  });
  return fn;
}

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
    handler({ url }, res, () => {
      passed = true;
    });
    if (!passed) await res.done;
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
        'retried-not-cached': 'the next attempt asks GitHub again instead of reusing the failure',
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
      expect(second.emitted.map((f) => f.fileName)).toEqual(['firmware/latest.json', 'firmware/latest.bin']);
    },
  );

  behaviour(
    {
      id: 'firmware-release.size-mismatch-refused',
      covers: 'tools/firmwareRelease.ts#fetchLatestFirmware',
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
      covers: 'tools/firmwareRelease.ts#fetchLatestFirmware',
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
      covers: 'tools/firmwareRelease.ts#fetchLatestFirmware',
      given: 'GitHub answers the download of the chosen release image with an error status',
      expect: { 'names-status': 'the lookup fails naming the image and the HTTP status' },
    },
    async () => {
      const p = plugin(github({ asset: () => new Response('gone', { status: 404 }) }));
      const r = await bundle(p);
      expect(r.warnings.join('\n')).toMatch(/downloading MaD-Firmware-0\.12-madEdge\.bin: HTTP 404/);
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
      given: 'the dev server asked for paths that are not the release description or image',
      expect: {
        'passed-through': 'each request is handed on to the rest of the app and GitHub is never asked',
      },
    },
    async () => {
      const fetchFn = github({});
      const dev = devServer(plugin(fetchFn));
      for (const url of ['/', '/firmware/latest.json.map', '/firmware/other.bin', '/index.html?x=firmware/latest.json']) {
        expect((await dev.request(url)).passed).toBe(true);
      }
      expect(fetchFn).not.toHaveBeenCalled();
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
