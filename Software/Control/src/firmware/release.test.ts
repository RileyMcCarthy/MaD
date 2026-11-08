import { afterEach, describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  cacheRecommendedRelease,
  describedReleases,
  fetchFirmwareManifest,
  fetchReleaseImage,
  isFirmwareInfo,
  newestPerProtocol,
  pickFirmwareAsset,
  pickFirmwareRelease,
  recommendedRelease,
  toManifest,
  toManifestEntry,
  type FirmwareManifestEntry,
  type FirmwareReleaseManifest,
  type GithubRelease,
} from './release';

const release = (over: Partial<GithubRelease>): GithubRelease => ({
  tag_name: 'firmware-v0.1',
  name: null,
  draft: false,
  prerelease: false,
  published_at: '2026-01-01T00:00:00Z',
  html_url: 'https://example.invalid/r',
  assets: [{ id: 1, name: 'MaD-Firmware-0.1.bin', size: 4 }],
  ...over,
});

const IMAGE = new Uint8Array([1, 2, 3, 4]);
/** SHA-256 of the four bytes 01 02 03 04. */
const IMAGE_SHA256 = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';

const manifest = (over: Partial<FirmwareReleaseManifest> = {}): FirmwareReleaseManifest => ({
  tag: 'firmware-v0.1',
  version: '0.1',
  assetName: 'MaD-Firmware-0.1-release.bin',
  size: IMAGE.byteLength,
  sha256: IMAGE_SHA256,
  publishedAt: null,
  htmlUrl: 'https://example.invalid/r',
  ...over,
});

const entry = (over: Partial<FirmwareManifestEntry> = {}): FirmwareManifestEntry => ({
  ...manifest(),
  protocolVersion: 2,
  path: 'firmware/MaD-Firmware-0.1-release.bin',
  ...over,
});

const serve = (body: BodyInit, status = 200) => async () => new Response(body, { status });

/** A release carrying a firmware image and, unless `described` is false, its firmware-info.json. */
const firmware = (tag: string, publishedAt: string, described = true): GithubRelease =>
  release({
    tag_name: tag,
    published_at: publishedAt,
    assets: [
      { id: 1, name: `MaD-Firmware-${tag.slice('firmware-v'.length)}.bin`, size: 4 },
      ...(described ? [{ id: 2, name: 'firmware-info.json', size: 40 }] : []),
    ],
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pickFirmwareRelease', () => {
  behaviour(
    {
      id: 'flash.release-newest-firmware-tag',
      covers: 'src/firmware/release.ts#pickFirmwareRelease',
      given:
        'a repository whose releases are, newest first, an app release, a draft firmware release, a firmware prerelease and two published firmware releases',
      expect: {
        'newest-published-firmware':
          'the offered release is the most recently published firmware release that is neither a draft nor a prerelease',
      },
    },
    () => {
      const picked = pickFirmwareRelease([
        release({ tag_name: 'firmware-v0.11', published_at: '2025-06-28T00:00:00Z' }),
        release({ tag_name: 'madcontrol-v0.3.1', published_at: '2026-09-15T00:00:00Z' }),
        release({ tag_name: 'firmware-v0.14', draft: true, published_at: '2026-09-14T00:00:00Z' }),
        release({ tag_name: 'firmware-v0.13', prerelease: true, published_at: '2026-09-13T00:00:00Z' }),
        release({ tag_name: 'firmware-v0.12', published_at: '2026-09-08T00:00:00Z' }),
      ]);
      expect(picked?.release.tag_name).toBe('firmware-v0.12');
    },
  );

  behaviour(
    {
      id: 'flash.release-image-is-the-two-port-build',
      covers: 'src/firmware/release.ts#pickFirmwareAsset',
      given:
        'a firmware release carrying MaD-Firmware-0.15.bin beside images named for the P2Eval and MaDEdge boards',
      expect: { 'plain-image': 'the image offered is MaD-Firmware-0.15.bin, the one named for no board' },
    },
    () => {
      const offered = pickFirmwareAsset(
        release({
          assets: [
            { id: 1, name: 'MaD-Firmware-0.15-MaDEdge.bin', size: 9 },
            { id: 2, name: 'MaD-Firmware-0.15-P2Eval.bin', size: 8 },
            { id: 3, name: 'MaD-Firmware-0.15.bin', size: 7 },
          ],
        }),
      );
      expect(offered?.name).toBe('MaD-Firmware-0.15.bin');
    },
  );

  behaviour(
    {
      id: 'flash.release-single-port-builds-not-offered',
      covers: 'src/firmware/release.ts#pickFirmwareAsset',
      given:
        'a firmware release from 0.14 or before, whose images are named for a board: P2Eval, release, MaDEdge, madEdge or debug',
      expect: { 'nothing-offered': 'the release offers no image to flash' },
      why: {
        'nothing-offered':
          'those builds answer on header J1 or on pins the module does not bring out, and MaD Control talks to the firmware only on the control port',
      },
    },
    () => {
      for (const suffix of ['P2Eval', 'release', 'MaDEdge', 'madEdge', 'debug']) {
        expect(pickFirmwareAsset(release({ assets: [{ id: 1, name: `MaD-Firmware-0.14-${suffix}.bin`, size: 8 }] }))).toBeNull();
      }
    },
  );

  behaviour(
    {
      id: 'flash.release-latest-prefers-two-port-build',
      covers: 'src/firmware/release.ts#pickFirmwareRelease',
      given: 'a release carrying the two-port build, and an older one carrying only a P2Eval build',
      expect: { 'two-port-served': 'the newest of all is served from the release with the two-port build' },
    },
    () => {
      const picked = pickFirmwareRelease([
        release({
          tag_name: 'firmware-v0.14',
          published_at: '2026-10-18T00:00:00Z',
          assets: [{ id: 1, name: 'MaD-Firmware-0.14-P2Eval.bin', size: 8 }],
        }),
        release({
          tag_name: 'firmware-v0.15',
          published_at: '2026-11-10T00:00:00Z',
          assets: [{ id: 2, name: 'MaD-Firmware-0.15.bin', size: 7 }],
        }),
      ]);
      expect([picked?.release.tag_name, picked?.asset.name]).toEqual(['firmware-v0.15', 'MaD-Firmware-0.15.bin']);
    },
  );

  behaviour(
    {
      id: 'flash.release-latest-falls-back-to-production',
      covers: 'src/firmware/release.ts#pickFirmwareRelease',
      given:
        'releases from before the two-port build: the newest carrying only a MaDEdge build, an older one a release build',
      expect: {
        'production-served': 'the newest of all is served from the older release, with its release build',
      },
      why: {
        'production-served':
          'app versions from before the firmware list flash the newest of all and reconnect on the port they flashed through, where only that build answers',
      },
    },
    () => {
      const picked = pickFirmwareRelease([
        release({
          tag_name: 'firmware-v0.14',
          published_at: '2026-11-01T00:00:00Z',
          assets: [{ id: 1, name: 'MaD-Firmware-0.14-madEdge.bin', size: 9 }],
        }),
        release({
          tag_name: 'firmware-v0.13',
          published_at: '2026-10-18T00:00:00Z',
          assets: [{ id: 2, name: 'MaD-Firmware-0.13-release.bin', size: 8 }],
        }),
      ]);
      expect([picked?.release.tag_name, picked?.asset.name]).toEqual(['firmware-v0.13', 'MaD-Firmware-0.13-release.bin']);
    },
  );
});

describe('toManifest', () => {
  behaviour(
    {
      id: 'flash.release-manifest-describes-image',
      covers: 'src/firmware/release.ts#toManifest',
      given: 'the firmware release tagged firmware-v0.12 and its release image, with an upper-case checksum',
      expect: {
        'version-from-tag': 'the version shown is the tag without its firmware prefix',
        'image-named': 'the image is named and sized as published',
        'checksum-lowercase': 'the checksum is kept in lower case',
      },
    },
    () => {
      const m = toManifest(
        release({ tag_name: 'firmware-v0.12' }),
        { id: 9, name: 'MaD-Firmware-0.12-release.bin', size: 291396 },
        'ABCDEF',
      );
      expect(m.version).toBe('0.12');
      expect([m.assetName, m.size]).toEqual(['MaD-Firmware-0.12-release.bin', 291396]);
      expect(m.sha256).toBe('abcdef');
    },
  );
});

describe('fetchFirmwareManifest', () => {
  behaviour(
    {
      id: 'flash.release-manifest-loads',
      covers: 'src/firmware/release.ts#fetchFirmwareManifest',
      given: 'a copy of the app served with its bundled firmware releases, under a sub-path',
      expect: {
        'read-from-base': "the list of releases is read from the app's own sub-path",
        'described-release': 'the releases it lists are the ones offered',
      },
    },
    async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ releases: [entry()] })));
      vi.stubGlobal('fetch', fetchMock);
      const m = await fetchFirmwareManifest('/MaD/app/');
      expect(fetchMock).toHaveBeenCalledWith('/MaD/app/firmware/manifest.json');
      expect(m.releases.map((r) => r.tag)).toEqual(['firmware-v0.1']);
    },
  );

  behaviour(
    {
      id: 'flash.release-manifest-unreachable',
      covers: 'src/firmware/release.ts#fetchFirmwareManifest',
      given: 'the app server cannot be reached while looking up the firmware releases',
      expect: { 'says-unreachable': 'the lookup fails with a message saying the server could not be reached' },
    },
    async () => {
      const offline = async (): Promise<Response> => {
        throw new TypeError('Failed to fetch');
      };
      await expect(fetchFirmwareManifest('/', offline)).rejects.toThrow(/Could not reach/);
    },
  );

  behaviour(
    {
      id: 'flash.release-manifest-malformed',
      covers: 'src/firmware/release.ts#fetchFirmwareManifest',
      given:
        'a bundled list of releases with an entry missing its checksum, one missing its protocol version, or one that is not JSON at all',
      expect: { 'says-malformed': 'each lookup fails with a message saying the description is malformed' },
    },
    async () => {
      const noChecksum: Partial<FirmwareManifestEntry> = entry();
      delete noChecksum.sha256;
      const noProtocol: Partial<FirmwareManifestEntry> = entry();
      delete noProtocol.protocolVersion;
      for (const body of [
        JSON.stringify({ releases: [noChecksum] }),
        JSON.stringify({ releases: [noProtocol] }),
        JSON.stringify([entry()]),
        'null',
        '<html>',
      ]) {
        await expect(fetchFirmwareManifest('/', serve(body))).rejects.toThrow(/malformed/);
      }
    },
  );

  behaviour(
    {
      id: 'flash.release-missing-explained',
      covers: 'src/firmware/release.ts#fetchFirmwareManifest',
      given: 'a copy of the app served without bundled firmware releases',
      expect: {
        'says-none-bundled': 'looking up the firmware releases fails with a message saying none is bundled',
      },
    },
    async () => {
      await expect(fetchFirmwareManifest('/', serve('', 404))).rejects.toThrow(/No firmware release is bundled/);
    },
  );
});

describe('releases per protocol', () => {
  behaviour(
    {
      id: 'flash.release-described-only',
      covers: 'src/firmware/release.ts#describedReleases',
      given:
        'published firmware releases where some carry a file saying which protocol they speak and the older ones do not, plus a draft that does',
      expect: {
        'described-newest-first':
          'only the published releases that say which protocol they speak are candidates, newest first',
      },
      why: {
        'described-newest-first':
          "a release without that file predates the firmware's protocol report, so an app connected to it would still find it too old",
      },
    },
    () => {
      const picked = describedReleases([
        firmware('firmware-v0.13', '2026-10-18T00:00:00Z', false),
        firmware('firmware-v0.14', '2026-11-01T00:00:00Z'),
        { ...firmware('firmware-v0.16', '2026-11-20T00:00:00Z'), draft: true },
        firmware('firmware-v0.15', '2026-11-10T00:00:00Z'),
      ]);
      expect(picked.map((p) => p.release.tag_name)).toEqual(['firmware-v0.15', 'firmware-v0.14']);
      expect(picked.map((p) => [p.asset.name, p.info.name])).toEqual([
        ['MaD-Firmware-0.15.bin', 'firmware-info.json'],
        ['MaD-Firmware-0.14.bin', 'firmware-info.json'],
      ]);
    },
  );

  behaviour(
    {
      id: 'flash.release-newest-per-protocol',
      covers: 'src/firmware/release.ts#newestPerProtocol',
      given: 'candidate releases, newest first, where two speak protocol 3 and one older one speaks protocol 2',
      expect: { 'one-per-protocol': 'the newest release of each protocol is kept, and only that one' },
    },
    () => {
      const kept = newestPerProtocol([
        { tag: '0.16', protocolVersion: 3 },
        { tag: '0.15', protocolVersion: 3 },
        { tag: '0.14', protocolVersion: 2 },
      ]);
      expect(kept.map((k) => k.tag)).toEqual(['0.16', '0.14']);
    },
  );

  behaviour(
    {
      id: 'flash.release-info-shape',
      covers: 'src/firmware/release.ts#isFirmwareInfo',
      given: "a release's file saying which protocol its firmware speaks",
      expect: {
        'version-and-whole-protocol':
          'it is accepted only with a version string and a whole-number protocol version',
      },
    },
    () => {
      expect(isFirmwareInfo({ version: '0.14', protocolVersion: 2 })).toBe(true);
      expect(isFirmwareInfo({ version: '0.14', protocolVersion: '2' })).toBe(false);
      expect(isFirmwareInfo({ version: '0.14', protocolVersion: 2.5 })).toBe(false);
      expect(isFirmwareInfo({ protocolVersion: 2 })).toBe(false);
      expect(isFirmwareInfo(null)).toBe(false);
    },
  );

  behaviour(
    {
      id: 'flash.release-entry-served-beside-manifest',
      covers: 'src/firmware/release.ts#toManifestEntry',
      given: 'the firmware release tagged firmware-v0.14, speaking protocol 2, and its production image',
      expect: {
        'protocol-recorded': 'its entry records protocol 2 alongside the version, image name, size and checksum',
        'image-path': 'its image is served in the firmware folder under its own file name',
      },
    },
    () => {
      const e = toManifestEntry(
        release({ tag_name: 'firmware-v0.14' }),
        { id: 3, name: 'MaD-Firmware-0.14-release.bin', size: 291396 },
        'ABC',
        2,
      );
      expect([e.version, e.assetName, e.size, e.sha256, e.protocolVersion]).toEqual([
        '0.14',
        'MaD-Firmware-0.14-release.bin',
        291396,
        'abc',
        2,
      ]);
      expect(e.path).toBe('firmware/MaD-Firmware-0.14-release.bin');
    },
  );

  behaviour(
    {
      id: 'flash.release-recommended-matches-protocol',
      covers: 'src/firmware/release.ts#recommendedRelease',
      given: 'listed releases speaking protocols 3 and 2, and an app on protocol 2',
      expect: {
        'matching-newest': "the recommended firmware is the newest release speaking the app's protocol",
        'none-when-absent': 'an app on a protocol no release speaks yet is recommended nothing',
      },
      why: {
        'matching-newest':
          'every hosted app version shares one firmware folder, so an older app must not be handed firmware made for a newer one',
      },
    },
    () => {
      const manifest = {
        releases: [
          entry({ tag: 'firmware-v0.16', protocolVersion: 3, publishedAt: '2026-11-20T00:00:00Z' }),
          entry({ tag: 'firmware-v0.14', protocolVersion: 2, publishedAt: '2026-11-01T00:00:00Z' }),
          entry({ tag: 'firmware-v0.15', protocolVersion: 2, publishedAt: '2026-11-10T00:00:00Z' }),
        ],
      };
      expect(recommendedRelease(manifest, 2)?.tag).toBe('firmware-v0.15');
      expect(recommendedRelease(manifest, 4)).toBeNull();
    },
  );
});

describe('fetchReleaseImage', () => {
  behaviour(
    {
      id: 'flash.release-image-verified',
      covers: 'src/firmware/release.ts#fetchReleaseImage',
      given: 'a downloaded release image whose size and checksum match its release description',
      expect: { 'bytes-returned': 'the image is handed over byte for byte as served' },
    },
    async () => {
      const bytes = await fetchReleaseImage('/', manifest(), serve(IMAGE));
      expect(Array.from(bytes)).toEqual(Array.from(IMAGE));
    },
  );

  behaviour(
    {
      id: 'flash.release-image-from-its-path',
      covers: 'src/firmware/release.ts#fetchReleaseImage',
      given: 'a recommended release whose image is served under its own file name, for an app under a sub-path',
      expect: { 'read-from-path': "the image is downloaded from that file name in the app's firmware folder" },
    },
    async () => {
      const fetchMock = vi.fn(async () => new Response(IMAGE));
      await fetchReleaseImage('/MaD/app/', entry(), fetchMock);
      expect(fetchMock).toHaveBeenCalledWith('/MaD/app/firmware/MaD-Firmware-0.1-release.bin');
    },
  );

  behaviour(
    {
      id: 'flash.release-image-unavailable',
      covers: 'src/firmware/release.ts#fetchReleaseImage',
      given: 'the release image cannot be downloaded from the app server',
      expect: { 'says-http-status': 'the download fails naming the image and the server status' },
    },
    async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
      await expect(fetchReleaseImage('/', manifest())).rejects.toThrow(
        /Downloading MaD-Firmware-0\.1-release\.bin failed \(HTTP 404\)/,
      );
    },
  );

  behaviour(
    {
      id: 'flash.release-image-truncated',
      covers: 'src/firmware/release.ts#fetchReleaseImage',
      given: 'a downloaded release image shorter than its release description says',
      expect: { 'refused-size': 'the download is refused, naming the size it got and the size expected' },
    },
    async () => {
      await expect(fetchReleaseImage('/', manifest({ size: 8 }), serve(IMAGE))).rejects.toThrow(
        /is 4 bytes, expected 8/,
      );
    },
  );

  behaviour(
    {
      id: 'flash.release-image-checksum',
      covers: 'src/firmware/release.ts#fetchReleaseImage',
      given: 'a downloaded release image of the right size whose contents differ from the release checksum',
      expect: { 'refused-checksum': 'the download is refused as not matching its release checksum' },
    },
    async () => {
      await expect(
        fetchReleaseImage('/', manifest(), serve(new Uint8Array([4, 3, 2, 1]))),
      ).rejects.toThrow(/does not match its release checksum/);
    },
  );
});

describe('cacheRecommendedRelease', () => {
  behaviour(
    {
      id: 'flash.release-cached-for-offline',
      covers: 'src/firmware/release.ts#cacheRecommendedRelease',
      given: "an app on protocol 2 starting while the server lists a release for protocol 2",
      expect: {
        'image-fetched': "the recommended release's image is fetched once, so the app's offline copy holds it",
      },
    },
    async () => {
      const fetchMock = vi.fn(async (url: string) =>
        url.endsWith('manifest.json')
          ? new Response(JSON.stringify({ releases: [entry()] }))
          : new Response(IMAGE),
      );
      expect((await cacheRecommendedRelease('/MaD/app/', 2, fetchMock))?.tag).toBe('firmware-v0.1');
      expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
        '/MaD/app/firmware/manifest.json',
        '/MaD/app/firmware/MaD-Firmware-0.1-release.bin',
      ]);
    },
  );

  behaviour(
    {
      id: 'flash.release-cache-failure-quiet',
      covers: 'src/firmware/release.ts#cacheRecommendedRelease',
      given: 'an app starting while the server cannot be reached, or lists no release for its protocol',
      expect: { 'nothing-cached-quietly': 'nothing is cached and the app carries on without an error' },
    },
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (): Promise<Response> => {
          throw new TypeError('Failed to fetch');
        }),
      );
      expect(await cacheRecommendedRelease('/', 2)).toBeNull();
      const other = vi.fn(async () => new Response(JSON.stringify({ releases: [entry({ protocolVersion: 3 })] })));
      expect(await cacheRecommendedRelease('/', 2, other)).toBeNull();
      expect(other).toHaveBeenCalledTimes(1);
    },
  );
});
