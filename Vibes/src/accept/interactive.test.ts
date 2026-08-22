import { afterEach, describe, expect, test } from 'vitest';

import { buildPlan } from './plan.js';
import { candidateKey, renderCandidate, reviewCandidates } from './interactive.js';
import { fakeIo, makeFixture, snap, target, type AcceptFixture } from './fixtures.test.js';

const live: AcceptFixture[] = [];
async function fixture(): Promise<AcceptFixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

async function twoCandidates(f: AcceptFixture) {
  await f.baseline('a.gcode', 'G0 X1\n');
  await f.baseline('b.gcode', 'G0 Y1\n');
  await f.received('a.gcode', 'G0 X2\n');
  await f.received('b.gcode', 'G0 Y2\n');
  return buildPlan([
    target(f, { files: [snap({ file: 'a.gcode' }), snap({ file: 'b.gcode' })] }),
  ]).candidates;
}

describe('reviewCandidates', () => {
  test('records accept / reject / skip per file', async () => {
    const f = await fixture();
    const cs = await twoCandidates(f);
    const io = fakeIo(['a', 'r']);
    const out = await reviewCandidates(cs, io);
    expect(out.quit).toBe(false);
    expect(out.decisions.get(candidateKey(cs[0]!))).toBe('accept');
    expect(out.decisions.get(candidateKey(cs[1]!))).toBe('reject');
  });

  test('y and n are accepted as synonyms, s skips', async () => {
    const f = await fixture();
    const cs = await twoCandidates(f);
    const out = await reviewCandidates(cs, fakeIo(['y', 's']));
    expect(out.decisions.get(candidateKey(cs[0]!))).toBe('accept');
    expect(out.decisions.get(candidateKey(cs[1]!))).toBe('skip');
  });

  test('q aborts the WHOLE invocation, not just this file', async () => {
    // Applying what was accepted so far would commit a half-finished review
    // under a receipt claiming the batch was reviewed.
    const f = await fixture();
    const cs = await twoCandidates(f);
    const out = await reviewCandidates(cs, fakeIo(['a', 'q']));
    expect(out.quit).toBe(true);
  });

  test('EOF mid-review is an abort, never consent', async () => {
    const f = await fixture();
    const cs = await twoCandidates(f);
    const io = fakeIo([]); // the pipe closed
    const out = await reviewCandidates(cs, io);
    expect(out.quit).toBe(true);
    expect(out.decisions.size).toBe(0);
    expect(io.starved.length).toBe(1);
  });

  test('d toggles the full diff and re-prompts the same file', async () => {
    const f = await fixture();
    const cs = await twoCandidates(f);
    const io = fakeIo(['d', 'a', 'a']);
    const out = await reviewCandidates(cs, io, { previewLines: 1 });
    expect(out.decisions.size).toBe(2);
    expect(io.text()).toContain('press d to show them all');
  });

  test('an unrecognised key explains itself without reprinting the diff', async () => {
    const f = await fixture();
    const cs = await twoCandidates(f);
    const io = fakeIo(['zz', 'a', 'a']);
    await reviewCandidates(cs, io);
    expect(io.text()).toContain('Unrecognised.');
    // The file header is printed once per candidate, not once per keypress.
    expect(io.text().match(/\(1\/2\)/g)).toHaveLength(1);
  });

  test('a deletion is announced in words, because there is no diff to read', async () => {
    const f = await fixture();
    await f.baseline('gone.gcode', 'G0 X1\n');
    const cs = buildPlan([
      target(f, { files: [snap({ file: 'gone.gcode', verdict: 'deleted' })] }),
    ]).candidates;
    const io = fakeIo(['a']);
    await reviewCandidates(cs, io);
    expect(io.text()).toContain('Accepting REMOVES it from the corpus');
    expect(io.text()).toContain('DELETE');
  });
});

describe('renderCandidate', () => {
  test('shows the same blocks the report will, as markdown', async () => {
    // If the terminal view and the report view were built separately they
    // would drift, and "I reviewed it" would refer to something no reviewer of
    // the PR can see.
    const f = await fixture();
    const cs = await twoCandidates(f);
    const text = await renderCandidate(cs[0]!);
    expect(text).toContain('G0 X1');
    expect(text).toContain('G0 X2');
  });

  test('an added file renders without a baseline on disk', async () => {
    const f = await fixture();
    await f.received('new.gcode', 'G0 Z9\n');
    const cs = buildPlan([
      target(f, { files: [snap({ file: 'new.gcode', verdict: 'added' })] }),
    ]).candidates;
    expect(await renderCandidate(cs[0]!)).toContain('G0 Z9');
  });
});
