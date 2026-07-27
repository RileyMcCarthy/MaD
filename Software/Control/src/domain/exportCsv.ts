/**
 * Build an export CSV with a metadata header prepended to the raw sample CSV.
 * Mirrors the desktop "export with metadata" feature. Pure function.
 */

import { TestRunEntry } from './types';

export function buildExportCsv(run: TestRunEntry, csv: string): string {
  const sp = run.sampleProfile;
  const header = [
    `# Test: ${run.testName}`,
    `# Status: ${run.status}`,
    `# Started: ${run.startedAt}`,
    run.completedAt ? `# Completed: ${run.completedAt}` : undefined,
    `# Motion profile: ${run.motionProfile?.name ?? ''}`,
    sp
      ? `# Sample profile: ${sp.serial || ''} (maxForce=${sp.maxForce}N, maxDisp=${sp.maxDisplacement}mm, w×t=${sp.sampleWidth}×${sp.sampleThickness}mm)`
      : undefined,
    run.gaugeLengthMm !== undefined ? `# Gauge length (mm): ${run.gaugeLengthMm}` : undefined,
    '',
  ].filter((l): l is string => l !== undefined);

  return `${header.join('\n')}\n${csv}`;
}
