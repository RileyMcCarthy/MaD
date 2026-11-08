import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  FLASH_ON_CONTROL_PORT,
  flashWithSession,
  RECONNECT_SETTLE_MS,
  type FlashWithSessionDeps,
} from './flashWithSession';

interface FakePort {
  name: string;
}

/** Plain fakes for every side effect, recording the order they ran in. */
function harness(opts: { held: 'control' | 'flash' | 'none'; programFails?: boolean; closeFails?: boolean }) {
  const calls: string[] = [];
  const target: FakePort = { name: 'flash' };
  const control: FakePort = { name: 'control' };
  const warnings: { tag: string; data?: Record<string, unknown> }[] = [];
  const outcome: { done?: number; error?: unknown } = {};
  const flashError = new Error('no response from the boot ROM');
  const deps: FlashWithSessionDeps<FakePort, number> = {
    heldPort: opts.held === 'flash' ? target : opts.held === 'control' ? control : null,
    target,
    targetLabel: 'USB 0403:6015',
    disconnect: async () => {
      calls.push('disconnect');
    },
    program: async (port) => {
      calls.push(`program:${port.name}`);
      if (opts.programFails) throw flashError;
      return 4592;
    },
    closePort: async (port) => {
      calls.push(`close:${port.name}`);
      return !opts.closeFails;
    },
    connect: async (port) => {
      calls.push(`connect:${port.name}`);
    },
    wait: async (ms) => {
      calls.push(`wait:${ms}`);
    },
    log: {
      warn: (tag, _msg, data) => {
        warnings.push({ tag, data });
      },
    },
    onDone: (result) => {
      calls.push('done');
      outcome.done = result;
    },
    onError: (err) => {
      calls.push('error');
      outcome.error = err;
    },
  };
  return { deps, calls, warnings, outcome, flashError };
}

describe('flashWithSession', () => {
  behaviour(
    {
      id: 'flash.control-session-reconnected-to-control-port',
      covers: 'src/firmware/flashWithSession.ts#flashWithSession',
      given: 'a successful flash over the programming port while the app is connected through the control port',
      expect: {
        'session-stopped-first': 'the control connection is stopped before the flash starts',
        'port-closed': 'the programming port is closed after the flash',
        'reconnected-to-control': 'after a settle delay the app reconnects through the control port, without a chooser',
      },
      why: {
        'session-stopped-first': 'the flash reboots the machine, so the control connection would only see silence',
        'reconnected-to-control':
          'the firmware answers only on the control port; reopening the programming port would reset the machine again',
      },
    },
    async () => {
      const h = harness({ held: 'control' });
      await flashWithSession(h.deps);
      expect(h.calls).toEqual([
        'disconnect',
        'program:flash',
        'close:flash',
        'done',
        `wait:${RECONNECT_SETTLE_MS}`,
        'connect:control',
      ]);
      expect(h.outcome.done).toBe(4592);
      expect(h.warnings).toEqual([]);
    },
  );

  behaviour(
    {
      id: 'flash.control-session-reconnected-after-failure',
      covers: 'src/firmware/flashWithSession.ts#flashWithSession',
      given: 'a failed flash over the programming port while the app is connected through the control port',
      expect: {
        'port-closed': 'the programming port is still closed',
        'reconnected-to-control': 'the app still reconnects through the control port',
        'error-surfaced': 'the flash error is reported, and the flash is not reported as done',
      },
      why: {
        'reconnected-to-control':
          'the board keeps the firmware it had, and a failed flash is when the operator most needs to see what it is doing',
      },
    },
    async () => {
      const h = harness({ held: 'control', programFails: true });
      await flashWithSession(h.deps);
      expect(h.calls).toEqual([
        'disconnect',
        'program:flash',
        'close:flash',
        'error',
        `wait:${RECONNECT_SETTLE_MS}`,
        'connect:control',
      ]);
      expect(h.outcome.error).toBe(h.flashError);
      expect(h.outcome.done).toBeUndefined();
    },
  );

  behaviour(
    {
      id: 'flash.unconnected-flash-opens-nothing-else',
      covers: 'src/firmware/flashWithSession.ts#flashWithSession',
      given: 'a flash over the programming port while the app is not connected',
      expect: {
        'no-connection-opened': 'the app opens no connection afterwards, whether the flash worked or not',
        'port-closed': 'the programming port is closed after the flash',
      },
      why: {
        'no-connection-opened':
          'the port just flashed is the programming port, and opening it again would reset the machine; the operator connects through the control port',
      },
    },
    async () => {
      for (const programFails of [false, true]) {
        const h = harness({ held: 'none', programFails });
        await flashWithSession(h.deps);
        expect(h.calls).not.toContain('disconnect');
        expect(h.calls.some((c) => c.startsWith('connect:'))).toBe(false);
        expect(h.calls).toContain('close:flash');
      }
    },
  );

  behaviour(
    {
      id: 'flash.control-port-refused',
      covers: 'src/firmware/flashWithSession.ts#flashWithSession',
      given: 'a flash aimed at the port the control connection holds',
      expect: {
        'refused-untouched': 'the flash is refused before the connection, the port or the board is touched',
        'says-disconnect': 'the refusal tells the operator to disconnect first, then flash',
        'says-programming-port': 'the refusal tells the operator to flash through the programming port on J1',
      },
      why: {
        'says-disconnect':
          'a machine on firmware 0.14 or earlier is connected through its programming port, and disconnecting is how its operator upgrades it',
      },
    },
    async () => {
      const h = harness({ held: 'flash' });
      await flashWithSession(h.deps);
      expect(h.calls).toEqual(['error']);
      expect((h.outcome.error as Error).message).toBe(FLASH_ON_CONTROL_PORT);
      expect(FLASH_ON_CONTROL_PORT).toMatch(/disconnect on the Connect page, then flash/);
      expect(FLASH_ON_CONTROL_PORT).toMatch(/J1/);
    },
  );

  behaviour(
    {
      id: 'flash.port-left-open-warned',
      covers: 'src/firmware/flashWithSession.ts#flashWithSession',
      given: 'a flash whose port will not close afterwards',
      expect: {
        'warning-logged': 'a port-left-open warning naming the port is logged',
      },
      why: {
        'warning-logged': 'a port this page keeps open blocks the next connect, and the log is the only place that says why',
      },
    },
    async () => {
      const h = harness({ held: 'control', closeFails: true });
      await flashWithSession(h.deps);
      expect(h.warnings).toEqual([{ tag: 'port-left-open', data: { port: 'USB 0403:6015' } }]);
      // The flash itself still worked, and the session still comes back.
      expect(h.outcome.done).toBe(4592);
      expect(h.calls).toContain('connect:control');
    },
  );
});
