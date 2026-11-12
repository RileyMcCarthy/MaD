import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { legacyProfileProblem } from './legacyProfile';

const profile = (move: Record<string, unknown>) => ({
  name: 'P',
  description: '',
  sets: [{ name: 'S', executions: 1, moves: [move] }],
});

describe('old-format motion profiles', () => {
  behaviour(
    {
      id: 'legacy-profile.relative-move-refused',
      covers: 'src/domain/legacyProfile.ts#legacyProfileProblem',
      given: 'a saved profile from the old format with a relative +10 mm move',
      expect: {
        refused: 'the profile is refused, naming the set and move',
        'says-rebuild': 'the reason says moves are now absolute positions and the profile must be rebuilt',
      },
      why: { refused: 'read in the current format the move would drive the gantry to 0 mm' },
    },
    () => {
      const why = legacyProfileProblem(
        profile({ moveType: 'linear', absoluteOrRelative: 'relative', moveParameters: { position: 0, velocity: 5, distance: 10, time: 0 } }),
      );
      expect(why).toContain('set 1, move 1');
      expect(why).toContain('absolute positions');
      expect(why).toContain('rebuild');
    },
  );

  behaviour(
    {
      id: 'legacy-profile.old-waveform-refused',
      covers: 'src/domain/legacyProfile.ts#legacyProfileProblem',
      given: 'saved waveforms from the old format: a sine with a cycle count, and a triangle',
      expect: {
        'cycles-refused': 'the sine with a cycle count is refused',
        'triangle-refused': 'the triangle is refused as an unsupported waveform',
      },
    },
    () => {
      expect(legacyProfileProblem(profile({ moveType: 'math', moveParameters: { position: 0, velocity: 0, time: 0, amplitude: 5, frequency: 1, cycles: 10 } }))).toContain('cycles');
      expect(legacyProfileProblem(profile({ moveType: 'math', moveParameters: { position: 0, velocity: 0, time: 0, waveform: 'triangle', amplitude: 5, frequency: 1 } }))).toContain('triangle');
    },
  );

  behaviour(
    {
      id: 'legacy-profile.current-format-accepted',
      covers: 'src/domain/legacyProfile.ts#legacyProfileProblem',
      given: 'a profile in the current format with an absolute move, a sine, a sigmoid and a chirp',
      expect: { accepted: 'the profile is accepted' },
    },
    () => {
      const p = {
        name: 'P',
        description: '',
        sets: [{ name: 'S', executions: 2, moves: [
          { moveType: 'linear', moveParameters: { position: 10, velocity: 5, time: 0 } },
          { moveType: 'math', moveParameters: { position: 0, velocity: 0, time: 0, amplitude: -5, frequency: 1 } },
          { moveType: 'math', moveParameters: { position: 20, velocity: 5, time: 0, waveform: 'sigmoid', acceleration: 50 } },
          { moveType: 'math', moveParameters: { position: 0, velocity: 0, time: 0, waveform: 'chirp', amplitude: 1, frequency: 0.1, endFrequency: 1, duration: 30 } },
        ] }],
      };
      expect(legacyProfileProblem(p)).toBeNull();
    },
  );
});
