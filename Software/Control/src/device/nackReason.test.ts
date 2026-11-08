import { expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { NACK_REASON } from '@/protocol/generated/protoemb';
import { nackReasonName, nackReasonText } from './nackReason';

behaviour(
  {
    id: 'session.nack-reason-in-words',
    covers: 'src/device/nackReason.ts#nackReasonText',
    given: 'refusals from the board carrying the wrong-size reason, a reason this app has no name for, and no reason at all',
    expect: {
      'known-named': 'a reason the protocol defines is shown by its name and what it means',
      'unknown-shown-as-code': 'a reason the protocol does not define is shown as its code in hex',
      'missing-said': 'a refusal without a reason says that no reason was given',
    },
    why: {
      'unknown-shown-as-code': 'firmware newer than the app can add reasons, and the code still lets someone look it up',
    },
  },
  () => {
    expect(nackReasonName(NACK_REASON.BAD_SIZE)).toBe('BAD_SIZE');
    expect(nackReasonText(NACK_REASON.BAD_SIZE)).toBe('BAD_SIZE: The payload is not the size this command takes.');
    expect(nackReasonText(0xee)).toBe('reason 0xee');
    expect(nackReasonText(undefined)).toBe('no reason given');
  },
);
