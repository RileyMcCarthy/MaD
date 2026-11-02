/**
 * The size check between the connected firmware's replies and this app's
 * protocol schema, and what the user is told when they differ.
 */
import { expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  MACHINECONFIGURATION_WIRE_SIZE,
  MSG_READ_FIRMWARE_VERSION,
  MSG_READ_MACHINE_CONFIGURATION,
  MSG_READ_SAMPLE,
  SAMPLE_WIRE_SIZE,
} from '@/protocol/generated/protoemb';
import { readReplyMismatch, schemaMismatchMessage } from './payloadSchema';

behaviour(
  {
    id: 'protocol.reply-size-checked',
    covers: 'src/device/payloadSchema.ts#readReplyMismatch',
    given: 'read replies for a sample, a machine configuration and the firmware version, each of several lengths',
    expect: {
      'exact-size-accepted': 'a sample or configuration of exactly the size in this app\'s schema is accepted',
      'other-size-rejected': 'a sample or configuration of any other length, shorter or longer, is rejected with both sizes named',
      'version-any-size': 'the firmware version is accepted at any length',
    },
    why: {
      'other-size-rejected': 'the firmware always sends these replies at their exact schema size, so another length means a different schema',
      'version-any-size': 'the version is what names the firmware in the message telling the user to update it',
    },
  },
  () => {
    expect(readReplyMismatch(MSG_READ_SAMPLE, new Uint8Array(SAMPLE_WIRE_SIZE))).toBeNull();
    expect(
      readReplyMismatch(MSG_READ_MACHINE_CONFIGURATION, new Uint8Array(MACHINECONFIGURATION_WIRE_SIZE)),
    ).toBeNull();

    expect(readReplyMismatch(MSG_READ_SAMPLE, new Uint8Array(16))).toEqual({
      command: MSG_READ_SAMPLE,
      name: 'sample',
      expected: SAMPLE_WIRE_SIZE,
      actual: 16,
    });
    expect(
      readReplyMismatch(MSG_READ_MACHINE_CONFIGURATION, new Uint8Array(MACHINECONFIGURATION_WIRE_SIZE + 4)),
    ).toMatchObject({ expected: MACHINECONFIGURATION_WIRE_SIZE, actual: MACHINECONFIGURATION_WIRE_SIZE + 4 });

    expect(readReplyMismatch(MSG_READ_FIRMWARE_VERSION, new Uint8Array(3))).toBeNull();
  },
);

behaviour(
  {
    id: 'protocol.mismatch-message',
    covers: 'src/device/payloadSchema.ts#schemaMismatchMessage',
    given: 'a machine configuration reply whose size differs from the one this app expects',
    expect: {
      'shorter-update-firmware':
        'a shorter reply from firmware 0.14 tells the user firmware 0.14 uses an older protocol and to update the firmware, naming both sizes',
      'longer-update-app': 'a longer reply tells the user the firmware uses a newer protocol and to update the app',
      'unknown-version': 'before the firmware version is known, the message refers to the connected firmware',
    },
  },
  () => {
    const shorter = { command: MSG_READ_MACHINE_CONFIGURATION, name: 'machine configuration', expected: 84, actual: 72 };
    expect(schemaMismatchMessage(shorter, '0.14')).toBe(
      'Firmware 0.14 uses an older protocol than this app (its machine configuration is 72 bytes; this app expects 84). Update the firmware.',
    );
    expect(schemaMismatchMessage({ ...shorter, actual: 96 }, '0.16')).toBe(
      'Firmware 0.16 uses a newer protocol than this app (its machine configuration is 96 bytes; this app expects 84). Update the app.',
    );
    expect(schemaMismatchMessage(shorter, null)).toMatch(/^The connected firmware uses an older protocol/);
  },
);
