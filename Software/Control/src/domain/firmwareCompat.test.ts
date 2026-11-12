import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  CHECKING,
  blocksMotion,
  checkFirmwareCompat,
  compareFirmwareVersions,
  describeAppForFirmware,
  describeFirmwareCompat,
  MIN_FIRMWARE,
  parseFirmwareVersion,
} from './firmwareCompat';

const APP = 4;

describe('checkFirmwareCompat', () => {
  behaviour(
    {
      id: 'firmware-compat.matching-protocol',
      covers: 'src/domain/firmwareCompat.ts#checkFirmwareCompat',
      given: 'firmware that reports the same protocol version as the app, with no recommended minimum firmware',
      expect: {
        'drives-without-warning': 'the app drives the machine and shows no firmware warning',
      },
    },
    () => {
      const compat = checkFirmwareCompat({ deviceProtocol: APP, deviceFirmware: '0.14', appProtocol: APP });
      expect(compat).toEqual({ kind: 'ok' });
      expect(blocksMotion(compat)).toBe(false);
    },
  );

  behaviour(
    {
      id: 'firmware-compat.protocol-not-reported',
      covers: 'src/domain/firmwareCompat.ts#checkFirmwareCompat',
      given: 'firmware that refuses, with a reason the app can read, to say which protocol it speaks',
      expect: {
        'too-old': 'the firmware is reported as too old for the app',
        'motion-blocked': 'the app refuses to move the machine',
      },
      why: {
        'too-old':
          'firmware that will not name its protocol cannot be trusted to match the app, so it is treated as needing an update',
      },
    },
    () => {
      const compat = checkFirmwareCompat({ deviceProtocol: null, deviceFirmware: '0.13', appProtocol: APP });
      expect(compat).toEqual({ kind: 'firmwareTooOld', deviceProtocol: null, appProtocol: APP });
      expect(blocksMotion(compat)).toBe(true);
    },
  );

  behaviour(
    {
      id: 'firmware-compat.older-protocol',
      covers: 'src/domain/firmwareCompat.ts#checkFirmwareCompat',
      given: 'firmware that reports a lower protocol version than the app',
      expect: {
        'too-old': 'the firmware is reported as too old for the app, naming both protocol versions',
        'motion-blocked': 'the app refuses to move the machine',
      },
    },
    () => {
      const compat = checkFirmwareCompat({ deviceProtocol: APP - 1, deviceFirmware: '0.14', appProtocol: APP });
      expect(compat).toEqual({ kind: 'firmwareTooOld', deviceProtocol: APP - 1, appProtocol: APP });
      expect(blocksMotion(compat)).toBe(true);
    },
  );

  behaviour(
    {
      id: 'firmware-compat.newer-protocol',
      covers: 'src/domain/firmwareCompat.ts#checkFirmwareCompat',
      given: 'firmware that reports a higher protocol version than the app',
      expect: {
        'app-too-old': 'the app reports itself as too old for the firmware, naming both protocol versions',
        'motion-blocked': 'the app refuses to move the machine',
      },
    },
    () => {
      const compat = checkFirmwareCompat({ deviceProtocol: APP + 1, deviceFirmware: '0.20', appProtocol: APP });
      expect(compat).toEqual({ kind: 'appTooOld', deviceProtocol: APP + 1, appProtocol: APP });
      expect(blocksMotion(compat)).toBe(true);
    },
  );

  behaviour(
    {
      id: 'firmware-compat.below-recommended-minimum',
      covers: 'src/domain/firmwareCompat.ts#checkFirmwareCompat',
      given: "firmware on the app's protocol whose release is older than the app's recommended minimum",
      expect: {
        'update-recommended': 'an update is recommended, naming the installed release and the minimum',
        'motion-allowed': 'the app still moves the machine',
      },
    },
    () => {
      const compat = checkFirmwareCompat({
        deviceProtocol: APP,
        deviceFirmware: '0.14',
        appProtocol: APP,
        minFirmware: '0.15.1',
      });
      expect(compat).toEqual({ kind: 'belowMinFirmware', firmwareVersion: '0.14', minFirmware: '0.15.1' });
      expect(blocksMotion(compat)).toBe(false);
    },
  );

  behaviour(
    {
      id: 'firmware-compat.at-recommended-minimum',
      covers: 'src/domain/firmwareCompat.ts#checkFirmwareCompat',
      given: "firmware on the app's protocol whose release is exactly the recommended minimum",
      expect: { 'no-recommendation': 'no update is recommended' },
    },
    () => {
      expect(
        checkFirmwareCompat({ deviceProtocol: APP, deviceFirmware: '0.15', appProtocol: APP, minFirmware: '0.15.0' }),
      ).toEqual({ kind: 'ok' });
    },
  );

  behaviour(
    {
      id: 'firmware-compat.developer-build-and-minimum',
      covers: 'src/domain/firmwareCompat.ts#checkFirmwareCompat',
      given:
        "a recommended minimum, and firmware on the app's protocol built without a release version: unstamped (0.0.0) or a CI build (dev-42)",
      expect: { 'no-recommendation': 'no update is recommended for either build' },
      why: {
        'no-recommendation': "a developer build's version says nothing about which fixes it carries",
      },
    },
    () => {
      for (const deviceFirmware of ['0.0.0', 'dev-42']) {
        expect(
          checkFirmwareCompat({ deviceProtocol: APP, deviceFirmware, appProtocol: APP, minFirmware: '0.15' }),
        ).toEqual({ kind: 'ok' });
      }
    },
  );

  behaviour(
    {
      id: 'firmware-compat.recommended-minimum-unset',
      covers: 'src/domain/firmwareCompat.ts#MIN_FIRMWARE',
      given: 'the minimum firmware this app version ships with',
      expect: {
        'is-release-or-unset':
          'it is either unset or a release version the app can compare, so a typo cannot silently disable the recommendation',
      },
    },
    () => {
      if (MIN_FIRMWARE !== null) expect(parseFirmwareVersion(MIN_FIRMWARE)).not.toBeNull();
    },
  );
});

describe('firmware versions', () => {
  behaviour(
    {
      id: 'firmware-compat.version-order',
      covers: 'src/domain/firmwareCompat.ts#compareFirmwareVersions',
      given: 'firmware release versions written with two or three parts, with or without a leading v',
      expect: {
        'missing-part-is-zero': 'a missing part counts as zero, so 0.13, v0.13 and 0.13.0 are the same release',
        'numeric-order': 'each part compares as a number, so 0.9 is older than 0.10',
        'non-release-unordered': 'a version that is not a release number, such as dev-42, is not ordered at all',
      },
    },
    () => {
      const v = (s: string) => parseFirmwareVersion(s)!;
      expect(compareFirmwareVersions(v('0.13'), v('0.13.0'))).toBe(0);
      expect(compareFirmwareVersions(v('v0.13'), v('0.13'))).toBe(0);
      expect(compareFirmwareVersions(v('0.9'), v('0.10'))).toBeLessThan(0);
      expect(compareFirmwareVersions(v('1.0'), v('0.99.9'))).toBeGreaterThan(0);
      expect(parseFirmwareVersion('dev-42')).toBeNull();
    },
  );
});

describe('describeFirmwareCompat', () => {
  behaviour(
    {
      id: 'firmware-compat.operator-message',
      covers: 'src/domain/firmwareCompat.ts#describeFirmwareCompat',
      given: 'each verdict on whether the app can drive the connected firmware',
      expect: {
        'too-old-names-protocols':
          "a too-old firmware's message names its protocol and the one the app needs, and says motion is disabled until it is updated",
        'unreported-names-app-protocol':
          'a firmware that reports no protocol gets a message naming the protocol the app needs',
        'app-too-old-names-protocols':
          "a too-old app's message names the firmware's protocol and the app's, and says motion is disabled",
        'app-too-old-says-open-latest':
          "a too-old app says to open a MaD Control that speaks the firmware's protocol, or to install firmware for this app",
        'minimum-names-releases': 'a recommended update names the installed release and the minimum',
      },
    },
    () => {
      const old = describeFirmwareCompat({ kind: 'firmwareTooOld', deviceProtocol: 3, appProtocol: 4 });
      expect(old).toContain('protocol 3');
      expect(old).toContain('needs 4');
      expect(old).toContain('Motion is disabled until the firmware is updated');
      expect(describeFirmwareCompat({ kind: 'firmwareTooOld', deviceProtocol: null, appProtocol: 4 })).toContain(
        'needs protocol 4',
      );
      const newer = describeFirmwareCompat({ kind: 'appTooOld', deviceProtocol: 5, appProtocol: 4 });
      expect(newer).toContain('protocol 5');
      expect(newer).toContain('speaks 4');
      expect(newer).toContain('Motion is disabled');
      expect(newer).toContain('open a MaD Control that speaks protocol 5, or install firmware for this app');
      const min = describeFirmwareCompat({ kind: 'belowMinFirmware', firmwareVersion: '0.14', minFirmware: '0.15' });
      expect(min).toContain('0.14');
      expect(min).toContain('0.15');
      expect(describeFirmwareCompat({ kind: 'ok' })).toContain('matches');
    },
  );
});

describe('describeAppForFirmware', () => {
  behaviour(
    {
      id: 'firmware-compat.app-for-firmware-found',
      covers: 'src/domain/firmwareCompat.ts#describeAppForFirmware',
      given: "firmware a protocol ahead of this app, with a released MaD Control that speaks the firmware's protocol",
      expect: { 'release-named': 'the operator is told the version of that release and the protocol it speaks' },
    },
    () => {
      expect(describeAppForFirmware(5, { kind: 'release', version: '0.6.1' })).toBe('MaD Control 0.6.1 speaks protocol 5.');
    },
  );

  behaviour(
    {
      id: 'firmware-compat.app-for-firmware-none',
      covers: 'src/domain/firmwareCompat.ts#describeAppForFirmware',
      given: "firmware a protocol ahead of this app, with no released MaD Control to offer for the firmware's protocol",
      expect: {
        'development-build':
          'the operator is told that no released MaD Control speaks that protocol, so the firmware is probably a development build',
      },
      why: {
        'development-build':
          'every firmware protocol that is released gets a MaD Control release that speaks it, straight after the firmware',
      },
    },
    () => {
      const none = describeAppForFirmware(5, { kind: 'none' });
      expect(none).toContain('No released MaD Control speaks protocol 5');
      expect(none).toContain('development firmware build');
    },
  );

  behaviour(
    {
      id: 'firmware-compat.app-for-firmware-unknown',
      covers: 'src/domain/firmwareCompat.ts#describeAppForFirmware',
      given: 'firmware a protocol ahead of this app, on a release whose list of MaD Control releases could not be loaded',
      expect: {
        'list-unreadable':
          "the operator is told the list could not be loaded, so which release speaks the firmware's protocol is not known",
      },
    },
    () => {
      const unknown = describeAppForFirmware(5, { kind: 'unknown' });
      expect(unknown).toContain('could not be loaded');
      expect(unknown).toContain('protocol 5');
      expect(unknown).not.toContain('development firmware');
    },
  );
});

describe('motion fails closed', () => {
  behaviour(
    {
      id: 'firmware-compat.blocked-until-answered',
      covers: 'src/domain/firmwareCompat.ts#blocksMotion',
      given: 'a connection whose firmware is still being asked which protocol it speaks, or never answered',
      expect: {
        'checking-blocks': 'motion is blocked while the question is on its way',
        'unanswered-blocks': 'motion stays blocked when the firmware never answers',
        'match-allows': 'motion is allowed only once the firmware reports this app\'s protocol, recommended update or not',
        'no-connection': 'with no connection there is no verdict, and nothing to block',
      },
      why: {
        'unanswered-blocks':
          'without an answer the app cannot know what its motion commands would mean to that firmware',
      },
    },
    () => {
      expect(blocksMotion(CHECKING)).toBe(true);
      expect(blocksMotion({ kind: 'unanswered' })).toBe(true);
      expect(blocksMotion({ kind: 'ok' })).toBe(false);
      expect(blocksMotion({ kind: 'belowMinFirmware', firmwareVersion: '0.14', minFirmware: '0.15' })).toBe(false);
      expect(blocksMotion(null)).toBe(false);
    },
  );

  behaviour(
    {
      id: 'firmware-compat.blocked-reason-shown',
      covers: 'src/domain/firmwareCompat.ts#describeFirmwareCompat',
      given: 'motion blocked while the firmware is being asked, or because it never answered',
      expect: {
        'checking-says-waiting': 'the operator is told the app is checking the firmware and motion stays disabled until it answers',
        'unanswered-says-why': 'the operator is told the firmware did not answer, and to check the connection or update the firmware',
      },
    },
    () => {
      expect(describeFirmwareCompat(CHECKING)).toMatch(/^Checking which protocol .* Motion stays disabled until it answers\.$/);
      const unanswered = describeFirmwareCompat({ kind: 'unanswered' });
      expect(unanswered).toContain('did not say which protocol it speaks');
      expect(unanswered).toContain('check the connection and reconnect, or update the firmware');
    },
  );
});
