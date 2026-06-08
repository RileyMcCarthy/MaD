jest.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

import BridgeHandler from './BridgeHandler';
import {
  FaultedReason,
  RestrictedReason,
  NotificationType,
  encodeMachineState,
  encodeNotification,
  MSG_READ_STATE,
} from '../generated/protoemb';
import {
  FaultedReason as SharedFaultedReason,
  RestrictedReason as SharedRestrictedReason,
  NotificationType as SharedNotificationType,
} from '@shared/SharedInterface';

describe('BridgeHandler protocol contracts', () => {
  test('maps machine state fault/restriction enums to shared state consistently', () => {
    const bridge = new BridgeHandler() as any;

    const protoState = {
      faultedReason: FaultedReason.WATCHDOG,
      restrictedReason: RestrictedReason.UPPER_ENDSTOP,
      testRunning: true,
      motionEnabled: false,
    };

    const payload = encodeMachineState(protoState);

    let emittedState: any = null;
    bridge.on('state', (state: unknown) => {
      emittedState = state;
    });

    bridge.handleDataEvent(MSG_READ_STATE, Array.from(payload));

    expect(emittedState).toBeTruthy();
    expect(emittedState.faultedReason).toBe(SharedFaultedReason.WATCHDOG);
    expect(emittedState.restrictedReason).toBe(
      SharedRestrictedReason.UPPER_ENDSTOP,
    );
    expect(emittedState.testRunning).toBe(true);
    expect(emittedState.motionEnabled).toBe(false);
  });

  test('maps firmware notification severities into renderer notification types', () => {
    const bridge = new BridgeHandler() as any;

    const cases: Array<{
      protoType: NotificationType;
      expected: SharedNotificationType;
    }> = [
      { protoType: NotificationType.MESSAGE, expected: SharedNotificationType.INFO },
      { protoType: NotificationType.INFO, expected: SharedNotificationType.INFO },
      { protoType: NotificationType.WARNING, expected: SharedNotificationType.WARN },
      { protoType: NotificationType.ERROR, expected: SharedNotificationType.ERROR },
      { protoType: NotificationType.SUCCESS, expected: SharedNotificationType.SUCCESS },
    ];

    for (const { protoType, expected } of cases) {
      let emitted: any = null;
      const listener = (notification: unknown) => {
        emitted = notification;
      };
      bridge.on('notification', listener);

      const payload = encodeNotification({
        type: protoType,
        message: `notif-${protoType}`,
      });

      bridge.handleNotificationEvent(Array.from(payload));

      expect(emitted).toBeTruthy();
      expect(emitted.Type).toBe(expected);
      expect(emitted.Message).toContain('notif-');

      bridge.removeListener('notification', listener);
    }
  });
});
