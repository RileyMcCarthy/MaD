/**
 * Parse the JSON files the Create / Samples screens import (.sp sample
 * profiles, saved Sets). Kept pure so F3/F5 do not depend on a file picker.
 */

import { SampleProfile, Set as MotionSet } from './types';

export const EMPTY_SAMPLE_PROFILE: SampleProfile = {
  maxForce: 0,
  maxVelocity: 0,
  maxDisplacement: 0,
  sampleWidth: 0,
  sampleThickness: 0,
  serial: '',
};

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Stem of `AL-6061-01.sp` → `AL-6061-01`; empty / extension-only → `imported`. */
export function sampleProfileNameFromFile(fileName: string): string {
  const stem = fileName.replace(/\.sp$/i, '').trim();
  return stem.length > 0 ? stem : 'imported';
}

/**
 * Accept a bare SampleProfile or a persisted SampleProfileEntry (`{ profile, name }`).
 * Missing numeric fields become 0 so a partial .sp still opens in the editor.
 */
export function parseSampleProfileJson(text: string): SampleProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('sample profile is not JSON');
  }
  const obj = asObject(parsed, 'sample profile');
  const src =
    obj.profile && typeof obj.profile === 'object' && !Array.isArray(obj.profile)
      ? (obj.profile as Record<string, unknown>)
      : obj;
  const serialFromProfile = typeof src.serial === 'string' ? src.serial : '';
  const serialFromEntry = typeof obj.name === 'string' ? obj.name : '';
  return {
    maxForce: finiteNumber(src.maxForce),
    maxVelocity: finiteNumber(src.maxVelocity),
    maxDisplacement: finiteNumber(src.maxDisplacement),
    sampleWidth: finiteNumber(src.sampleWidth),
    sampleThickness: finiteNumber(src.sampleThickness),
    serial: serialFromProfile || serialFromEntry,
  };
}

/** A saved Set JSON object (`sets/<name>.json` in the data folder). */
export function parseMotionSetJson(text: string): MotionSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('motion set is not JSON');
  }
  const obj = asObject(parsed, 'motion set');
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    throw new Error('motion set is missing a name');
  }
  if (!Array.isArray(obj.moves)) {
    throw new Error('motion set is missing a moves array');
  }
  const executions = finiteNumber(obj.executions);
  return {
    name: obj.name,
    executions: executions > 0 ? executions : 1,
    moves: obj.moves as MotionSet['moves'],
  };
}

/** Replace one set in a profile (Load Set in the motion editor). */
export function replaceSetAt(sets: MotionSet[], index: number, next: MotionSet): MotionSet[] {
  if (index < 0 || index >= sets.length) {
    throw new Error(`set index ${index} is out of range`);
  }
  return sets.map((set, i) => (i === index ? next : set));
}
