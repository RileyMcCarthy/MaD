import { afterEach, describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  fetchReleaseImage,
  fetchReleaseManifest,
  pickFirmwareAsset,
  pickFirmwareRelease,
  releaseImageLabel,
  toManifest,
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
  assets: [{ id: 1, name: 'MaD-Firmware-0.1-release.bin', size: 4 }],
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

const serve = (body: BodyInit, status = 200) => async () => new Response(body, { status });

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
      id: 'flash.release-picks-madedge-build',
      covers: 'src/firmware/release.ts#pickFirmwareAsset',
      given: 'a firmware release that carries both a MadEdge image and a production image, the MadEdge one listed first',
      expect: { 'madedge-image': 'the image offered is the production build' },
      why: {
        'madedge-image':
          "the production build answers the app on the debug header J1; the MadEdge build talks on P53/P55, which the machine's P2-EC32MB module does not bring out",
      },
    },
    () => {
      const picked = pickFirmwareRelease([
        release({
          assets: [
            { id: 1, name: 'MaD-Firmware-0.13-madEdge.bin', size: 9 },
            { id: 2, name: 'MaD-Firmware-0.13-release.bin', size: 8 },
          ],
        }),
      ]);
      expect(picked?.asset.name).toBe('MaD-Firmware-0.13-release.bin');
    },
  );

  behaviour(
    {
      id: 'flash.release-legacy-debug-is-madedge',
      covers: 'src/firmware/release.ts#pickFirmwareAsset',
      given: 'a firmware release from before the MadEdge name, carrying a debug image and a release image',
      expect: { 'debug-image': 'the image offered is the release image' },
      why: {
        'debug-image':
          'the debug build puts the protocol on P53/P55, which the machine\'s P2-EC32MB module does not bring out; the release image answers on the debug header J1',
      },
    },
    () => {
      const offered = pickFirmwareAsset(
        release({
          assets: [
            { id: 1, name: 'MaD-Firmware-0.11-debug.bin', size: 9 },
            { id: 2, name: 'MaD-Firmware-0.11-release.bin', size: 8 },
          ],
        }),
      );
      expect(offered?.name).toBe('MaD-Firmware-0.11-release.bin');
    },
  );

  behaviour(
    {
      id: 'flash.release-without-production-offers-nothing',
      covers: 'src/firmware/release.ts#pickFirmwareAsset',
      given: 'a firmware release whose only images are a MadEdge build and a debug build',
      expect: { 'nothing-offered': 'the release offers no image to flash' },
      why: {
        'nothing-offered':
          'both builds put the protocol on P53/P55, so after flashing either one the app could not reach the firmware on the machine',
      },
    },
    () => {
      const offered = pickFirmwareAsset(
        release({
          assets: [
            { id: 1, name: 'MaD-Firmware-0.13-madEdge.bin', size: 9 },
            { id: 2, name: 'MaD-Firmware-0.11-debug.bin', size: 9 },
          ],
        }),
      );
      expect(offered).toBeNull();
    },
  );

  behaviour(
    {
      id: 'flash.release-without-madedge-skipped',
      covers: 'src/firmware/release.ts#pickFirmwareRelease',
      given: 'a newest firmware release that carries only a MadEdge image, and an older release with a production image',
      expect: { 'older-madedge': 'the offered release is the older one, with its production image' },
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
      expect(picked?.release.tag_name).toBe('firmware-v0.13');
      expect(picked?.asset.name).toBe('MaD-Firmware-0.13-release.bin');
    },
  );
});

describe('releaseImageLabel', () => {
  behaviour(
    {
      id: 'flash.release-label-production',
      covers: 'src/firmware/release.ts#releaseImageLabel',
      given: 'the latest release image is named MaD-Firmware-0.13-release.bin',
      expect: {
        'named-production':
          'the Firmware screen calls it the production build, as it does any image whose name ends in -release.bin',
      },
    },
    () => {
      expect(releaseImageLabel('MaD-Firmware-0.13-release.bin')).toBe('production build');
    },
  );

  behaviour(
    {
      id: 'flash.release-label-other-image',
      covers: 'src/firmware/release.ts#releaseImageLabel',
      given: 'the latest release image is named MaD-Firmware-0.13-madEdge.bin',
      expect: { 'named-by-file': 'the Firmware screen names it by its file name' },
      why: {
        'named-by-file':
          'every hosted version of the app reads the one shared release folder, so a version may be served an image chosen by newer code than its own',
      },
    },
    () => {
      expect(releaseImageLabel('MaD-Firmware-0.13-madEdge.bin')).toBe('MaD-Firmware-0.13-madEdge.bin');
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

describe('fetchReleaseManifest', () => {
  behaviour(
    {
      id: 'flash.release-manifest-loads',
      covers: 'src/firmware/release.ts#fetchReleaseManifest',
      given: 'a copy of the app served with a bundled firmware release, under a sub-path',
      expect: {
        'read-from-base': "the release description is read from the app's own sub-path",
        'described-release': 'the release it describes is the one offered',
      },
    },
    async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(manifest())));
      vi.stubGlobal('fetch', fetchMock);
      const m = await fetchReleaseManifest('/MaD/app/');
      expect(fetchMock).toHaveBeenCalledWith('/MaD/app/firmware/latest.json');
      expect(m.tag).toBe('firmware-v0.1');
    },
  );

  behaviour(
    {
      id: 'flash.release-manifest-unreachable',
      covers: 'src/firmware/release.ts#fetchReleaseManifest',
      given: 'the app server cannot be reached while looking up the latest release',
      expect: { 'says-unreachable': 'the lookup fails with a message saying the server could not be reached' },
    },
    async () => {
      const offline = async (): Promise<Response> => {
        throw new TypeError('Failed to fetch');
      };
      await expect(fetchReleaseManifest('/', offline)).rejects.toThrow(/Could not reach/);
    },
  );

  behaviour(
    {
      id: 'flash.release-manifest-malformed',
      covers: 'src/firmware/release.ts#fetchReleaseManifest',
      given: 'a bundled release description that is missing its checksum',
      expect: { 'says-malformed': 'the lookup fails with a message saying the description is malformed' },
    },
    async () => {
      const partial: Partial<FirmwareReleaseManifest> = manifest();
      delete partial.sha256;
      await expect(fetchReleaseManifest('/', serve(JSON.stringify(partial)))).rejects.toThrow(/malformed/);
    },
  );

  behaviour(
    {
      id: 'flash.release-missing-explained',
      covers: 'src/firmware/release.ts#fetchReleaseManifest',
      given: 'a copy of the app served without a bundled firmware release',
      expect: {
        'says-none-bundled': 'looking up the latest release fails with a message saying none is bundled',
      },
    },
    async () => {
      await expect(fetchReleaseManifest('/', serve('', 404))).rejects.toThrow(/No firmware release is bundled/);
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
