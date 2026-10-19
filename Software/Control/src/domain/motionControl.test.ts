import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { FaultedReason, RestrictedReason, type MachineState } from './types';
import { motionButton } from './motionControl';

const idle: MachineState = {
  faultedReason: FaultedReason.NONE,
  restrictedReason: RestrictedReason.NONE,
  testRunning: false,
  motionEnabled: false,
};

describe('Live motion button', () => {
  behaviour(
    {
      id: 'motion-button.stall-offers-disable',
      covers: 'src/domain/motionControl.ts#motionButton',
      given: 'a machine stopped by a gantry stall, which reports motion as off',
      expect: {
        'sends-disable': 'the motion button asks the machine to turn motion off',
        'says-clear': 'the button says it clears the stall',
      },
      why: {
        'sends-disable': 'the machine refuses to enable motion while faulted, and only a request to turn motion off clears a stall',
      },
    },
    () => {
      const button = motionButton({ ...idle, faultedReason: FaultedReason.SERVO_STALL });
      expect(button.enable).toBe(false);
      expect(button.label.toLowerCase()).toContain('clear stall');
    },
  );

  behaviour(
    {
      id: 'motion-button.any-fault-offers-disable',
      covers: 'src/domain/motionControl.ts#motionButton',
      given: 'a machine stopped by any fault, which reports motion as off',
      expect: {
        'sends-disable': 'the motion button asks the machine to turn motion off',
      },
      why: {
        'sends-disable': 'the machine keeps an earlier request for motion through a fault, and motion would come back by itself when the fault clears',
      },
    },
    () => {
      const faults = Object.values(FaultedReason).filter(
        (v): v is FaultedReason => typeof v === 'number' && v !== FaultedReason.NONE,
      );
      expect(faults.length).toBeGreaterThanOrEqual(9);
      for (const f of faults) {
        expect(motionButton({ ...idle, faultedReason: f }).enable, FaultedReason[f]).toBe(false);
      }
    },
  );

  behaviour(
    {
      id: 'motion-button.healthy-toggles',
      covers: 'src/domain/motionControl.ts#motionButton',
      given: 'a machine with no fault',
      expect: {
        'off-offers-enable': 'with motion off, the button asks for motion on',
        'on-offers-disable': 'with motion on, the button asks for motion off',
      },
    },
    () => {
      expect(motionButton(idle)).toEqual({ enable: true, label: 'Enable motion' });
      expect(motionButton({ ...idle, motionEnabled: true })).toEqual({
        enable: false,
        label: 'Disable motion',
      });
    },
  );
});
