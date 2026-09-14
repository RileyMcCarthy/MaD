/**
 * Codec contract: the generated browser-safe (Uint8Array/DataView) codec must
 * produce exact, stable wire bytes and round-trip values within the wire scale.
 *
 * We freeze GOLDEN byte vectors here (self-contained, CI-safe) so any unintended
 * change to the wire format is caught, and keep an INDEPENDENT bit-packer
 * reference for Move.
 */

import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import * as nu from './generated/protoemb';

const bytes = (b: Uint8Array): number[] => Array.from(b);

// Golden vectors captured from the verified codec. Regenerate intentionally only
// when the schema/template changes (and update docs/PARITY.md).
const GOLD = {
  state: [178, 0],
  sample: [217, 182, 241, 31, 9, 138, 102, 42, 147, 73, 176, 12],
  stored: [217, 182, 241, 31, 9, 72, 60, 0, 0, 138, 102],
  // MachineConfiguration (intrinsic load-cell constants) — MaDProtocol.yaml.
  config: [
    84, 101, 115, 116, 101, 114, 45, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200, 0, 0, 0, 144, 1,
    0, 0, 160, 134, 1, 0, 64, 66, 15, 0, 5, 0, 0, 0, 250, 0, 0, 0, 50, 0, 0, 0, 100, 0, 0, 0, 135, 214, 18, 0, 5, 0, 0,
    0, 2, 0, 0, 0, 3, 0, 0, 0,
  ],
  profile: [26, 162, 7, 0, 10, 0, 0, 0, 100, 0, 0, 0, 12, 0, 0, 0, 3, 0, 0, 0],
  move: [65, 225, 51, 224, 46, 0, 100, 0],
  // Derived by hand from the WaveformMove field table in MaDProtocol.yaml
  // (offset/width/scale per field), NOT captured from the encoder -- a golden
  // vector blessed from the thing it guards proves only self-consistency.
  waveform: [0, 80, 195, 0, 0, 9, 61, 48, 6, 0, 0, 0, 0, 0, 0, 0, 243, 1],
};

describe('codec golden byte vectors (frozen — guards the wire format)', () => {
  behaviour(
    {
      id: 'codec.machine-state-wire-bytes',
      covers: 'src/protocol/generated/protoemb.ts#encodeMachineState',
      given: 'a machine that is running a test with motion off, a watchdog fault, and a machine-tension restriction',
      expect: {
        'state-bytes': 'the whole state packs into the agreed 2 bytes on the wire',
      },
      why: { 'state-bytes': 'the app and the firmware must speak the same machine-state bytes' },
    },
    () => {
      expect(
        bytes(nu.encodeMachineState({ faultedReason: 2, restrictedReason: 3, testRunning: true, motionEnabled: false })),
      ).toEqual(GOLD.state);
    },
  );
  behaviour(
    {
      id: 'codec.sample-wire-bytes',
      covers: 'src/protocol/generated/protoemb.ts#encodeSample',
      given: 'a live sample of 12.345 N machine force, −50.5 mm position, and a 10 mm setpoint',
      expect: {
        'sample-bytes': 'the sample encodes to the agreed 12 bytes on the wire',
      },
      why: { 'sample-bytes': 'the app and the firmware must speak the same live-sample bytes' },
    },
    () => {
      expect(
        bytes(nu.encodeSample({ machineForce: 12.345, machinePosition: -50.5, machineSetpoint: 10.0, sampleForce: 3.21, samplePosition: 7.89 })),
      ).toEqual(GOLD.sample);
    },
  );
  behaviour(
    {
      id: 'codec.stored-sample-wire-bytes',
      covers: 'src/protocol/generated/protoemb.ts#encodeStoredSample',
      given: 'a stored sample of 12.345 N at −50.5 mm, 123456 time ticks, and a 10 mm setpoint',
      expect: {
        'stored-sample-bytes': 'the stored sample encodes to the agreed 11 bytes on the wire',
      },
      why: { 'stored-sample-bytes': 'the app and the firmware must speak the same stored-sample bytes' },
    },
    () => {
      expect(bytes(nu.encodeStoredSample({ force: 12.345, position: -50.5, time: 123456, setpoint: 10.0 }))).toEqual(
        GOLD.stored,
      );
    },
  );
  behaviour(
    {
      id: 'codec.machine-configuration-wire-bytes',
      covers: 'src/protocol/generated/protoemb.ts#encodeMachineConfiguration',
      given: 'a machine named Tester-1 with its load-cell, travel, and tensile limits',
      expect: {
        'config-bytes': 'the configuration encodes to the agreed 68 bytes on the wire',
      },
      why: { 'config-bytes': 'the app and the firmware must speak the same configuration bytes' },
    },
    () => {
      expect(
        bytes(
          nu.encodeMachineConfiguration({
            name: 'Tester-1',
            encoderStepsPerMM: 200,
            servoStepsPerMM: 400,
            loadCellCapacity: 100,
            loadCellSensitivity: 1000000,
            loadCellZeroBalance: 5,
            maxPosition: 250,
            maxVelocity: 50,
            maxAcceleration: 100,
            maxForceTensile: 1234.567,
            homingVelocity: 5,
            homingOffset: 2,
            jawOffset: 3,
          }),
        ),
      ).toEqual(GOLD.config);
    },
  );
  behaviour(
    {
      id: 'codec.sample-profile-wire-bytes',
      covers: 'src/protocol/generated/protoemb.ts#encodeSampleProfile',
      given: 'a sample profile of 500.25 N, 10 mm/s, 100 mm travel, 12 mm width and 3 mm thickness',
      expect: {
        'profile-bytes': 'the profile encodes to the agreed 20 bytes on the wire',
      },
      why: { 'profile-bytes': 'the app and the firmware must speak the same sample-profile bytes' },
    },
    () => {
      expect(
        bytes(nu.encodeSampleProfile({ maxForce: 500.25, maxVelocity: 10, maxDisplacement: 100, sampleWidth: 12, sampleThickness: 3 })),
      ).toEqual(GOLD.profile);
    },
  );
  behaviour(
    {
      id: 'codec.move-wire-bytes',
      covers: 'src/protocol/generated/protoemb.ts#encodeMove',
      given: 'a feed move of 12.5 mm at 3 mm/s with a 100 ms pause',
      expect: {
        'move-bytes': 'the move encodes to the agreed 8 bytes on the wire',
      },
      why: {
        'move-bytes':
          'the app and the firmware must speak the same move bytes, including the four-bit command field that carries G122',
      },
    },
    () => {
      expect(bytes(nu.encodeMove({ g: 1 as nu.GCode, x: 12.5, f: 3.0, p: 100 }))).toEqual(GOLD.move);
    },
  );
  behaviour(
    {
      id: 'codec.waveform-move-wire-bytes',
      covers: 'src/protocol/generated/protoemb.ts#encodeWaveformMove',
      given: 'a 5 mm, 2 Hz sine wave of 100 cycles is encoded as a waveform move',
      expect: {
        'waveform-bytes': 'the bytes match the agreed on-wire sequence exactly',
      },
      why: { 'waveform-bytes': 'the app and the firmware must speak the same waveform-move bytes' },
    },
    () => {
      expect(
        bytes(nu.encodeWaveformMove({ shape: nu.WaveformShape.SINE, amplitude: 5, frequency: 2, cycles: 100, dwellHigh: 0, dwellLow: 0, skewPerMille: 500 })),
      ).toEqual(GOLD.waveform);
    },
  );
});

describe('Move: independent bit-packer reference', () => {
  behaviour(
    {
      id: 'codec.move-matches-independent-packer',
      covers: 'src/protocol/generated/protoemb.ts#encodeMove',
      given: 'a feed move of 12.5 mm at 3 mm/s with a 100 ms pause, also packed by an independent least-significant-bit-first packer',
      expect: {
        'same-eight-bytes': 'the codec produces the same eight bytes as that packer\'s command, travel, speed, and pause fields',
      },
      why: {
        'same-eight-bytes': 'the move is bit-packed on the wire, so the field widths are the contract with the firmware',
      },
    },
    () => {
      // g[0..4) x[4..26) f[26..48) p[48..64), 8 bytes.
      const ref = new Uint8Array(8);
      const pack = (bitOff: number, bits: number, value: number) => {
        for (let i = 0; i < bits; i++) {
          if ((value >>> i) & 1) ref[(bitOff + i) >> 3] |= 1 << ((bitOff + i) & 7);
        }
      };
      const v = { g: 1 as nu.GCode, x: 12.5, f: 3.0, p: 100 };
      pack(0, 4, nu.GCODE_VALUE_TO_WIRE[v.g] ?? 0);
      pack(4, 22, Math.round((v.x - -200) * 1000));
      pack(26, 22, Math.round(v.f * 1000));
      pack(48, 16, v.p);
      expect(bytes(nu.encodeMove(v))).toEqual(bytes(ref));
    },
  );
});

describe('round-trip within scale precision', () => {
  behaviour(
    {
      id: 'codec.move-round-trip',
      covers: 'src/protocol/generated/protoemb.ts#decodeMove',
      given: 'a feed move of 12.5 mm at 3 mm/s with a 100 ms pause, encoded and then decoded',
      expect: {
        'travel-and-speed': 'the travel and speed come back to the thousandth',
        'pause-exact': 'the pause comes back exactly',
        'feed-command': 'the command still reads as a feed move',
      },
    },
    () => {
      const out = nu.decodeMove(nu.encodeMove({ g: 1 as nu.GCode, x: 12.5, f: 3.0, p: 100 }));
      expect(out.x).toBeCloseTo(12.5, 3);
      expect(out.f).toBeCloseTo(3.0, 3);
      expect(out.p).toBe(100);
      expect(nu.GCODE_VALUE_TO_WIRE[out.g]).toBe(1);
    },
  );
  behaviour(
    {
      id: 'codec.waveform-move-round-trip',
      covers: 'src/protocol/generated/protoemb.ts#decodeWaveformMove',
      given: 'a triangle wave of 12.345 mm at 0.5 Hz for 1000 cycles, encoded and then decoded',
      expect: {
        'shape-kept': 'the shape still reads as a triangle wave',
        'amplitude-and-frequency': 'the amplitude and frequency come back to the thousandth',
        'cycle-count': 'the cycle count comes back exactly',
      },
    },
    () => {
      const v = { shape: nu.WaveformShape.TRIANGLE, amplitude: 12.345, frequency: 0.5, cycles: 1000, dwellHigh: 0, dwellLow: 0, skewPerMille: 500 };
      const out = nu.decodeWaveformMove(nu.encodeWaveformMove(v));
      expect(out.shape).toBe(nu.WaveformShape.TRIANGLE);
      expect(out.amplitude).toBeCloseTo(12.345, 3);
      expect(out.frequency).toBeCloseTo(0.5, 3);
      expect(out.cycles).toBe(1000);
    },
  );
  behaviour(
    {
      id: 'codec.sample-round-trip',
      covers: 'src/protocol/generated/protoemb.ts#decodeSample',
      given: 'a live sample of 12.345 N, −50.5 mm, and a 10 mm setpoint, encoded and then decoded',
      expect: {
        'to-the-thousandth': 'machine force, machine position, and sample position all come back to the thousandth',
      },
    },
    () => {
      const v = { machineForce: 12.345, machinePosition: -50.5, machineSetpoint: 10.0, sampleForce: 3.21, samplePosition: 7.89 };
      const out = nu.decodeSample(nu.encodeSample(v));
      expect(out.machineForce).toBeCloseTo(v.machineForce, 3);
      expect(out.machinePosition).toBeCloseTo(v.machinePosition, 3);
      expect(out.samplePosition).toBeCloseTo(v.samplePosition, 3);
    },
  );
  behaviour(
    {
      id: 'codec.stored-sample-round-trip',
      covers: 'src/protocol/generated/protoemb.ts#decodeStoredSample',
      given: 'a stored sample of 12.345 N at −50.5 mm, 123456 time ticks, and a 10 mm setpoint, encoded and then decoded',
      expect: {
        'to-the-thousandth': 'force, position, and setpoint come back to the thousandth',
        'timestamp-exact': 'the timestamp comes back exactly',
      },
    },
    () => {
      const v = { force: 12.345, position: -50.5, time: 123456, setpoint: 10.0 };
      const out = nu.decodeStoredSample(nu.encodeStoredSample(v));
      expect(out.force).toBeCloseTo(v.force, 3);
      expect(out.position).toBeCloseTo(v.position, 3);
      expect(out.time).toBe(123456);
      expect(out.setpoint).toBeCloseTo(v.setpoint, 3);
    },
  );
  behaviour(
    {
      id: 'codec.machine-configuration-round-trip',
      covers: 'src/protocol/generated/protoemb.ts#decodeMachineConfiguration',
      given: 'a machine named Tester-1 with a 1234.567 N tensile limit and a 250 mm travel limit, encoded and then decoded',
      expect: {
        'name-and-limits': 'the name, travel limit, and load-cell constants come back exactly',
        'tensile-precision': 'the tensile limit comes back to the thousandth',
      },
    },
    () => {
      const v = {
        name: 'Tester-1',
        encoderStepsPerMM: 200,
        servoStepsPerMM: 400,
        loadCellCapacity: 100,
        loadCellSensitivity: 1000000,
        loadCellZeroBalance: 5,
        maxPosition: 250,
        maxVelocity: 50,
        maxAcceleration: 100,
        maxForceTensile: 1234.567,
        homingVelocity: 5,
        homingOffset: 2,
        jawOffset: 3,
      };
      const out = nu.decodeMachineConfiguration(nu.encodeMachineConfiguration(v));
      expect(out.name).toBe('Tester-1');
      expect(out.maxForceTensile).toBeCloseTo(1234.567, 3);
      expect(out.maxPosition).toBe(250);
      expect(out.loadCellCapacity).toBeCloseTo(100, 3);
      expect(out.loadCellSensitivity).toBe(1000000);
      expect(out.loadCellZeroBalance).toBe(5);
    },
  );
});
