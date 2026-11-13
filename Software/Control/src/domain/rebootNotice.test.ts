import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { isRebootNotice } from './rebootNotice';

describe('reboot notice', () => {
  behaviour(
    {
      id: 'reboot-notice.profile-saved',
      covers: 'src/domain/rebootNotice.ts#isRebootNotice',
      given: 'the notification the firmware sends after saving the machine profile',
      expect: {
        'recognised': 'it is recognised as a request to reboot',
        'others-ignored': 'an unrelated notification is not',
      },
    },
    () => {
      expect(isRebootNotice('Machine profile saved to SD Card, please reboot\n')).toBe(true);
      expect(isRebootNotice('Test aborted: sample length limit')).toBe(false);
    },
  );
});
