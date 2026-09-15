import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  DEFAULT_JOG_MM,
  JOG_INCREMENTS_MM,
  formatJogIncrementLabel,
  isSelectedJogIncrement,
} from './jogIncrements';
import { MOVE_FIELD_RANGE, validateAndEncodeMove } from './gcode';
import type { GCode } from '@/protocol/generated/protoemb';

describe('jog increments', () => {
  behaviour(
    {
      id: 'jog.increments-include-0.1mm',
      covers: 'src/domain/jogIncrements.ts#JOG_INCREMENTS_MM',
      given: 'the selectable jog increment presets',
      expect: {
        'includes-0.1': '0.1 mm is offered for short-sample gauge / preload setup',
        'all-positive-finite': 'every preset is a finite distance greater than zero',
        'within-encode-range': 'every preset is inside the encodable X range',
      },
      why: {
        'includes-0.1':
          'operators need 0.1 mm steps to set gauge length and preload on short samples',
      },
    },
    () => {
      expect(JOG_INCREMENTS_MM).toContain(0.1);
      expect(JOG_INCREMENTS_MM.includes(DEFAULT_JOG_MM)).toBe(true);
      for (const mm of JOG_INCREMENTS_MM) {
        expect(Number.isFinite(mm)).toBe(true);
        expect(mm).toBeGreaterThan(0);
        expect(mm).toBeGreaterThanOrEqual(MOVE_FIELD_RANGE.x.min);
        expect(mm).toBeLessThanOrEqual(MOVE_FIELD_RANGE.x.max);
        expect(() =>
          validateAndEncodeMove({ g: 0 as GCode, x: mm, f: 5, p: 0 }),
        ).not.toThrow();
      }
    },
  );

  behaviour(
    {
      id: 'jog.increment-selection-is-float-safe',
      covers: 'src/domain/jogIncrements.ts#isSelectedJogIncrement',
      given: 'a jog distance that equals the 0.1 mm preset',
      expect: {
        'matches-0.1': 'the 0.1 mm button is treated as selected',
        'rejects-near-miss': 'a nearby value is not treated as the 0.1 mm preset',
      },
    },
    () => {
      expect(isSelectedJogIncrement(0.1, 0.1)).toBe(true);
      expect(isSelectedJogIncrement(0.1000000000, 0.1)).toBe(true);
      expect(isSelectedJogIncrement(0.2, 0.1)).toBe(false);
      expect(isSelectedJogIncrement(Number.NaN, 0.1)).toBe(false);
      expect(formatJogIncrementLabel(0.1)).toBe('0.1');
      expect(formatJogIncrementLabel(1)).toBe('1');
    },
  );
});
