import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { FaultedReason, RestrictedReason, type MachineState } from './types';
import { machineStatus } from './machineStatus';

const ready: MachineState = {
  faultedReason: FaultedReason.NONE,
  restrictedReason: RestrictedReason.NONE,
  testRunning: false,
  motionEnabled: true,
};

describe('Live machine status', () => {
  behaviour(
    {
      id: 'machine-status.unknown-locks-everything',
      covers: 'src/domain/machineStatus.ts#machineStatus',
      given: 'the app has connected but the machine has not yet reported its state',
      expect: {
        'says-waiting': 'the screen says it is waiting for the machine',
        'move-locked': 'jog and home are locked',
        'zero-locked': 'zero force and zero length are locked',
      },
      why: { 'move-locked': 'the gantry could already be moving, and a guess about its state is unsafe' },
    },
    () => {
      const s = machineStatus(null);
      expect(s.tone).toBe('unknown');
      expect(s.title.toLowerCase()).toContain('waiting');
      expect(s.canMove).toBe(false);
      expect(s.canZero).toBe(false);
    },
  );

  behaviour(
    {
      id: 'machine-status.motion-off-asks-for-enable',
      covers: 'src/domain/machineStatus.ts#machineStatus',
      given: 'a healthy, idle machine with motion turned off',
      expect: {
        'warn-tone': 'the status is shown in the warning colour',
        'says-enable': 'the next step it gives is to press Enable motion',
        'move-locked': 'jog and home are locked, with "enable motion first" as the reason',
        'zero-allowed': 'zero force and zero length stay available',
      },
      why: {
        'move-locked': 'the machine discards any move it receives while motion is off, so a jog would silently do nothing',
        'zero-allowed': 'zeroing does not move the gantry',
      },
    },
    () => {
      const s = machineStatus({ ...ready, motionEnabled: false });
      expect(s.tone).toBe('off');
      expect(s.detail).toContain('Enable motion');
      expect(s.canMove).toBe(false);
      expect(s.moveBlockedReason?.toLowerCase()).toContain('enable motion');
      expect(s.canZero).toBe(true);
    },
  );

  behaviour(
    {
      id: 'machine-status.fault-names-cause',
      covers: 'src/domain/machineStatus.ts#machineStatus',
      given: 'an idle machine stopped by a gantry stall',
      expect: {
        'fault-tone': 'the status is shown in the fault colour',
        'names-fault': 'the headline names the stall as the fault',
        'gives-remedy': 'the next step is the stall\'s own remedy',
        'move-locked': 'jog and home are locked',
      },
    },
    () => {
      const s = machineStatus({ ...ready, motionEnabled: false, faultedReason: FaultedReason.SERVO_STALL });
      expect(s.tone).toBe('fault');
      expect(s.title).toContain('SERVO_STALL');
      expect(s.detail).toContain('disable and re-enable motion');
      expect(s.canMove).toBe(false);
    },
  );

  behaviour(
    {
      id: 'machine-status.fault-outranks-motion-off',
      covers: 'src/domain/machineStatus.ts#machineStatus',
      given: 'a faulted machine, which also reports motion as off',
      expect: {
        'fault-shown': 'the screen shows the fault as the machine\'s status',
      },
      why: { 'fault-shown': 'enabling motion cannot work until the fault is dealt with' },
    },
    () => {
      expect(machineStatus({ ...ready, motionEnabled: false, faultedReason: FaultedReason.ESD_POWER }).tone).toBe('fault');
    },
  );

  behaviour(
    {
      id: 'machine-status.test-running-locks-manual',
      covers: 'src/domain/machineStatus.ts#machineStatus',
      given: 'a machine running a test',
      expect: {
        'points-to-stop': 'the next step it gives is STOP',
        'move-locked': 'jog and home are locked',
        'zero-locked': 'zero force and zero length are locked',
      },
    },
    () => {
      const s = machineStatus({ ...ready, testRunning: true });
      expect(s.tone).toBe('test');
      expect(s.detail).toContain('STOP');
      expect(s.canMove).toBe(false);
      expect(s.canZero).toBe(false);
    },
  );

  behaviour(
    {
      id: 'machine-status.restricted-still-moves',
      covers: 'src/domain/machineStatus.ts#machineStatus',
      given: 'a machine with motion on whose upper endstop is pressed',
      expect: {
        'warn-tone': 'the status is shown in the warning colour and names the upper endstop',
        'reduced-speed': 'it explains that the gantry moves at reduced speed',
        'move-allowed': 'jog and home stay available',
      },
      why: { 'move-allowed': 'a restricted machine still moves, only slower, so the operator can drive off the endstop' },
    },
    () => {
      const s = machineStatus({ ...ready, restrictedReason: RestrictedReason.UPPER_ENDSTOP });
      expect(s.tone).toBe('restricted');
      expect(s.title).toContain('UPPER_ENDSTOP');
      expect(s.detail).toContain('reduced speed');
      expect(s.canMove).toBe(true);
    },
  );

  behaviour(
    {
      id: 'machine-status.ready',
      covers: 'src/domain/machineStatus.ts#machineStatus',
      given: 'a healthy, idle, unrestricted machine with motion on',
      expect: {
        'ready-tone': 'the status reads Ready in the go colour',
        'all-allowed': 'jog, home and zeroing are all available',
      },
    },
    () => {
      const s = machineStatus(ready);
      expect(s.tone).toBe('ready');
      expect(s.title).toBe('Ready');
      expect(s.canMove && s.canZero).toBe(true);
    },
  );
});
