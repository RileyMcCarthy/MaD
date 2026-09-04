/**
 * The `vibes doctor --repeat=N` attestation, and its verification.
 *
 * `--bootstrap` is the one accept that has nothing to compare against: the
 * files being committed BECOME the definition of correct. The only property
 * that can be established before that happens is DETERMINISM — run the producer
 * N times on an unchanged tree and check it emits the same bytes every time.
 * A nondeterministic producer therefore cannot bootstrap at all, which is the
 * intended outcome: its snapshots would be a changelog of noise.
 *
 * This file owns the on-disk contract because `accept` is its only consumer.
 * `cli/doctor.ts` writes it; nothing else reads it.
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Sha } from '../types.js';

/** Where `vibes doctor --repeat=N` writes its attestation. */
export const DOCTOR_ATTESTATION_PATH = '.vibes/doctor.json';
export const DOCTOR_ATTESTATION_SCHEMA = 'vibes-doctor/1';

/** Minimum agreeing runs before a bootstrap is allowed. §5.6 says three. */
export const BOOTSTRAP_MIN_REPEAT = 3;

export interface DoctorProducerAttestation {
  /** `component/producer`. */
  readonly producer: string;
  /** How many times the producer was executed. */
  readonly repeat: number;
  /**
   * One digest of the WHOLE received tree per run, in run order.
   *
   * A tree digest, not a per-file one: a producer that emits a different SET of
   * files each run is just as nondeterministic as one that emits different
   * bytes, and per-file hashes would miss it.
   */
  readonly runShas: readonly string[];
  /** True when every entry in `runShas` is equal. Recomputed here anyway. */
  readonly stable: boolean;
}

export interface DoctorAttestation {
  readonly schema: string;
  /**
   * The commit the repeats ran against. An attestation from a different tree
   * says nothing about this one, so `accept` requires it to match HEAD.
   */
  readonly headSha: Sha;
  readonly producers: readonly DoctorProducerAttestation[];
}

export interface AttestationCheck {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly runShas: readonly string[];
}

export function parseDoctorAttestation(text: string): DoctorAttestation | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o['schema'] !== DOCTOR_ATTESTATION_SCHEMA) return null;
  if (typeof o['headSha'] !== 'string') return null;
  const rawProducers = Array.isArray(o['producers']) ? o['producers'] : [];
  const producers: DoctorProducerAttestation[] = [];
  for (const p of rawProducers) {
    if (p === null || typeof p !== 'object') continue;
    const po = p as Record<string, unknown>;
    if (typeof po['producer'] !== 'string') continue;
    const runShas = Array.isArray(po['runShas'])
      ? po['runShas'].filter((s): s is string => typeof s === 'string')
      : [];
    producers.push({
      producer: po['producer'],
      repeat: typeof po['repeat'] === 'number' ? po['repeat'] : runShas.length,
      runShas,
      stable: po['stable'] === true,
    });
  }
  return { schema: DOCTOR_ATTESTATION_SCHEMA, headSha: o['headSha'], producers };
}

export async function readDoctorAttestation(absPath: string): Promise<DoctorAttestation | null> {
  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf8');
  } catch {
    return null;
  }
  return parseDoctorAttestation(text);
}

/**
 * Is this attestation good enough to bootstrap `producerId`?
 *
 * `stable` is recomputed from `runShas` rather than trusted: the flag is one
 * boolean in a JSON file, and the digests beside it are the evidence. Trusting
 * the summary over the evidence is how a "3 agreeing runs" claim becomes a
 * three-character edit.
 */
export function checkAttestation(
  attestation: DoctorAttestation | null,
  producerId: string,
  headSha: Sha,
  minRepeat: number = BOOTSTRAP_MIN_REPEAT,
): AttestationCheck {
  if (attestation === null) {
    return {
      ok: false,
      reason: `no attestation found at ${DOCTOR_ATTESTATION_PATH}`,
      runShas: [],
    };
  }
  if (attestation.headSha !== headSha) {
    return {
      ok: false,
      reason: `attestation was recorded at ${attestation.headSha.slice(0, 12)} but HEAD is ${headSha.slice(0, 12)}`,
      runShas: [],
    };
  }
  const entry = attestation.producers.find((p) => p.producer === producerId);
  if (entry === undefined) {
    return { ok: false, reason: `attestation does not cover ${producerId}`, runShas: [] };
  }
  if (entry.runShas.length < minRepeat) {
    return {
      ok: false,
      reason: `attestation records ${entry.runShas.length} run(s); ${minRepeat} are required`,
      runShas: entry.runShas,
    };
  }
  const first = entry.runShas[0];
  const agree = first !== undefined && entry.runShas.every((s) => s === first);
  if (!agree) {
    return {
      ok: false,
      reason: `the ${entry.runShas.length} doctor runs did not agree — this producer is nondeterministic and cannot be bootstrapped`,
      runShas: entry.runShas,
    };
  }
  return { ok: true, reason: null, runShas: entry.runShas };
}

/* ─────────────────────────── writing the thing ───────────────────────── */

/**
 * Canonical, key-sorted, newline-terminated.
 *
 * `.vibes/doctor.json` is gitignored scratch, so churn does not matter for
 * review — but two `doctor --repeat=3` runs on the same tree producing
 * different bytes would make the file itself look nondeterministic, and the
 * whole point of this file is to be the evidence that something is not.
 */
export function serializeDoctorAttestation(a: DoctorAttestation): string {
  return `${JSON.stringify(sortKeys(a), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const v = src[k];
      if (v === undefined) continue;
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * One digest for a producer's WHOLE output tree.
 *
 * The path list is folded in, not just the contents: a producer that emits a
 * different SET of files each run is exactly as nondeterministic as one that
 * emits different bytes, and a hash of concatenated contents alone would call
 * `{a, b}` and `{ab}` identical. Paths are sorted BYTEWISE rather than with
 * `localeCompare`, because a locale-sensitive sort makes the digest depend on
 * the machine's environment — which is the one thing an attestation about
 * reproducibility must not do.
 *
 * Directory entries themselves are not hashed. An empty directory is invisible
 * to git, so treating its presence as behaviour would fail a bootstrap over a
 * difference that can never reach a reviewer.
 */
export async function hashProducerTree(absDir: string): Promise<string> {
  const files = await walk(absDir, absDir);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256');
  for (const rel of files) {
    const buf = await fs.readFile(join(absDir, ...rel.split('/')));
    h.update(rel, 'utf8');
    h.update('\0');
    h.update(createHash('sha256').update(buf).digest('hex'), 'utf8');
    h.update('\n');
  }
  return h.digest('hex');
}

async function walk(root: string, dir: string): Promise<string[]> {
  const entries = await readdirOrEmpty(dir);
  const out: string[] = [];
  for (const e of entries) {
    const abs = join(dir, e.name);
    // Symlinks are NOT followed: a producer emitting a link to something
    // outside its out dir would otherwise make the digest depend on a tree
    // nobody is measuring, and a link cycle would hang the walk.
    if (e.isDirectory() && !e.isSymbolicLink()) {
      out.push(...(await walk(root, abs)));
    } else if (e.isFile()) {
      out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  return out;
}

async function readdirOrEmpty(dir: string): Promise<readonly Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // an absent received dir digests as the empty tree
  }
}
