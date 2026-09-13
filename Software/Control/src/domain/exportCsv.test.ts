import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { buildExportCsv } from './exportCsv';
import type { TestRunEntry } from './types';

const csv = 'time_us,force_mN,position_um,setpoint_um\n0,0,0,0\n';

function run(over: Partial<TestRunEntry> = {}): TestRunEntry {
  return {
    id: 'id-1',
    testName: '000042',
    sampleProfileId: 'sp',
    motionProfileId: 'mp',
    sampleProfile: {
      maxForce: 100,
      maxVelocity: 10,
      maxDisplacement: 50,
      sampleWidth: 12,
      sampleThickness: 3,
      serial: 'PDMS-10A',
    },
    motionProfile: { name: 'Cyclic', description: '', sets: [] },
    gcode: ['G1 X1 F1', 'G122'],
    startedAt: '2026-01-15T12:00:00.000Z',
    completedAt: '2026-01-15T12:01:00.000Z',
    status: 'downloaded',
    gaugeLengthMm: 25.4,
    ...over,
  };
}

describe('buildExportCsv', () => {
  behaviour(
    {
      id: 'export.csv-header-names-the-run',
      covers: 'src/domain/exportCsv.ts#buildExportCsv',
      given: 'a downloaded run with sample, motion, and gauge length, plus the raw sample CSV',
      then: 'an exported CSV starts with comment lines naming the test, status, start, completion, motion profile, sample profile, and gauge length, then the raw sample rows unchanged',
    },
    () => {
      const out = buildExportCsv(run(), csv);
      expect(out).toContain('# Test: 000042');
      expect(out).toContain('# Status: downloaded');
      expect(out).toContain('# Started: 2026-01-15T12:00:00.000Z');
      expect(out).toContain('# Completed: 2026-01-15T12:01:00.000Z');
      expect(out).toContain('# Motion profile: Cyclic');
      expect(out).toContain('# Sample profile: PDMS-10A (maxForce=100N, maxDisp=50mm, w×t=12×3mm)');
      expect(out).toContain('# Gauge length (mm): 25.4');
      expect(out.endsWith(csv)).toBe(true);
      expect(out.split('\n').filter((l) => l === '').length).toBeGreaterThanOrEqual(1);
    },
  );

  behaviour(
    {
      id: 'export.csv-omits-absent-fields',
      covers: 'src/domain/exportCsv.ts#buildExportCsv',
      given: 'a run with no completion time, no sample profile, and no gauge length',
      then: 'an exported CSV omits completed, sample-profile, and gauge-length comment lines when those fields are absent, and still ends with the raw sample rows',
    },
    () => {
      const out = buildExportCsv(
        run({
          completedAt: undefined,
          sampleProfile: undefined as unknown as TestRunEntry['sampleProfile'],
          motionProfile: undefined as unknown as TestRunEntry['motionProfile'],
          gaugeLengthMm: undefined,
        }),
        csv,
      );
      expect(out).not.toContain('# Completed:');
      expect(out).not.toContain('# Sample profile:');
      expect(out).not.toContain('# Gauge length');
      expect(out).toContain('# Motion profile: ');
      expect(out.endsWith(csv)).toBe(true);
    },
  );
});
