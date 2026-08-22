import { describe, it, expect, beforeEach } from 'vitest';
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
  it('renders zero-padded USB ids', () => {
    expect(describePort(fakePort(...FTDI))).toBe('USB 0403:6015');
  });

  it('falls back to a positional name when the adapter reports no ids', () => {
    expect(describePort(fakePort(), 2)).toBe('Serial device 3');
  });
});

describe('resolveFlashPort', () => {
  it('reports none when nothing has been granted', () => {
    expect(resolveFlashPort([], null)).toEqual({ kind: 'none' });
  });

  it('uses the only granted port without needing a preference', () => {
    const port = fakePort(...FTDI);
    expect(resolveFlashPort([port], null)).toMatchObject({
      kind: 'resolved',
      port,
      reason: 'only-port',
    });
  });

  it('refuses to guess between two ports with no preference', () => {
    const ports = [fakePort(...FTDI), fakePort(...CP210X)];
    expect(resolveFlashPort(ports, null)).toEqual({ kind: 'ambiguous', ports });
  });

  it('picks the port whose ids match the remembered one', () => {
    const ftdi = fakePort(...FTDI);
    const cp = fakePort(...CP210X);
    const got = resolveFlashPort([cp, ftdi], {
      vendorId: FTDI[0],
      productId: FTDI[1],
      index: 0,
    });
    expect(got).toMatchObject({ kind: 'resolved', port: ftdi, index: 1, reason: 'remembered' });
  });

  it('uses the recorded slot to break a tie between identical adapters', () => {
    const a = fakePort(...FTDI);
    const b = fakePort(...FTDI);
    const got = resolveFlashPort([a, b], { vendorId: FTDI[0], productId: FTDI[1], index: 1 });
    expect(got).toMatchObject({ kind: 'resolved', port: b, index: 1 });
  });

  it('asks rather than guessing when identical adapters no longer fill the recorded slot', () => {
    const a = fakePort(...FTDI);
    const b = fakePort(...FTDI);
    // Remembered slot 5, but only two ports are present.
    const got = resolveFlashPort([a, b], { vendorId: FTDI[0], productId: FTDI[1], index: 5 });
    expect(got.kind).toBe('ambiguous');
  });

  it('asks when the remembered device is simply not plugged in', () => {
    const got = resolveFlashPort([fakePort(...CP210X), fakePort(0x1a86, 0x7523)], {
      vendorId: FTDI[0],
      productId: FTDI[1],
      index: 0,
    });
    expect(got.kind).toBe('ambiguous');
  });

  it('never guesses from a preference that carries no ids', () => {
    const ports = [fakePort(...FTDI), fakePort(...CP210X)];
    expect(resolveFlashPort(ports, { index: 0 }).kind).toBe('ambiguous');
  });
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

  it('round-trips a choice', () => {
    rememberFlashPort(fakePort(...FTDI), 3);
    expect(readFlashPortPref()).toEqual({ vendorId: 0x0403, productId: 0x6015, index: 3 });
  });

  it('forgets on request', () => {
    rememberFlashPort(fakePort(...FTDI), 0);
    forgetFlashPort();
    expect(readFlashPortPref()).toBeNull();
  });

  it('survives corrupt storage rather than throwing', () => {
    localStorage.setItem('mad.flashPort', '{not json');
    expect(readFlashPortPref()).toBeNull();
  });
});

describe('validateFirmwareFile', () => {
  it('accepts a plausible image', () => {
    expect(validateFirmwareFile(300_000)).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(validateFirmwareFile(0)).toMatch(/empty/i);
  });

  it('rejects anything larger than hub RAM', () => {
    expect(validateFirmwareFile(MAX_IMAGE_BYTES + 1)).toMatch(/hub RAM/i);
    expect(validateFirmwareFile(MAX_IMAGE_BYTES)).toBeNull();
  });
});
