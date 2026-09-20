/**
 * B4 — pure device-event reduction matrix.
 */
import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { reduceDeviceEvent, isResponding } from './deviceEventReduce';
import type { DeviceEvent } from '@/device/events';
import { FaultedReason, RestrictedReason, NotificationType } from '@/domain';

const sample = {
  'Machine Force (N)': 1,
  'Machine Position (mm)': 2,
  'Machine Setpoint (mm)': 2,
  'Sample Force (N)': 0.5,
  'Sample Position (mm)': 1,
};

describe('B4 reduceDeviceEvent matrix', () => {
  behaviour(
    {
      id: 'live.device-events-patch-the-store',
      covers: 'src/store/deviceEventReduce.ts#reduceDeviceEvent',
      given: 'inbound events for a live sample, machine state, firmware version, device error, timeout, refused command, accepted command, and firmware warning',
      expect: {
        'sample-kept': 'the live sample is kept',
        'state-kept': 'the machine state is kept',
        'version-kept': 'the firmware version is kept',
        'warning-kept': 'the firmware warning is kept',
        'error-toast': 'the device error raises a toast naming it',
        'failures-counted': 'the error, timeout and refusal each add a count',
        'accepted-not-counted': 'the accepted command adds no count',
      },
    },
    () => {
      for (const { e, expect: exp } of [
        {
          e: { kind: 'sample', data: sample } as DeviceEvent,
          expect: { hasSample: true },
        },
        {
          e: {
            kind: 'state',
            data: {
              faultedReason: FaultedReason.NONE,
              restrictedReason: RestrictedReason.NONE,
              testRunning: false,
              motionEnabled: true,
            },
          } as DeviceEvent,
          expect: { hasState: true },
        },
        {
          e: { kind: 'firmwareVersion', data: { version: '1.2.3' } } as DeviceEvent,
          expect: { firmwareVersion: '1.2.3' },
        },
        {
          e: { kind: 'error', message: 'boom' } as DeviceEvent,
          expect: { errorToast: 'Device error: boom', counters: ['device-error'] },
        },
        {
          e: { kind: 'timeout' } as DeviceEvent,
          expect: { counters: ['timeout'] },
        },
        {
          e: { kind: 'ack', command: 3, success: false } as DeviceEvent,
          expect: { counters: ['nack'] },
        },
        {
          e: { kind: 'ack', command: 3, success: true } as DeviceEvent,
          expect: { counters: undefined },
        },
        {
          e: {
            kind: 'notification',
            data: { Type: NotificationType.WARN, Message: 'hi' },
          } as DeviceEvent,
          expect: { notification: true },
        },
      ]) {
        const p = reduceDeviceEvent(e, false);
        if (exp.hasSample) expect(p.sample).toEqual(sample);
        if (exp.hasState) expect(p.machineState?.motionEnabled).toBe(true);
        if (exp.firmwareVersion) expect(p.firmwareVersion).toBe(exp.firmwareVersion);
        if (exp.errorToast) expect(p.errorToast).toBe(exp.errorToast);
        if (exp.counters) expect(p.counters).toEqual(exp.counters);
        if (exp.counters === undefined && e.kind === 'ack') expect(p.counters).toBeUndefined();
        if (exp.notification) expect(p.notification?.Message).toBe('hi');
      }
    },
  );

  behaviour(
    {
      id: 'live.unplug-clears-machine-state',
      covers: 'src/store/deviceEventReduce.ts#reduceDeviceEvent',
      given: 'the machine disconnecting because the cable was unplugged, without the operator having asked',
      expect: {
        'state-cleared': 'the live machine state is cleared',
        'unexpected-disconnect': 'the disconnect is recorded as unexpected, naming the unplug as its reason',
      },
      why: { 'state-cleared': 'a lost connection must not keep showing a live machine state' },
    },
    () => {
      const p = reduceDeviceEvent({ kind: 'disconnected', reason: 'unplug' }, false);
      expect(p.machineState).toBeNull();
      expect(p.disconnect).toEqual({ reason: 'unplug', unexpected: true });
    },
  );

  behaviour(
    {
      id: 'live.operator-disconnect-is-expected',
      covers: 'src/store/deviceEventReduce.ts#reduceDeviceEvent',
      given: 'the operator disconnecting from the machine',
      expect: {
        'expected-disconnect': 'the disconnect is recorded as an expected one, so no lost-link error is raised',
      },
    },
    () => {
      const p = reduceDeviceEvent({ kind: 'disconnected' }, true);
      expect(p.disconnect?.unexpected).toBe(false);
    },
  );
});

describe('B4 isResponding matrix', () => {
  const T = 2000;
  behaviour(
    {
      id: 'live.responding-means-a-recent-sample',
      covers: 'src/store/deviceEventReduce.ts#isResponding',
      given: 'a two-second silence window, with the last sample at various ages, including none at all',
      expect: {
        'within-window': 'the machine counts as responding only while the last sample is younger than the window',
        'no-sample-silent': 'the machine never counts as responding without a sample',
      },
    },
    () => {
      for (const { now, last, ok } of [
        { now: 5000, last: 0, ok: false },
        { now: 5000, last: 4000, ok: true }, // 1000 < 2000
        { now: 5000, last: 3000, ok: false }, // 2000 not < 2000
        { now: 5000, last: 2999, ok: false },
        { now: 5000, last: 4500, ok: true },
      ]) {
        expect(isResponding(now, last, T)).toBe(ok);
      }
    },
  );
});
