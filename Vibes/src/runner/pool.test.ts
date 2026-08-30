/**
 * The scheduler.
 *
 * These tests exist because `p-limit` would have passed a "does it bound
 * concurrency" test and still corrupted every run: the constraint that matters
 * is "these two producers may never overlap because they both drive the single
 * machine-global emulator", which is not a number.
 */

import { describe, expect, test } from 'vitest';

import { findCycles, runPool, type PoolTask } from './pool.js';
import { sleep } from './fixtures.test.js';

interface Trace {
  readonly starts: string[];
  readonly ends: string[];
  peak: number;
  live: number;
}

function tracer(): { trace: Trace; run: (t: PoolTask) => Promise<string> } {
  const trace: Trace = { starts: [], ends: [], peak: 0, live: 0 };
  return {
    trace,
    run: async (t: PoolTask): Promise<string> => {
      trace.starts.push(t.id);
      trace.live += 1;
      trace.peak = Math.max(trace.peak, trace.live);
      await sleep(20);
      trace.live -= 1;
      trace.ends.push(t.id);
      return t.id.toUpperCase();
    },
  };
}

const task = (id: string, after: string[] = [], resources: string[] = []): PoolTask => ({
  id,
  after,
  resources,
});

describe('mutual exclusion', () => {
  test('two tasks sharing a resource token NEVER overlap, even with room to spare', async () => {
    // The SIL emulator is documented single-instance. A count-based limiter set
    // to 4 would happily run both of these at once.
    const { trace, run } = tracer();
    const tasks = [
      task('a', [], ['sil-emulator']),
      task('b', [], ['sil-emulator']),
      task('c', [], ['other']),
    ];
    const r = await runPool(tasks, run, { concurrency: 4 });

    expect(r.results.size).toBe(3);
    expect(trace.peak).toBeLessThanOrEqual(2); // a|b serialised, c free
    // a and b never interleave: whichever starts first also ends first.
    const first = trace.starts.find((id) => id === 'a' || id === 'b');
    expect(trace.ends.filter((id) => id === 'a' || id === 'b')[0]).toBe(first);
  });

  test('a partial token overlap is still an overlap', async () => {
    const { trace, run } = tracer();
    await runPool(
      [task('a', [], ['pty:/tmp/tty.rpi', 'port:9999']), task('b', [], ['port:9999'])],
      run,
      { concurrency: 4 },
    );
    expect(trace.peak).toBe(1);
  });

  test('the token is released when its holder finishes, including on failure', async () => {
    const order: string[] = [];
    const r = await runPool(
      [task('a', [], ['tok']), task('b', [], ['tok'])],
      async (t) => {
        order.push(t.id);
        if (t.id === 'a') throw new Error('boom');
        await sleep(5);
        return t.id;
      },
      { concurrency: 4 },
    );
    expect(order).toEqual(['a', 'b']);
    expect(r.errors.get('a')?.message).toBe('boom');
    expect(r.results.get('b')).toBe('b');
  });
});

describe('ordering', () => {
  test('an `after` edge is honoured', async () => {
    const { trace, run } = tracer();
    await runPool([task('b', ['a']), task('a')], run, { concurrency: 4 });
    expect(trace.starts.indexOf('a')).toBeLessThan(trace.starts.indexOf('b'));
    expect(trace.ends.indexOf('a')).toBeLessThan(trace.starts.indexOf('b'));
  });

  test('a FAILED dependency does not cancel its dependents', async () => {
    // One bad producer must never abort the rest of the run: the report is more
    // useful with nine honest rows and one failure than with one failure.
    const seen: string[] = [];
    const r = await runPool(
      [task('a'), task('b', ['a'])],
      async (t) => {
        seen.push(t.id);
        if (t.id === 'a') throw new Error('nope');
        return t.id;
      },
      { concurrency: 2 },
    );
    expect(seen).toEqual(['a', 'b']);
    expect(r.results.get('b')).toBe('b');
  });

  test('an `after` edge naming an unknown id is satisfied, not blocking', async () => {
    // The plan validates the graph. A scheduler that deadlocked on bad config
    // would produce no report at all, which is the worst outcome for this tool.
    const r = await runPool([task('a', ['ghost/producer'])], async (t) => t.id, { concurrency: 1 });
    expect(r.results.get('a')).toBe('a');
    expect(r.deadlocked).toEqual([]);
  });

  test('scheduling is deterministic in id order', async () => {
    const runs: string[][] = [];
    for (let i = 0; i < 3; i += 1) {
      const starts: string[] = [];
      await runPool(
        [task('zeta'), task('alpha'), task('mid')],
        async (t) => {
          starts.push(t.id);
          return t.id;
        },
        { concurrency: 1 },
      );
      runs.push(starts);
    }
    expect(runs[0]).toEqual(['alpha', 'mid', 'zeta']);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});

describe('limits and failure modes', () => {
  test('concurrency bounds the count', async () => {
    const { trace, run } = tracer();
    await runPool(['a', 'b', 'c', 'd', 'e'].map((id) => task(id)), run, { concurrency: 2 });
    expect(trace.peak).toBe(2);
  });

  test('a cycle is reported as deadlocked instead of hanging', async () => {
    const r = await runPool([task('a', ['b']), task('b', ['a'])], async (t) => t.id, {
      concurrency: 2,
    });
    expect(r.deadlocked).toEqual(['a', 'b']);
    expect(r.results.size).toBe(0);
  });

  test('an aborted signal cancels what has not started', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runPool([task('a'), task('b')], async (t) => t.id, {
      concurrency: 1,
      signal: controller.signal,
    });
    expect(r.cancelled).toEqual(['a', 'b']);
    expect(r.results.size).toBe(0);
  });

  test('a run function that throws SYNCHRONOUSLY is captured, not spun on', async () => {
    // Regression: an async IIFE runs synchronously up to its first await, so a
    // synchronous throw reached the `finally` — and deleted the task from
    // `inflight` — before it was ever added, leaving the loop racing an entry it
    // could never remove.
    const r = await runPool(
      [task('a'), task('b')],
      ((t: PoolTask) => {
        if (t.id === 'a') throw new Error('sync boom');
        return Promise.resolve(t.id);
      }) as (t: PoolTask) => Promise<string>,
      { concurrency: 2 },
    );
    expect(r.errors.get('a')?.message).toBe('sync boom');
    expect(r.results.get('b')).toBe('b');
  }, 2_000);

  test('an empty plan settles immediately', async () => {
    const r = await runPool([], async (t: PoolTask) => t.id, { concurrency: 4 });
    expect(r.results.size).toBe(0);
    expect(r.deadlocked).toEqual([]);
  });
});

describe('findCycles', () => {
  test('names the participants of a cycle', () => {
    expect(findCycles([task('a', ['b']), task('b', ['c']), task('c', ['a'])])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('a DAG has none, and an unknown edge is not a cycle', () => {
    expect(findCycles([task('a'), task('b', ['a']), task('c', ['a', 'b'])])).toEqual([]);
    expect(findCycles([task('a', ['nope'])])).toEqual([]);
  });

  test('a self-edge is a cycle', () => {
    expect(findCycles([task('a', ['a'])])).toEqual(['a']);
  });
});
