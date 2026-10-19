import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { closeFlashPort } from './closeFlashPort';

function port(open: boolean, closes: boolean) {
  const p = {
    readable: (open ? {} : null) as ReadableStream | null,
    writable: (open ? {} : null) as WritableStream | null,
    closeCalls: 0,
    async close() {
      p.closeCalls += 1;
      if (!closes) throw new DOMException('locked', 'InvalidStateError');
      p.readable = null;
      p.writable = null;
    },
  };
  return p;
}

describe('closeFlashPort', () => {
  behaviour(
    {
      id: 'flash.port-closed-after-flash',
      covers: 'src/firmware/closeFlashPort.ts#closeFlashPort',
      given: 'a flash whose loader gave up closing the port, leaving it open',
      expect: { 'closed-again': 'the port is closed and reported closed' },
      why: { 'closed-again': 'a port left open blocks the next connect and resets a P2-EVAL whenever it is reopened' },
    },
    async () => {
      const p = port(true, true);
      expect(await closeFlashPort(p)).toBe(true);
      expect(p.readable).toBeNull();
    },
  );

  behaviour(
    {
      id: 'flash.port-already-closed',
      covers: 'src/firmware/closeFlashPort.ts#closeFlashPort',
      given: 'a flash that closed its port cleanly',
      expect: { 'left-alone': 'the port is reported closed without another close' },
    },
    async () => {
      const p = port(false, true);
      expect(await closeFlashPort(p)).toBe(true);
      expect(p.closeCalls).toBe(0);
    },
  );

  behaviour(
    {
      id: 'flash.port-stuck-open-reported',
      covers: 'src/firmware/closeFlashPort.ts#closeFlashPort',
      given: 'a port that refuses to close',
      expect: { 'reported-open': 'the port is reported as still open' },
    },
    async () => {
      expect(await closeFlashPort(port(true, false))).toBe(false);
    },
  );
});
