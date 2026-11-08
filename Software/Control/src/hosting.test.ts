import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { appForFirmware, appForProtocol, fetchHostedVersions, hostedVersion, hostingRoot, versionUrl } from './hosting';

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
      id: 'hosting.versions-list-with-protocols',
      covers: 'src/hosting.ts#fetchHostedVersions',
      given: 'a shared list whose newer entries also record the protocol each release speaks',
      expect: { 'list-read': 'the list is read whole, with every release on it' },
      why: {
        'list-read':
          'releases up to 0.4.3 read this list with the same check, so the protocol recorded beside a version must leave it readable',
      },
    },
    async () => {
      const list = {
        latest: '0.5.0',
        versions: [
          { version: '0.5.0', publishedAt: null, protocolVersion: 3 },
          { version: '0.4.3', publishedAt: null },
        ],
      };
      const got = await fetchHostedVersions('/MaD/app/v0.4.3/', async () => new Response(JSON.stringify(list)));
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

describe('appForProtocol', () => {
  const list = {
    latest: '0.6.0',
    versions: [
      { version: '0.6.0', publishedAt: null, protocolVersion: 4 },
      { version: '0.5.1', publishedAt: null, protocolVersion: 3 },
      { version: '0.5.0', publishedAt: null, protocolVersion: 3 },
      { version: '0.4.3', publishedAt: null },
    ],
  };

  behaviour(
    {
      id: 'hosting.app-for-protocol',
      covers: 'src/hosting.ts#appForProtocol',
      given: 'a release list whose newest release speaks protocol 4 and two older ones speak protocol 3',
      expect: {
        'newest-match': 'the release offered for protocol 3 is 0.5.1, the newest of the two that speak it',
      },
    },
    () => {
      expect(appForProtocol(list, 3)).toBe('0.5.1');
    },
  );

  behaviour(
    {
      id: 'hosting.app-for-protocol-none',
      covers: 'src/hosting.ts#appForProtocol',
      given: 'a firmware protocol that no release on the list is recorded as speaking',
      expect: {
        'none-offered': 'no release is offered, even with releases built before protocols were recorded on the list',
      },
      why: {
        'none-offered': 'a release that does not record its protocol cannot be shown to speak the firmware\'s',
      },
    },
    () => {
      expect(appForProtocol(list, 5)).toBeNull();
      expect(appForProtocol(list, 2)).toBeNull();
    },
  );
});

describe('appForFirmware', () => {
  const list = {
    latest: '0.6.0',
    versions: [
      { version: '0.6.0', publishedAt: null, protocolVersion: 4 },
      { version: '0.5.1', publishedAt: null, protocolVersion: 3 },
      { version: '0.5.0', publishedAt: null, protocolVersion: 3 },
    ],
  };

  behaviour(
    {
      id: 'hosting.app-for-firmware-listed',
      covers: 'src/hosting.ts#appForFirmware',
      given: 'a release whose list of releases has been read, two of them speaking protocol 3 and none protocol 5',
      expect: {
        'match-offered': 'for firmware on protocol 3, the newer of the two releases is offered',
        'no-match': 'for firmware on protocol 5, no release is offered',
      },
    },
    () => {
      expect(appForFirmware(true, list, 3)).toEqual({ kind: 'release', version: '0.5.1' });
      expect(appForFirmware(true, list, 5)).toEqual({ kind: 'none' });
    },
  );

  behaviour(
    {
      id: 'hosting.app-for-firmware-unreadable',
      covers: 'src/hosting.ts#appForFirmware',
      given: 'a release whose list of releases could not be read',
      expect: { unknown: "which release speaks the firmware's protocol is reported as unknown" },
      why: {
        unknown:
          'an unread list says nothing about which releases exist, so the operator is not sent to reflash a board that may run released firmware',
      },
    },
    () => {
      expect(appForFirmware(true, null, 3)).toEqual({ kind: 'unknown' });
    },
  );

  behaviour(
    {
      id: 'hosting.app-for-firmware-loading',
      covers: 'src/hosting.ts#appForFirmware',
      given: 'a release whose list of releases is still on its way',
      expect: { 'still-looking': 'the answer is still being looked up' },
    },
    () => {
      expect(appForFirmware(true, undefined, 3)).toEqual({ kind: 'looking' });
    },
  );

  behaviour(
    {
      id: 'hosting.app-for-firmware-unversioned',
      covers: 'src/hosting.ts#appForFirmware',
      given: 'a copy of the app that is not a release, such as a development server',
      expect: { 'none-offered': 'no release is offered, since there is no list of releases beside it' },
    },
    () => {
      expect(appForFirmware(false, undefined, 3)).toEqual({ kind: 'none' });
      expect(appForFirmware(false, list, 3)).toEqual({ kind: 'none' });
    },
  );
});
