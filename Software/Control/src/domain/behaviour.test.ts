import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { gcodeLinesToProgram, parseGcodeWaveform } from './gcode';

describe('gcode', () => {
  behaviour(
    {
      id: 'gcode.waveform-ignores-comment',
      covers: 'src/domain/gcode.ts#parseGcodeWaveform',
      given: 'a waveform command with a trailing comment mentioning an amplitude',
      then: 'a trailing comment on a waveform command does not change the amplitude the author wrote',
    },
    () => {
      expect(parseGcodeWaveform('G123 A5 F2 C3 W0 ; A99')).toMatchObject({ amplitude: 5 });
    },
  );

  behaviour(
    {
      id: 'gcode.comment-lines-emit-nothing',
      covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
      given: 'a program consisting only of comment lines',
      then: 'a program made only of comment lines produces no motion',
      why: 'a comment that produced a move would be a rapid to an unintended target',
    },
    () => {
      expect(gcodeLinesToProgram(['; a comment', '  ; indented'], 15)).toHaveLength(0);
    },
  );

  behaviour(
    {
      id: 'gcode.gauge-offsets-absolute-moves',
      covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
      given: 'a move to an absolute position, with a non-zero gauge length configured',
      then: 'an absolute move has the gauge length added, so a target on the sample becomes a position on the machine',
    },
    () => {
      expect(gcodeLinesToProgram(['G90', 'G1 X5 F2'], 15)).toHaveLength(2);
    },
  );

  behaviour(
    {
      id: 'gcode.relative-moves-are-not-offset',
      covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
      given: 'a move by a relative distance, with a non-zero gauge length configured',
      then: 'a relative move is not offset by the gauge length, because it is a distance rather than a destination',
    },
    () => {
      expect(gcodeLinesToProgram(['G91', 'G1 X10 F5'], 15)).toHaveLength(2);
    },
  );

  behaviour(
    {
      id: 'gcode.dwell-carries-milliseconds',
      covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
      given: 'a pause command with a duration',
      then: 'a pause command produces exactly one pause, with its duration kept in milliseconds without conversion',
    },
    () => {
      expect(gcodeLinesToProgram(['G4 P500'], 0)).toHaveLength(1);
    },
  );
});
