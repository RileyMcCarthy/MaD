import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { fetchHostedVersions, hostedVersion, hostingRoot, versionUrl } from './hosting';

describe('hosting paths', () => {
  behaviour(
    {
      id: 'hosting.versioned-base',
      covers: 'src/hosting.ts#hostedVersion',
      given: 'the app served from the release folder /MaD/app/v0.4.0/',
      expect: {
        'version-read': 'the running release is 0.4.0',
        'root-is-parent': 'the folder shared by all releases is /MaD/app/',
        'switch-keeps-route': 'another release opens on the same page, at /MaD/app/v0.3.9/#/firmware',
      },
    },
    () => {
      const base = '/MaD/app/v0.4.0/';
      expect(hostedVersion(base)).toBe('0.4.0');
      expect(hostingRoot(base)).toBe('/MaD/app/');
      expect(versionUrl(base, '0.3.9', '#/firmware')).toBe('/MaD/app/v0.3.9/#/firmware');
    },
  );

  behaviour(
    {
      id: 'hosting.unversioned-base',
      covers: 'src/hosting.ts#hostingRoot',
      given: 'the app served from a development server at /',
      expect: {
        'no-version': 'it is not a published release',
        'root-is-base': 'its shared folder is its own base, where the dev server serves the firmware',
      },
    },
    () => {
      expect(hostedVersion('/')).toBeNull();
      expect(hostingRoot('/')).toBe('/');
    },
  );
});

describe('fetchHostedVersions', () => {
  behaviour(
    {
      id: 'hosting.versions-list',
      covers: 'src/hosting.ts#fetchHostedVersions',
      given: 'a release folder whose shared list names two releases',
      expect: { 'list-read': "the list is read from the shared folder's versions.json" },
    },
    async () => {
      let asked = '';
      const list = { latest: '0.4.0', versions: [{ version: '0.4.0', publishedAt: null }, { version: '0.3.9', publishedAt: null }] };
      const got = await fetchHostedVersions('/MaD/app/v0.4.0/', async (url) => {
        asked = url;
        return new Response(JSON.stringify(list));
      });
      expect(asked).toBe('/MaD/app/versions.json');
      expect(got).toEqual(list);
    },
  );

  behaviour(
    {
      id: 'hosting.versions-absent',
      covers: 'src/hosting.ts#fetchHostedVersions',
      given: 'a development build, and a release folder whose shared list is missing or malformed',
      expect: { 'no-list': 'no release list is offered' },
    },
    async () => {
      expect(await fetchHostedVersions('/')).toBeNull();
      expect(await fetchHostedVersions('/MaD/app/v0.4.0/', async () => new Response('', { status: 404 }))).toBeNull();
      expect(await fetchHostedVersions('/MaD/app/v0.4.0/', async () => new Response('{"latest":1}'))).toBeNull();
    },
  );
});
