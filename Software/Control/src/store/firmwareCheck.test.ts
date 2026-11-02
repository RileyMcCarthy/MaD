import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { checkConnectedFirmware, type FirmwareCheckPatch } from './firmwareCheck';

const APP = 4;

/** A board answering the two reads as given; records what the check does. */
function board(answers: { version?: string; info?: { protocolVersion: number } | null | 'silent' }) {
  const blocks: Array<string | null> = [];
  const patches: FirmwareCheckPatch[] = [];
  const client = {
    readFirmwareVersion: async () => {
      if (answers.version === undefined) throw new Error('timeout');
      return answers.version;
    },
    readDeviceInfo: async () => {
      if (answers.info === 'silent') throw new Error('timeout');
      return answers.info ?? null;
    },
    setMotionBlock: (reason: string | null) => void blocks.push(reason),
  };
  const run = (isCurrent: () => boolean = () => true) =>
    checkConnectedFirmware({
      client,
      read: async (fn) => {
        try {
          return await fn();
        } catch {
          return undefined;
        }
      },
      isCurrent,
      apply: (p) => void patches.push(p),
      appProtocol: APP,
      minFirmware: null,
    });
  return { blocks, patches, run };
}

describe('checkConnectedFirmware', () => {
  behaviour(
    {
      id: 'firmware-check.other-protocol-blocks-motion',
      covers: 'src/store/firmwareCheck.ts#checkConnectedFirmware',
      given: 'a board connected whose firmware reports an older protocol than the app',
      expect: {
        'motion-blocked': "motion is blocked, with the operator's explanation as the reason",
        'verdict-published': "the screens are told the firmware's version, its protocol, and that it is too old",
      },
    },
    async () => {
      const b = board({ version: '0.14', info: { protocolVersion: APP - 1 } });
      await b.run();
      expect(b.blocks).toHaveLength(1);
      expect(b.blocks[0]).toContain('too old');
      expect(b.patches).toEqual([
        { firmwareVersion: '0.14' },
        {
          firmwareCompat: { kind: 'firmwareTooOld', deviceProtocol: APP - 1, appProtocol: APP },
          deviceProtocol: APP - 1,
        },
      ]);
    },
  );

  behaviour(
    {
      id: 'firmware-check.refused-blocks-motion',
      covers: 'src/store/firmwareCheck.ts#checkConnectedFirmware',
      given: 'a board connected whose firmware refuses to say which protocol it speaks',
      expect: {
        'too-old-and-blocked': 'the firmware is reported as too old, reporting no protocol, and motion is blocked',
      },
    },
    async () => {
      const b = board({ version: '0.13', info: null });
      await b.run();
      expect(b.blocks[0]).toContain('too old');
      expect(b.patches.at(-1)).toEqual({
        firmwareCompat: { kind: 'firmwareTooOld', deviceProtocol: null, appProtocol: APP },
        deviceProtocol: null,
      });
    },
  );

  behaviour(
    {
      id: 'firmware-check.matching-protocol-unblocks',
      covers: 'src/store/firmwareCheck.ts#checkConnectedFirmware',
      given: "a board connected whose firmware reports the app's protocol",
      expect: {
        'motion-unblocked': 'any earlier motion block is lifted',
        'verdict-ok': 'the screens are told the firmware matches',
      },
    },
    async () => {
      const b = board({ version: '0.15', info: { protocolVersion: APP } });
      await b.run();
      expect(b.blocks).toEqual([null]);
      expect(b.patches.at(-1)).toEqual({ firmwareCompat: { kind: 'ok' }, deviceProtocol: APP });
    },
  );

  behaviour(
    {
      id: 'firmware-check.silent-board-no-verdict',
      covers: 'src/store/firmwareCheck.ts#checkConnectedFirmware',
      given: 'a board connected that never answers the question about its protocol',
      expect: {
        'no-verdict': 'no verdict is shown, and motion is not blocked',
      },
      why: {
        'no-verdict':
          'a board that answers nothing has a broken link, which the responding indicator already shows; a guess must not lock out a working machine',
      },
    },
    async () => {
      const b = board({ version: '0.15', info: 'silent' });
      await b.run();
      expect(b.blocks).toEqual([null]);
      expect(b.patches.at(-1)).toEqual({ firmwareCompat: null, deviceProtocol: null });
    },
  );

  behaviour(
    {
      id: 'firmware-check.replaced-connection-ignored',
      covers: 'src/store/firmwareCheck.ts#checkConnectedFirmware',
      given: 'a firmware check whose connection was replaced by a newer one before the board answered',
      expect: { 'nothing-changed': 'the check neither blocks motion nor changes what the screens show' },
    },
    async () => {
      const b = board({ version: '0.13', info: null });
      await b.run(() => false);
      expect(b.blocks).toEqual([]);
      expect(b.patches).toEqual([]);
    },
  );
});
