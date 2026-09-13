import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  EMPTY_SAMPLE_PROFILE,
  parseMotionSetJson,
  parseSampleProfileJson,
  replaceSetAt,
  sampleProfileNameFromFile,
} from './profileFiles';
import type { Set as MotionSet } from './types';

const SET: MotionSet = {
  name: 'Preload',
  executions: 2,
  moves: [
    {
      moveType: 'linear',
      absoluteOrRelative: 'relative',
      moveParameters: { position: 0, velocity: 5, distance: 10, time: 0 },
    },
  ],
};

describe('sampleProfileNameFromFile', () => {
  behaviour(
    {
      id: 'profiles.sp-filename-becomes-the-sample-name',
      covers: 'src/domain/profileFiles.ts#sampleProfileNameFromFile',
      given: 'a sample-profile file named AL-6061-01.sp',
      then: 'importing a .sp file uses the filename without the extension as the sample name, even when the extension is uppercase',
    },
    () => {
      expect(sampleProfileNameFromFile('AL-6061-01.sp')).toBe('AL-6061-01');
      expect(sampleProfileNameFromFile('AL-6061-01.SP')).toBe('AL-6061-01');
    },
  );

  behaviour(
    {
      id: 'profiles.empty-sp-stem-is-imported',
      covers: 'src/domain/profileFiles.ts#sampleProfileNameFromFile',
      given: 'a sample-profile file whose name is only the .sp extension, or is empty',
      then: 'a .sp file with no name before the extension is imported as "imported"',
    },
    () => {
      expect(sampleProfileNameFromFile('.sp')).toBe('imported');
      expect(sampleProfileNameFromFile('')).toBe('imported');
    },
  );
});

describe('parseSampleProfileJson (F3)', () => {
  behaviour(
    {
      id: 'profiles.sp-json-fills-the-editor',
      covers: 'src/domain/profileFiles.ts#parseSampleProfileJson',
      given: 'a .sp file whose JSON is a bare sample profile from the file-formats spec',
      then: 'importing a .sp file loads max force, max velocity, max displacement, width, thickness, and serial into the editor',
    },
    () => {
      const profile = parseSampleProfileJson(
        JSON.stringify({
          maxForce: 10,
          maxVelocity: 50,
          maxDisplacement: 120,
          sampleWidth: 10,
          sampleThickness: 2,
          serial: 'PDMS-10A',
        }),
      );
      expect(profile).toEqual({
        maxForce: 10,
        maxVelocity: 50,
        maxDisplacement: 120,
        sampleWidth: 10,
        sampleThickness: 2,
        serial: 'PDMS-10A',
      });
    },
  );

  behaviour(
    {
      id: 'profiles.sp-entry-wrapper-uses-inner-profile',
      covers: 'src/domain/profileFiles.ts#parseSampleProfileJson',
      given: 'a .sp file that is a saved folder entry wrapping a profile object',
      then: 'importing a wrapped sample-profile entry uses the inner profile fields, including its serial',
    },
    () => {
      const profile = parseSampleProfileJson(
        JSON.stringify({
          id: 'abc',
          name: 'from-entry',
          createdAt: '2026-01-01T00:00:00.000Z',
          profile: { ...EMPTY_SAMPLE_PROFILE, maxForce: 25, serial: 'inner' },
        }),
      );
      expect(profile.maxForce).toBe(25);
      expect(profile.serial).toBe('inner');
    },
  );

  behaviour(
    {
      id: 'profiles.sp-entry-name-fills-missing-serial',
      covers: 'src/domain/profileFiles.ts#parseSampleProfileJson',
      given: 'a wrapped sample-profile entry whose inner profile has no serial',
      then: 'importing a wrapped sample-profile entry with no inner serial uses the entry name as the serial',
    },
    () => {
      const profile = parseSampleProfileJson(
        JSON.stringify({
          name: 'folder-name',
          profile: { maxForce: 1, maxVelocity: 0, maxDisplacement: 0, sampleWidth: 0, sampleThickness: 0 },
        }),
      );
      expect(profile.serial).toBe('folder-name');
    },
  );

  behaviour(
    {
      id: 'profiles.partial-sp-zeros-missing-numbers',
      covers: 'src/domain/profileFiles.ts#parseSampleProfileJson',
      given: 'a .sp file that only names the serial',
      then: 'a partial .sp file still opens in the editor, with missing numeric limits treated as zero',
    },
    () => {
      expect(parseSampleProfileJson('{"serial":"x"}')).toEqual({
        ...EMPTY_SAMPLE_PROFILE,
        serial: 'x',
      });
    },
  );

  behaviour(
    {
      id: 'profiles.sp-must-be-a-json-object',
      covers: 'src/domain/profileFiles.ts#parseSampleProfileJson',
      given: 'a .sp file that is not JSON, or is a JSON array or null',
      then: 'importing a .sp file that is not a JSON object is rejected',
    },
    () => {
      expect(() => parseSampleProfileJson('not json')).toThrow(/not JSON/);
      expect(() => parseSampleProfileJson('[]')).toThrow(/JSON object/);
      expect(() => parseSampleProfileJson('null')).toThrow(/JSON object/);
    },
  );
});

describe('parseMotionSetJson + replaceSetAt (F5)', () => {
  behaviour(
    {
      id: 'profiles.set-json-round-trips',
      covers: 'src/domain/profileFiles.ts#parseMotionSetJson',
      given: 'the JSON of a saved motion set with a name, repeat count, and moves',
      then: 'loading a saved motion set restores its name, how many times it runs, and its moves',
    },
    () => {
      expect(parseMotionSetJson(JSON.stringify(SET))).toEqual(SET);
    },
  );

  behaviour(
    {
      id: 'profiles.set-missing-repeats-runs-once',
      covers: 'src/domain/profileFiles.ts#parseMotionSetJson',
      given: 'a motion set JSON with no repeat count, or a repeat count of zero',
      then: 'a motion set with no repeat count, or a repeat count of zero, runs once',
    },
    () => {
      const parsed = parseMotionSetJson(JSON.stringify({ name: 'S', moves: [] }));
      expect(parsed.executions).toBe(1);
      expect(parseMotionSetJson(JSON.stringify({ name: 'S', executions: 0, moves: [] })).executions).toBe(
        1,
      );
    },
  );

  behaviour(
    {
      id: 'profiles.set-json-requires-name-and-moves',
      covers: 'src/domain/profileFiles.ts#parseMotionSetJson',
      given: 'motion set JSON missing a name, missing a moves list, or not JSON at all',
      then: 'loading a motion set without a name or without a moves list is rejected',
    },
    () => {
      expect(() => parseMotionSetJson('{"moves":[]}')).toThrow(/name/);
      expect(() => parseMotionSetJson('{"name":"S"}')).toThrow(/moves/);
      expect(() => parseMotionSetJson('not json')).toThrow(/not JSON/);
    },
  );

  behaviour(
    {
      id: 'profiles.load-set-replaces-only-the-target',
      covers: 'src/domain/profileFiles.ts#replaceSetAt',
      given: 'a motion profile with two sets, loading a saved set onto the second',
      then: 'loading a saved set onto one slot of a motion profile replaces only that slot and leaves the others unchanged',
    },
    () => {
      const other: MotionSet = { name: 'Hold', executions: 1, moves: [] };
      const next = { ...SET, name: 'Loaded' };
      const out = replaceSetAt([SET, other], 1, next);
      expect(out[0]).toBe(SET);
      expect(out[1]).toEqual(next);
      expect(replaceSetAt([SET, other], 1, next)[0].name).toBe('Preload');
    },
  );

  behaviour(
    {
      id: 'profiles.load-set-rejects-a-missing-slot',
      covers: 'src/domain/profileFiles.ts#replaceSetAt',
      given: 'a motion profile with one set and a load target past the end, or before the start',
      then: 'loading a saved set onto a slot that does not exist is rejected',
    },
    () => {
      expect(() => replaceSetAt([SET], 1, SET)).toThrow(/out of range/);
      expect(() => replaceSetAt([SET], -1, SET)).toThrow(/out of range/);
    },
  );
});
