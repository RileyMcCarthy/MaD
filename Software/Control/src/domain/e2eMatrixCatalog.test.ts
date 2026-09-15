/**
 * Sprint C — e2e matrix catalog integrity (no SIL required).
 * Ensures matrix-catalog.json stays coherent with smoke_ids and cell shapes.
 */
import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const e2eDir = join(dirname(fileURLToPath(import.meta.url)), '../../e2e');
const catalogPath = join(e2eDir, 'matrix-catalog.json');
const smokeIdsPath = join(e2eDir, 'smoke-ids.txt');

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
  M12_linear_um: Array<{
    id: string;
    label: string;
    velocityMmS: number;
    distanceMm?: number;
    targetMm?: number;
    absolute?: boolean;
    setupJogMm?: number;
    maxDisplacement?: number;
  }>;
  smoke_ids: string[];
};

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;

describe('Sprint C e2e matrix catalog', () => {
  behaviour(
    {
      id: 'matrix.jog-catalog-cells-are-positive',
      covers: 'e2e/matrix-catalog.json',
      given: 'the jog matrix catalog',
      expect: {
        'four-or-more-cells': 'at least four cells are listed',
        'unique-ids': 'every cell id is unique',
        'positive-cell-values':
          'each cell carries a positive distance, speed, settle time and position tolerance',
      },
    },
    () => {
      expect(catalog.M8_jog.length).toBeGreaterThanOrEqual(4);
      const ids = new Set(catalog.M8_jog.map((c) => c.id));
      expect(ids.size).toBe(catalog.M8_jog.length);
      for (const c of catalog.M8_jog) {
        expect(c.mm).toBeGreaterThan(0);
        expect(c.speed).toBeGreaterThan(0);
        expect(c.epsMm).toBeGreaterThan(0);
        expect(c.settleMs).toBeGreaterThan(0);
      }
    },
  );

  behaviour(
    {
      id: 'matrix.force-catalog-covers-slack',
      covers: 'e2e/matrix-catalog.json',
      given: 'the force-slack matrix catalog',
      expect: {
        'near-zero-cell': 'a cell expects force near zero',
        'loaded-cell': 'a cell expects force above zero',
      },
    },
    () => {
      expect(catalog.M9_force_slack.some((c) => c.expectForceNearZero)).toBe(true);
      expect(catalog.M9_force_slack.some((c) => c.minForceN && c.minForceN > 0)).toBe(true);
    },
  );

  behaviour(
    {
      id: 'matrix.waveform-catalog-includes-sine-and-triangle',
      covers: 'e2e/matrix-catalog.json',
      given: 'the waveform matrix catalog',
      expect: {
        'sine-and-triangle': 'sine and triangle are both covered',
        'five-or-more-cells': 'at least five cells are listed',
        'positive-drive-values':
          'each cell carries a positive amplitude, a positive frequency and at least one cycle',
      },
    },
    () => {
      const shapes = new Set(catalog.M10_waveform.map((c) => c.shape));
      expect(shapes.has('sine')).toBe(true);
      expect(shapes.has('triangle')).toBe(true);
      expect(catalog.M10_waveform.length).toBeGreaterThanOrEqual(5);
      for (const c of catalog.M10_waveform) {
        expect(c.amplitude).toBeGreaterThan(0);
        expect(c.frequency).toBeGreaterThan(0);
        expect(c.cycles).toBeGreaterThanOrEqual(1);
      }
    },
  );

  behaviour(
    {
      id: 'matrix.link-loss-catalog-covers-idle-and-mid-test',
      covers: 'e2e/matrix-catalog.json',
      given: 'the link-loss matrix catalog',
      expect: {
        'idle-disconnect': 'a disconnect while idle is covered',
        'mid-test-disconnect': 'a disconnect mid-test is covered',
      },
    },
    () => {
      const moments = new Set(catalog.M11_link_loss.map((c) => c.moment));
      expect(moments.has('idle')).toBe(true);
      expect(moments.has('mid-test')).toBe(true);
    },
  );

  behaviour(
    {
      id: 'matrix.linear-um-catalog-covers-the-envelope',
      covers: 'e2e/matrix-catalog.json',
      given: 'the linear motion-accuracy catalog',
      expect: {
        'eight-or-more-cells': 'at least eight cells are listed',
        'unique-ids': 'every cell id is unique',
        'absolute-and-relative': 'absolute and relative travels are both covered',
        'reverse-travel': 'a cell travels in the decreasing-position direction',
        'several-speeds': 'more than one speed is covered',
        'several-distances': 'more than one travel is covered',
        'positive-speed': 'every cell carries a positive speed',
      },
    },
    () => {
      expect(catalog.M12_linear_um.length).toBeGreaterThanOrEqual(8);
      const ids = new Set(catalog.M12_linear_um.map((c) => c.id));
      expect(ids.size).toBe(catalog.M12_linear_um.length);
      expect(catalog.M12_linear_um.some((c) => c.absolute && c.targetMm)).toBe(true);
      expect(catalog.M12_linear_um.some((c) => !c.absolute && (c.distanceMm ?? 0) > 0)).toBe(true);
      expect(catalog.M12_linear_um.some((c) => (c.distanceMm ?? 0) < 0)).toBe(true);
      const speeds = new Set(catalog.M12_linear_um.map((c) => c.velocityMmS));
      const travels = new Set(
        catalog.M12_linear_um.map((c) => Math.abs(c.distanceMm ?? c.targetMm ?? 0)),
      );
      expect(speeds.size).toBeGreaterThan(1);
      expect(travels.size).toBeGreaterThan(1);
      for (const c of catalog.M12_linear_um) {
        expect(c.velocityMmS).toBeGreaterThan(0);
        expect(Math.abs(c.distanceMm ?? c.targetMm ?? 0)).toBeGreaterThan(0);
      }
    },
  );

  behaviour(
    {
      id: 'matrix.smoke-ids-are-known-scenarios',
      covers: 'e2e/matrix-catalog.json',
      given: 'the catalog smoke list, the matrix cell ids, and the legacy scenario ids',
      expect: { 'ids-known': 'every id in the smoke list matches one of the known ids' },
    },
    () => {
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
        'VT-linear',
        'BB-back-to-back',
        'B5-reconnect',
        'FW1',
      ]);
      for (const id of catalog.smoke_ids) {
        expect(known.has(id), `smoke id ${id} not in catalog/legacy set`).toBe(true);
      }
    },
  );

  // The smoke list lives in two places — smoke-ids.txt (what e2e:smoke actually
  // runs) and catalog.smoke_ids (what this file checks) — and they were kept in
  // sync by a comment. They had already drifted: FW1 was in the runnable list
  // and not the catalog, so the catalog's assertions covered a set nobody ran.
  behaviour(
    {
      id: 'matrix.smoke-file-matches-catalog',
      covers: 'e2e/matrix-catalog.json',
      given: 'the runnable smoke-ids file and the catalog smoke list',
      expect: { 'same-ids-same-order': 'the two lists hold the same ids in the same order' },
      why: {
        'same-ids-same-order':
          'the file is what the smoke run actually executes; the catalog is what this suite checks',
      },
    },
    () => {
      const fromFile = readFileSync(smokeIdsPath, 'utf8')
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean);
      expect(fromFile).toEqual(catalog.smoke_ids);
    },
  );

  behaviour(
    {
      id: 'matrix.smoke-ids-are-unique',
      covers: 'e2e/matrix-catalog.json',
      given: 'the catalog smoke list',
      expect: { 'no-duplicates': 'each id appears exactly once' },
    },
    () => {
      expect(new Set(catalog.smoke_ids).size).toBe(catalog.smoke_ids.length);
    },
  );
});
