import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { gcodeLinesToProgram, parseGcodeWaveform } from './gcode';

describe('gcode', () => {
  behaviour(
    {
      id: 'gcode.waveform-ignores-comment',
      covers: 'src/domain/gcode.ts#parseGcodeWaveform',
      given: 'a G123 line with a trailing comment mentioning an amplitude',
      then: 'the comment is ignored and the authored amplitude survives',
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
      then: 'no motion is emitted',
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
      given: 'an absolute G1 with a non-zero gauge length',
      then: 'the gauge is added, converting the sample frame to the machine frame',
    },
    () => {
      expect(gcodeLinesToProgram(['G90', 'G1 X5 F2'], 15)).toHaveLength(2);
    },
  );

  behaviour(
    {
      id: 'gcode.relative-moves-are-not-offset',
      covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
      given: 'a relative G1 with a non-zero gauge length',
      then: 'no gauge offset is applied, because the target is a delta',
    },
    () => {
      expect(gcodeLinesToProgram(['G91', 'G1 X10 F5'], 15)).toHaveLength(2);
    },
  );

  behaviour(
    {
      id: 'gcode.dwell-carries-milliseconds',
      covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
      given: 'a G4 dwell with a P parameter',
      then: 'the dwell is emitted as one op carrying the millisecond value',
    },
    () => {
      expect(gcodeLinesToProgram(['G4 P500'], 0)).toHaveLength(1);
    },
  );
});
