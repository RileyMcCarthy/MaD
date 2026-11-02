import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { firmwareForProtocol } from './check-firmware-protocol.mts';

describe('firmwareForProtocol', () => {
  behaviour(
    {
      id: 'release-order.firmware-speaks-app-protocol',
      covers: 'tools/check-firmware-protocol.mts#firmwareForProtocol',
      given: "a MaD Control release on protocol 2, with firmware 0.15 published speaking protocol 2",
      expect: { 'release-allowed': 'the app release goes ahead, naming the firmware that speaks its protocol' },
    },
    () => {
      const verdict = firmwareForProtocol([{ tag: 'firmware-v0.15', protocolVersion: 2 }], 2);
      expect(verdict.ok).toBe(true);
      expect(verdict.message).toContain('firmware-v0.15');
    },
  );

  behaviour(
    {
      id: 'release-order.no-firmware-for-app-protocol',
      covers: 'tools/check-firmware-protocol.mts#firmwareForProtocol',
      given: 'a MaD Control release on protocol 3, while the published firmware speaks only protocol 2',
      expect: {
        'release-refused': 'the app release is refused, saying to release the firmware first',
        'lists-what-exists': 'the refusal lists the protocol each published firmware release speaks',
      },
      why: {
        'release-refused':
          'the new app would refuse every machine as too old and have no firmware to offer, so firmware ships first after a protocol change',
      },
    },
    () => {
      const verdict = firmwareForProtocol([{ tag: 'firmware-v0.15', protocolVersion: 2 }], 3);
      expect(verdict.ok).toBe(false);
      expect(verdict.message).toContain('Release the firmware first');
      expect(verdict.message).toContain('firmware-v0.15 (protocol 2)');
    },
  );
});
