import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { CONTROL_PORT_HINT, matchControlPort, portMatchesUsbId, PROGRAMMING_PORT_HINT } from './controlPort';

const fakePort = (usbVendorId?: number, usbProductId?: number) =>
  ({ getInfo: () => ({ usbVendorId, usbProductId }) }) as unknown as SerialPort;

const FT232R = [0x0403, 0x6001] as const;
const FT231X = [0x0403, 0x6015] as const;

describe('portMatchesUsbId', () => {
  behaviour(
    {
      id: 'connect.port-matches-remembered-usb-id',
      covers: 'src/device/controlPort.ts#portMatchesUsbId',
      given: 'a remembered USB vendor and product id, and adapters with and without that id',
      expect: {
        'same-id-matches': 'an adapter reporting both remembered ids matches',
        'other-product-differs': 'an adapter from the same vendor with another product id does not',
        'nothing-remembered': 'with no vendor remembered, no adapter matches, not even one that reports no id',
      },
    },
    () => {
      const id = { vendorId: FT231X[0], productId: FT231X[1] };
      expect(portMatchesUsbId(fakePort(...FT231X), id)).toBe(true);
      expect(portMatchesUsbId(fakePort(...FT232R), id)).toBe(false);
      expect(portMatchesUsbId(fakePort(), {})).toBe(false);
      expect(portMatchesUsbId(fakePort(...FT231X), null)).toBe(false);
    },
  );
});

describe('matchControlPort', () => {
  behaviour(
    {
      id: 'connect.control-port-remembered-id',
      covers: 'src/device/controlPort.ts#matchControlPort',
      given: 'a remembered control port id, with that adapter and a programming adapter of another id granted',
      expect: { 'control-chosen': 'the app reconnects to the adapter with the remembered id' },
    },
    () => {
      const control = fakePort(...FT232R);
      const ports = [fakePort(...FT231X), control];
      expect(matchControlPort(ports, { vendorId: FT232R[0], productId: FT232R[1] })).toBe(control);
    },
  );

  behaviour(
    {
      id: 'connect.control-port-ambiguous-left-to-user',
      covers: 'src/device/controlPort.ts#matchControlPort',
      given: 'a remembered control port id that two granted adapters share',
      expect: { 'user-chooses': 'the app opens neither on its own and leaves the choice to the operator' },
      why: {
        'user-chooses':
          'one of them may be the programming adapter on J1, and opening it restarts the machine, aborting a running test',
      },
    },
    () => {
      const ports = [fakePort(...FT231X), fakePort(...FT231X)];
      expect(matchControlPort(ports, { vendorId: FT231X[0], productId: FT231X[1] })).toBeNull();
    },
  );

  behaviour(
    {
      id: 'connect.control-port-without-id',
      covers: 'src/device/controlPort.ts#matchControlPort',
      given: 'a remembered control port that reported no USB id',
      expect: {
        'sole-port-taken': 'a sole granted port is reconnected to',
        'several-left-to-user': 'with two granted ports, neither is opened',
        'none-granted': 'with none granted, nothing is opened',
      },
    },
    () => {
      const one = fakePort();
      expect(matchControlPort([one], {})).toBe(one);
      expect(matchControlPort([one, fakePort()], null)).toBeNull();
      expect(matchControlPort([], null)).toBeNull();
    },
  );

  behaviour(
    {
      id: 'connect.port-hints-name-the-pins',
      covers: 'src/device/controlPort.ts#CONTROL_PORT_HINT',
      given: 'the Connect and Firmware screens telling the operator which adapter to use',
      expect: {
        'connect-names-control': 'the Connect screen asks for the adapter on P30/P32 and warns that J1 restarts the machine',
        'firmware-names-j1': 'the Firmware screen asks for the Prop Plug on J1 or the P2-EVAL USB',
      },
    },
    () => {
      expect(CONTROL_PORT_HINT).toMatch(/P30\/P32/);
      expect(CONTROL_PORT_HINT).toMatch(/J1.*restarts the machine/);
      expect(PROGRAMMING_PORT_HINT).toMatch(/J1/);
      expect(PROGRAMMING_PORT_HINT).toMatch(/P2-EVAL/);
    },
  );
});
