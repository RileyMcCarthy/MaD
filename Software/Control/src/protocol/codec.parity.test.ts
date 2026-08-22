/**
 * Codec contract: the generated browser-safe (Uint8Array/DataView) codec must
 * produce exact, stable wire bytes and round-trip values within the wire scale.
 *
 * We freeze GOLDEN byte vectors here (self-contained, CI-safe) so any unintended
 * change to the wire format is caught, and keep an INDEPENDENT bit-packer
 * reference for Move.
 */

import { describe, it, expect } from 'vitest';
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
  waveform: [16, 39, 0, 232, 3, 24, 3, 0, 0],
};

describe('codec golden byte vectors (frozen — guards the wire format)', () => {
  it('MachineState', () => {
    expect(
      bytes(nu.encodeMachineState({ faultedReason: 2, restrictedReason: 3, testRunning: true, motionEnabled: false })),
    ).toEqual(GOLD.state);
  });
  it('Sample', () => {
    expect(
      bytes(nu.encodeSample({ machineForce: 12.345, machinePosition: -50.5, machineSetpoint: 10.0, sampleForce: 3.21, samplePosition: 7.89 })),
    ).toEqual(GOLD.sample);
  });
  it('StoredSample', () => {
    expect(bytes(nu.encodeStoredSample({ force: 12.345, position: -50.5, time: 123456, setpoint: 10.0 }))).toEqual(
      GOLD.stored,
    );
  });
  it('MachineConfiguration', () => {
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
  });
  it('SampleProfile', () => {
    expect(
      bytes(nu.encodeSampleProfile({ maxForce: 500.25, maxVelocity: 10, maxDisplacement: 100, sampleWidth: 12, sampleThickness: 3 })),
    ).toEqual(GOLD.profile);
  });
  it('Move (current schema, 4-bit g incl. G122)', () => {
    expect(bytes(nu.encodeMove({ g: 1 as nu.GCode, x: 12.5, f: 3.0, p: 100 }))).toEqual(GOLD.move);
  });
  it('WaveformMove (G123 — shape/amplitude/frequency/cycles)', () => {
    expect(
      bytes(nu.encodeWaveformMove({ shape: nu.WaveformShape.SINE, amplitude: 5, frequency: 2, cycles: 100 })),
    ).toEqual(GOLD.waveform);
  });
});

describe('Move: independent bit-packer reference', () => {
  it('matches an independent LSB-first packer for the current layout', () => {
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
  });
});

describe('round-trip within scale precision', () => {
  it('Move', () => {
    const out = nu.decodeMove(nu.encodeMove({ g: 1 as nu.GCode, x: 12.5, f: 3.0, p: 100 }));
    expect(out.x).toBeCloseTo(12.5, 3);
    expect(out.f).toBeCloseTo(3.0, 3);
    expect(out.p).toBe(100);
    expect(nu.GCODE_VALUE_TO_WIRE[out.g]).toBe(1);
  });
  it('WaveformMove', () => {
    const v = { shape: nu.WaveformShape.TRIANGLE, amplitude: 12.345, frequency: 0.5, cycles: 1000 };
    const out = nu.decodeWaveformMove(nu.encodeWaveformMove(v));
    expect(out.shape).toBe(nu.WaveformShape.TRIANGLE);
    expect(out.amplitude).toBeCloseTo(12.345, 3);
    expect(out.frequency).toBeCloseTo(0.5, 3);
    expect(out.cycles).toBe(1000);
  });
  it('Sample', () => {
    const v = { machineForce: 12.345, machinePosition: -50.5, machineSetpoint: 10.0, sampleForce: 3.21, samplePosition: 7.89 };
    const out = nu.decodeSample(nu.encodeSample(v));
    expect(out.machineForce).toBeCloseTo(v.machineForce, 3);
    expect(out.machinePosition).toBeCloseTo(v.machinePosition, 3);
    expect(out.samplePosition).toBeCloseTo(v.samplePosition, 3);
  });
  it('StoredSample', () => {
    const v = { force: 12.345, position: -50.5, time: 123456, setpoint: 10.0 };
    const out = nu.decodeStoredSample(nu.encodeStoredSample(v));
    expect(out.force).toBeCloseTo(v.force, 3);
    expect(out.position).toBeCloseTo(v.position, 3);
    expect(out.time).toBe(123456);
    expect(out.setpoint).toBeCloseTo(v.setpoint, 3);
  });
  it('MachineConfiguration name + maxForceTensile scale', () => {
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
  });
});
