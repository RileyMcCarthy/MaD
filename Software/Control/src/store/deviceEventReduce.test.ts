/**
 * B4 — pure device-event reduction matrix.
 */
import { describe, it, expect } from 'vitest';
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
  it.each([
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
  ])('$e.kind patch', ({ e, expect: exp }) => {
    const p = reduceDeviceEvent(e, false);
    if (exp.hasSample) expect(p.sample).toEqual(sample);
    if (exp.hasState) expect(p.machineState?.motionEnabled).toBe(true);
    if (exp.firmwareVersion) expect(p.firmwareVersion).toBe(exp.firmwareVersion);
    if (exp.errorToast) expect(p.errorToast).toBe(exp.errorToast);
    if (exp.counters) expect(p.counters).toEqual(exp.counters);
    if (exp.counters === undefined && e.kind === 'ack') expect(p.counters).toBeUndefined();
    if (exp.notification) expect(p.notification?.Message).toBe('hi');
  });

  it('unexpected disconnect clears machineState and flags unexpected', () => {
    const p = reduceDeviceEvent({ kind: 'disconnected', reason: 'unplug' }, false);
    expect(p.machineState).toBeNull();
    expect(p.disconnect).toEqual({ reason: 'unplug', unexpected: true });
  });

  it('user disconnect is not unexpected', () => {
    const p = reduceDeviceEvent({ kind: 'disconnected' }, true);
    expect(p.disconnect?.unexpected).toBe(false);
  });
});

describe('B4 isResponding matrix', () => {
  const T = 2000;
  it.each([
    { now: 5000, last: 0, ok: false },
    { now: 5000, last: 4000, ok: true }, // 1000 < 2000
    { now: 5000, last: 3000, ok: false }, // 2000 not < 2000
    { now: 5000, last: 2999, ok: false },
    { now: 5000, last: 4500, ok: true },
  ])('now=$now last=$last → $ok', ({ now, last, ok }) => {
    expect(isResponding(now, last, T)).toBe(ok);
  });
});
