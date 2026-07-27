/**
 * Sprint C — e2e matrix catalog integrity (no SIL required).
 * Ensures matrix-catalog.json stays coherent with smoke_ids and cell shapes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const catalogPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../e2e/matrix-catalog.json',
);

type Catalog = {
  M8_jog: Array<{ id: string; mm: number; speed: number; settleMs: number; epsMm: number; roundTrip?: boolean }>;
  M9_force_slack: Array<{
    id: string;
    jogMm: number;
    expectForceNearZero?: boolean;
    forceEpsN?: number;
    minForceN?: number;
    minPosMm: number;
  }>;
  M10_waveform: Array<{
    id: string;
    shape: string;
    amplitude: number;
    frequency: number;
    cycles: number;
    distance: number;
    maxDisp: number;
  }>;
  M11_link_loss: Array<{ id: string; moment: string; reconnect: boolean }>;
  smoke_ids: string[];
};

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;

describe('Sprint C e2e matrix catalog', () => {
  it('M8 jog cells have positive mm/speed and unique ids', () => {
    expect(catalog.M8_jog.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(catalog.M8_jog.map((c) => c.id));
    expect(ids.size).toBe(catalog.M8_jog.length);
    for (const c of catalog.M8_jog) {
      expect(c.mm).toBeGreaterThan(0);
      expect(c.speed).toBeGreaterThan(0);
      expect(c.epsMm).toBeGreaterThan(0);
      expect(c.settleMs).toBeGreaterThan(0);
    }
  });

  it('M9 force cells cover mid-slack and past-slack', () => {
    expect(catalog.M9_force_slack.some((c) => c.expectForceNearZero)).toBe(true);
    expect(catalog.M9_force_slack.some((c) => c.minForceN && c.minForceN > 0)).toBe(true);
  });

  it('M10 waveform cells include sine and triangle', () => {
    const shapes = new Set(catalog.M10_waveform.map((c) => c.shape));
    expect(shapes.has('sine')).toBe(true);
    expect(shapes.has('triangle')).toBe(true);
    expect(catalog.M10_waveform.length).toBeGreaterThanOrEqual(5);
    for (const c of catalog.M10_waveform) {
      expect(c.amplitude).toBeGreaterThan(0);
      expect(c.frequency).toBeGreaterThan(0);
      expect(c.cycles).toBeGreaterThanOrEqual(1);
    }
  });

  it('M11 link-loss covers idle and mid-test', () => {
    const moments = new Set(catalog.M11_link_loss.map((c) => c.moment));
    expect(moments.has('idle')).toBe(true);
    expect(moments.has('mid-test')).toBe(true);
  });

  it('smoke_ids references known matrix or legacy scenario ids', () => {
    const known = new Set<string>([
      ...catalog.M8_jog.map((c) => c.id),
      ...catalog.M9_force_slack.map((c) => c.id),
      ...catalog.M10_waveform.map((c) => c.id),
      ...catalog.M11_link_loss.map((c) => c.id),
      // legacy suite ids used in smoke
      'A1',
      'B1+C1',
      'D1',
      'E1',
      'G1',
      'G2+G3+H2+I',
      'TM-busy-restart',
      'TM-manual-gate',
      'P1-precision',
      'BB-back-to-back',
      'B5-reconnect',
    ]);
    for (const id of catalog.smoke_ids) {
      expect(known.has(id), `smoke id ${id} not in catalog/legacy set`).toBe(true);
    }
  });
});
