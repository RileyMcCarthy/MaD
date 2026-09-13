import { describe, expect, beforeEach } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  describePort,
  forgetFlashPort,
  readFlashPortPref,
  rememberFlashPort,
  resolveFlashPort,
  validateFirmwareFile,
  MAX_IMAGE_BYTES,
} from './portPref';

/** Minimal stand-in — resolution only ever consults getInfo(). */
const fakePort = (usbVendorId?: number, usbProductId?: number) =>
  ({ getInfo: () => ({ usbVendorId, usbProductId }) }) as unknown as SerialPort;

const FTDI = [0x0403, 0x6015] as const;
const CP210X = [0x10c4, 0xea60] as const;

describe('describePort', () => {
  behaviour(
    {
      id: 'flash.port-label-shows-usb-ids',
      covers: 'src/firmware/portPref.ts#describePort',
      given: 'a serial port whose adapter reports USB vendor 0403 and product 6015',
      expect: { 'usb-ids-shown': 'the port is labelled USB 0403:6015' },
    },
    () => {
      expect(describePort(fakePort(...FTDI))).toBe('USB 0403:6015');
    },
  );

  behaviour(
    {
      id: 'flash.port-label-without-usb-ids',
      covers: 'src/firmware/portPref.ts#describePort',
      given: 'a serial port whose adapter reports no USB identifiers, listed as the third device',
      expect: { 'device-number-shown': 'the port is labelled Serial device 3' },
    },
    () => {
      expect(describePort(fakePort(), 2)).toBe('Serial device 3');
    },
  );
});

describe('resolveFlashPort', () => {
  behaviour(
    {
      id: 'flash.port-none-when-ungranted',
      covers: 'src/firmware/portPref.ts#resolveFlashPort',
      given: 'no serial ports have been granted',
      expect: {
        'no-port-offered': 'no port is offered for the load, and the operator is not asked to choose',
      },
    },
    () => {
      expect(resolveFlashPort([], null)).toEqual({ kind: 'none' });
    },
  );

  behaviour(
    {
      id: 'flash.port-only-granted-is-used',
      covers: 'src/firmware/portPref.ts#resolveFlashPort',
      given: 'exactly one granted serial port and no remembered choice',
      expect: { 'only-port-used': 'that port is used for the load, with no prompt to choose' },
    },
    () => {
      const port = fakePort(...FTDI);
      expect(resolveFlashPort([port], null)).toMatchObject({
        kind: 'resolved',
        port,
        reason: 'only-port',
      });
    },
  );

  behaviour(
    {
      id: 'flash.port-two-without-preference-asks',
      covers: 'src/firmware/portPref.ts#resolveFlashPort',
      given: 'two granted serial ports and no remembered choice',
      expect: { 'operator-asked': 'the operator is asked to pick which port to program' },
      why: {
        'operator-asked': 'programming is destructive; choosing silently would load the wrong device',
      },
    },
    () => {
      const ports = [fakePort(...FTDI), fakePort(...CP210X)];
      expect(resolveFlashPort(ports, null)).toEqual({ kind: 'ambiguous', ports });
    },
  );

  behaviour(
    {
      id: 'flash.port-remembered-ids-selected',
      covers: 'src/firmware/portPref.ts#resolveFlashPort',
      given: 'two granted serial ports, and a remembered choice matching one adapter\'s USB identifiers',
      expect: {
        'remembered-adapter-used': 'that adapter is used for the load, whichever slot it now sits in',
      },
    },
    () => {
      const ftdi = fakePort(...FTDI);
      const cp = fakePort(...CP210X);
      const got = resolveFlashPort([cp, ftdi], {
        vendorId: FTDI[0],
        productId: FTDI[1],
        index: 0,
      });
      expect(got).toMatchObject({ kind: 'resolved', port: ftdi, index: 1, reason: 'remembered' });
    },
  );

  behaviour(
    {
      id: 'flash.port-identical-adapters-use-slot',
      covers: 'src/firmware/portPref.ts#resolveFlashPort',
      given: 'two identical adapters, with the remembered choice pointing at the second one',
      expect: {
        'remembered-slot-used': 'the second adapter is used for the load, with no prompt to choose',
      },
    },
    () => {
      const a = fakePort(...FTDI);
      const b = fakePort(...FTDI);
      const got = resolveFlashPort([a, b], { vendorId: FTDI[0], productId: FTDI[1], index: 1 });
      expect(got).toMatchObject({ kind: 'resolved', port: b, index: 1 });
    },
  );

  behaviour(
    {
      id: 'flash.port-missing-slot-asks',
      covers: 'src/firmware/portPref.ts#resolveFlashPort',
      given: 'two identical adapters, with the remembered choice pointing at a slot that is not present',
      expect: { 'operator-asked': 'the operator is asked to pick which adapter to program' },
    },
    () => {
      const a = fakePort(...FTDI);
      const b = fakePort(...FTDI);
      // Remembered slot 5, but only two ports are present.
      const got = resolveFlashPort([a, b], { vendorId: FTDI[0], productId: FTDI[1], index: 5 });
      expect(got.kind).toBe('ambiguous');
    },
  );

  behaviour(
    {
      id: 'flash.port-remembered-absent-asks',
      covers: 'src/firmware/portPref.ts#resolveFlashPort',
      given: 'two granted serial ports, neither matching the remembered adapter\'s USB identifiers',
      expect: { 'operator-asked': 'the operator is asked to pick which port to program' },
    },
    () => {
      const got = resolveFlashPort([fakePort(...CP210X), fakePort(0x1a86, 0x7523)], {
        vendorId: FTDI[0],
        productId: FTDI[1],
        index: 0,
      });
      expect(got.kind).toBe('ambiguous');
    },
  );

  behaviour(
    {
      id: 'flash.port-preference-without-ids-asks',
      covers: 'src/firmware/portPref.ts#resolveFlashPort',
      given: 'two granted serial ports and a remembered choice that has a slot but no USB identifiers',
      expect: { 'operator-asked': 'the operator is asked to pick which port to program' },
      why: { 'operator-asked': 'a slot index alone is not a stable identity for a serial port' },
    },
    () => {
      const ports = [fakePort(...FTDI), fakePort(...CP210X)];
      expect(resolveFlashPort(ports, { index: 0 }).kind).toBe('ambiguous');
    },
  );
});

describe('flash port preference storage', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  });

  behaviour(
    {
      id: 'flash.port-choice-round-trips',
      covers: 'src/firmware/portPref.ts#rememberFlashPort',
      given: 'a serial port remembered at slot 3',
      expect: {
        'ids-and-slot-returned':
          'reading the remembered choice returns that adapter\'s USB vendor and product identifiers and slot 3',
      },
    },
    () => {
      rememberFlashPort(fakePort(...FTDI), 3);
      expect(readFlashPortPref()).toEqual({ vendorId: 0x0403, productId: 0x6015, index: 3 });
    },
  );

  behaviour(
    {
      id: 'flash.port-choice-forgotten',
      covers: 'src/firmware/portPref.ts#forgetFlashPort',
      given: 'a remembered serial-port choice that the operator then forgets',
      expect: { 'nothing-remembered': 'reading the remembered choice afterwards returns nothing' },
    },
    () => {
      rememberFlashPort(fakePort(...FTDI), 0);
      forgetFlashPort();
      expect(readFlashPortPref()).toBeNull();
    },
  );

  behaviour(
    {
      id: 'flash.port-unreadable-choice-is-empty',
      covers: 'src/firmware/portPref.ts#readFlashPortPref',
      given: 'stored serial-port preference data that is not valid JSON',
      expect: { 'no-remembered-choice': 'reading it back gives no remembered choice' },
      why: {
        'no-remembered-choice': 'a corrupt preference must still let the operator pick a serial port',
      },
    },
    () => {
      localStorage.setItem('mad.flashPort', '{not json');
      expect(readFlashPortPref()).toBeNull();
    },
  );
});

describe('validateFirmwareFile', () => {
  behaviour(
    {
      id: 'flash.file-plausible-size-accepted',
      covers: 'src/firmware/portPref.ts#validateFirmwareFile',
      given: 'a 300,000-byte firmware file',
      expect: { 'file-accepted': 'the file is accepted for loading' },
    },
    () => {
      expect(validateFirmwareFile(300_000)).toBeNull();
    },
  );

  behaviour(
    {
      id: 'flash.file-empty-refused',
      covers: 'src/firmware/portPref.ts#validateFirmwareFile',
      given: 'an empty firmware file chosen by the operator',
      expect: { 'refused-as-empty': 'the file is refused as empty before the chip is reset' },
    },
    () => {
      expect(validateFirmwareFile(0)).toMatch(/empty/i);
    },
  );

  behaviour(
    {
      id: 'flash.file-larger-than-chip-memory-refused',
      covers: 'src/firmware/portPref.ts#validateFirmwareFile',
      given: 'a firmware file one byte over the Propeller 2\'s 512 KiB of hub RAM, and one of exactly 512 KiB',
      expect: {
        'over-limit-refused': 'the oversized file is refused for exceeding hub RAM',
        'exact-limit-accepted': 'the exactly-sized file is accepted',
      },
      why: {
        'over-limit-refused': 'the Propeller 2 has 512 KiB of hub memory; a larger file cannot be loaded',
      },
    },
    () => {
      expect(validateFirmwareFile(MAX_IMAGE_BYTES + 1)).toMatch(/hub RAM/i);
      expect(validateFirmwareFile(MAX_IMAGE_BYTES)).toBeNull();
    },
  );
});
