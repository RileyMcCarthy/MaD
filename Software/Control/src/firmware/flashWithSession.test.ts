import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { flashWithSession, RECONNECT_SETTLE_MS, type FlashWithSessionDeps } from './flashWithSession';

interface FakePort {
  name: string;
}

/** Plain fakes for every side effect, recording the order they ran in. */
function harness(opts: { shared: boolean; programFails?: boolean; closeFails?: boolean }) {
  const calls: string[] = [];
  const target: FakePort = { name: 'flash' };
  const other: FakePort = { name: 'session' };
  const warnings: { tag: string; data?: Record<string, unknown> }[] = [];
  const outcome: { done?: number; error?: unknown } = {};
  const flashError = new Error('no response from the boot ROM');
  const deps: FlashWithSessionDeps<FakePort, number> = {
    heldPort: opts.shared ? target : other,
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
      id: 'flash.shared-port-handed-back',
      covers: 'src/firmware/flashWithSession.ts#flashWithSession',
      given: 'a flash over the same port the main connection holds, which succeeds',
      expect: {
        'session-disconnected-first': 'the main connection is disconnected before the flash starts',
        'port-closed': 'the flash port is closed after the flash',
        'reconnected-same-port': 'after a settle delay the main connection reconnects to that same port, without a chooser',
      },
      why: {
        'reconnected-same-port': 'a flash must never leave the operator disconnected or asking which port to use',
      },
    },
    async () => {
      const h = harness({ shared: true });
      await flashWithSession(h.deps);
      expect(h.calls).toEqual([
        'disconnect',
        'program:flash',
        'close:flash',
        'done',
        `wait:${RECONNECT_SETTLE_MS}`,
        'connect:flash',
      ]);
      expect(h.outcome.done).toBe(4592);
      expect(h.warnings).toEqual([]);
    },
  );

  behaviour(
    {
      id: 'flash.shared-port-handed-back-after-failure',
      covers: 'src/firmware/flashWithSession.ts#flashWithSession',
      given: 'a flash over the same port the main connection holds, which fails',
      expect: {
        'port-closed': 'the flash port is still closed',
        'reconnected-same-port': 'the main connection still reconnects to that same port',
        'error-surfaced': 'the flash error is reported, and the flash is not reported as done',
      },
      why: {
        'reconnected-same-port': 'a failed flash is when the operator most needs the connection back to see what the board is doing',
      },
    },
    async () => {
      const h = harness({ shared: true, programFails: true });
      await flashWithSession(h.deps);
      expect(h.calls).toEqual([
        'disconnect',
        'program:flash',
        'close:flash',
        'error',
        `wait:${RECONNECT_SETTLE_MS}`,
        'connect:flash',
      ]);
      expect(h.outcome.error).toBe(h.flashError);
      expect(h.outcome.done).toBeUndefined();
    },
  );

  behaviour(
    {
      id: 'flash.separate-adapter-leaves-session-alone',
      covers: 'src/firmware/flashWithSession.ts#flashWithSession',
      given: 'a flash over a separate programming adapter while the main connection holds another port',
      expect: {
        'session-untouched': 'the main connection is neither disconnected nor reconnected',
        'port-closed': 'the flash port is still closed after the flash',
      },
      why: {
        'session-untouched':
          'on a bench that runs the MadEdge build, the protocol has its own adapter on P53/P55, and a running session there must keep running',
      },
    },
    async () => {
      for (const programFails of [false, true]) {
        const h = harness({ shared: false, programFails });
        await flashWithSession(h.deps);
        expect(h.calls).not.toContain('disconnect');
        expect(h.calls.some((c) => c.startsWith('connect:'))).toBe(false);
        expect(h.calls.some((c) => c.startsWith('wait:'))).toBe(false);
        expect(h.calls).toContain('close:flash');
      }
    },
  );

  behaviour(
    {
      id: 'flash.port-left-open-warned',
      covers: 'src/firmware/flashWithSession.ts#flashWithSession',
      given: 'a flash whose port will not close afterwards',
      expect: {
        'warning-logged': 'a port-left-open warning naming the port is logged, rather than the failure being swallowed',
      },
      why: {
        'warning-logged': 'a port this page keeps open blocks the next connect, and the log is the only place that says why',
      },
    },
    async () => {
      const h = harness({ shared: true, closeFails: true });
      await flashWithSession(h.deps);
      expect(h.warnings).toEqual([{ tag: 'port-left-open', data: { port: 'USB 0403:6015' } }]);
      // The flash itself still worked, and the session still comes back.
      expect(h.outcome.done).toBe(4592);
      expect(h.calls).toContain('connect:flash');
    },
  );
});
