import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  BOOTSTRAP_MIN_REPEAT,
  DOCTOR_ATTESTATION_SCHEMA,
  checkAttestation,
  hashProducerTree,
  parseDoctorAttestation,
  readDoctorAttestation,
  serializeDoctorAttestation,
  type DoctorAttestation,
} from './doctor.js';
import { makeFixture, type AcceptFixture } from './fixtures.test.js';

const HEAD = 'b'.repeat(40);

const live: AcceptFixture[] = [];
async function fixture(): Promise<AcceptFixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

function attestation(over: Partial<DoctorAttestation> = {}): DoctorAttestation {
  return {
    schema: DOCTOR_ATTESTATION_SCHEMA,
    headSha: HEAD,
    producers: [
      { producer: 'control/domain', repeat: 3, runShas: ['t1', 't1', 't1'], stable: true },
    ],
    ...over,
  };
}

describe('checkAttestation', () => {
  test('three agreeing runs on this HEAD is the passing case', () => {
    const r = checkAttestation(attestation(), 'control/domain', HEAD);
    expect(r.ok).toBe(true);
    expect(r.runShas).toEqual(['t1', 't1', 't1']);
  });

  test('a nondeterministic producer cannot bootstrap AT ALL', () => {
    // §5.6. Its snapshots would be a changelog of noise, and there is nothing
    // to compare a first baseline against except its own reproducibility.
    const r = checkAttestation(
      attestation({
        producers: [
          { producer: 'control/domain', repeat: 3, runShas: ['t1', 't2', 't1'], stable: false },
        ],
      }),
      'control/domain',
      HEAD,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('nondeterministic');
  });

  test('the `stable` flag is NEVER trusted over the digests beside it', () => {
    // Otherwise "3 agreeing runs" becomes a three-character edit.
    const r = checkAttestation(
      attestation({
        producers: [
          { producer: 'control/domain', repeat: 3, runShas: ['t1', 't2', 't3'], stable: true },
        ],
      }),
      'control/domain',
      HEAD,
    );
    expect(r.ok).toBe(false);
  });

  test('an attestation from a different commit says nothing about this one', () => {
    const r = checkAttestation(attestation(), 'control/domain', 'c'.repeat(40));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('but HEAD is');
  });

  test('fewer than three runs is refused, and the count is named', () => {
    const r = checkAttestation(
      attestation({
        producers: [{ producer: 'control/domain', repeat: 2, runShas: ['t1', 't1'], stable: true }],
      }),
      'control/domain',
      HEAD,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`2 run(s); ${BOOTSTRAP_MIN_REPEAT} are required`);
  });

  test('an attestation covering a different producer does not transfer', () => {
    const r = checkAttestation(attestation(), 'control/trace', HEAD);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('does not cover');
  });

  test('no attestation at all names the file to produce', () => {
    const r = checkAttestation(null, 'control/domain', HEAD);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('.vibes/doctor.json');
  });
});

describe('parse / serialize', () => {
  test('round-trips', () => {
    const a = attestation();
    expect(parseDoctorAttestation(serializeDoctorAttestation(a))).toEqual(a);
  });

  test('a wrong or missing schema parses as null, not as an empty attestation', () => {
    expect(parseDoctorAttestation('{}')).toBeNull();
    expect(parseDoctorAttestation(JSON.stringify({ schema: 'x/1', headSha: HEAD }))).toBeNull();
    expect(parseDoctorAttestation('not json')).toBeNull();
  });

  test('a missing file reads as null rather than throwing', async () => {
    const f = await fixture();
    expect(await readDoctorAttestation(join(f.dir, 'nope.json'))).toBeNull();
  });

  test('reads what serialize wrote', async () => {
    const f = await fixture();
    const abs = join(f.dir, '.vibes', 'doctor.json');
    await mkdir(join(f.dir, '.vibes'), { recursive: true });
    await writeFile(abs, serializeDoctorAttestation(attestation()));
    expect((await readDoctorAttestation(abs))?.producers[0]?.producer).toBe('control/domain');
  });
});

describe('hashProducerTree', () => {
  test('identical trees digest identically', async () => {
    const f = await fixture();
    await f.write('r1/a.txt', 'x');
    await f.write('r1/b/c.txt', 'y');
    await f.write('r2/a.txt', 'x');
    await f.write('r2/b/c.txt', 'y');
    expect(await hashProducerTree(join(f.dir, 'r1'))).toBe(await hashProducerTree(join(f.dir, 'r2')));
  });

  test('a different FILE SET is nondeterminism, even at identical bytes', async () => {
    // A hash over concatenated contents alone would call {a:'x',b:'y'} and
    // {ab:'xy'} the same tree, and a producer emitting a different set every
    // run is exactly as unbootstrappable as one emitting different bytes.
    const f = await fixture();
    await f.write('s1/a.txt', 'x');
    await f.write('s1/b.txt', 'y');
    await f.write('s2/ab.txt', 'xy');
    expect(await hashProducerTree(join(f.dir, 's1'))).not.toBe(
      await hashProducerTree(join(f.dir, 's2')),
    );
  });

  test('a renamed file changes the digest', async () => {
    const f = await fixture();
    await f.write('n1/a.txt', 'x');
    await f.write('n2/b.txt', 'x');
    expect(await hashProducerTree(join(f.dir, 'n1'))).not.toBe(
      await hashProducerTree(join(f.dir, 'n2')),
    );
  });

  test('an absent dir digests as the empty tree instead of throwing', async () => {
    const f = await fixture();
    await mkdir(join(f.dir, 'empty'), { recursive: true });
    expect(await hashProducerTree(join(f.dir, 'missing'))).toBe(
      await hashProducerTree(join(f.dir, 'empty')),
    );
  });

  test('a symlinked directory is not followed', async () => {
    // Following one would make the digest depend on a tree nobody is
    // measuring, and a cycle would hang the walk.
    const f = await fixture();
    await f.write('outside/secret.txt', 'z');
    await mkdir(join(f.dir, 'l1'), { recursive: true });
    await f.write('l1/a.txt', 'x');
    await symlink(join(f.dir, 'outside'), join(f.dir, 'l1', 'link'));
    await f.write('l2/a.txt', 'x');
    expect(await hashProducerTree(join(f.dir, 'l1'))).toBe(await hashProducerTree(join(f.dir, 'l2')));
  });
});
