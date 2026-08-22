/**
 * The scheduler.
 *
 * WHY THIS IS HAND-ROLLED (~90 lines) rather than `p-limit` / `p-queue` /
 * `p-map`: those bound a COUNT. The constraint that actually matters here is
 * "these two producers may never overlap because they both drive the single
 * machine-global SIL emulator", plus `dependsOn` ordering edges between
 * components. Neither is expressible as a concurrency number, and a wrapper
 * that pretends otherwise would let the first author who adds an emulator
 * producer silently corrupt every concurrent run.
 *
 * Determinism: tasks are sorted by id and the ready-scan walks that order, so
 * the same plan schedules the same way every time. That matters because the
 * report is an artifact people diff.
 */

export interface PoolTask {
  readonly id: string;
  /** Task ids that must COMPLETE first. Ordering only — a failed dependency
   *  does not cancel its dependents, because one bad producer must never abort
   *  the rest of the run. */
  readonly after: readonly string[];
  /** Mutual-exclusion tokens. Two tasks sharing any token never overlap. */
  readonly resources: readonly string[];
}

export interface PoolOptions {
  readonly concurrency: number;
  readonly signal?: AbortSignal | undefined;
}

export interface PoolResult<R> {
  readonly results: ReadonlyMap<string, R>;
  /** Never started: the run was aborted before they became ready. */
  readonly cancelled: readonly string[];
  /** Never startable: a cycle, or a resource set that can never be satisfied. */
  readonly deadlocked: readonly string[];
  /** `run` threw. It is not supposed to; callers wrap their own failures. */
  readonly errors: ReadonlyMap<string, Error>;
}

export async function runPool<T extends PoolTask, R>(
  tasks: readonly T[],
  run: (task: T) => Promise<R>,
  opts: PoolOptions,
): Promise<PoolResult<R>> {
  const ordered = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const known = new Set(ordered.map((t) => t.id));
  const pending = new Map<string, T>(ordered.map((t) => [t.id, t]));
  const inflight = new Map<string, Promise<void>>();
  const held = new Set<string>();
  const done = new Set<string>();
  const results = new Map<string, R>();
  const errors = new Map<string, Error>();
  const cancelled: string[] = [];
  let deadlocked: string[] = [];

  const limit = Math.max(1, Math.floor(opts.concurrency));
  // An `after` edge naming an unknown id is satisfied rather than blocking
  // forever: the plan validates the graph, and a scheduler that deadlocks on
  // bad config produces no report at all — the worst outcome for this tool.
  const ready = (t: T): boolean => t.after.every((d) => !known.has(d) || done.has(d));
  const free = (t: T): boolean => t.resources.every((r) => !held.has(r));

  for (;;) {
    if (opts.signal?.aborted === true && pending.size > 0) {
      cancelled.push(...pending.keys());
      pending.clear();
    }

    let started = false;
    for (const task of [...pending.values()]) {
      if (inflight.size >= limit) break;
      if (!ready(task) || !free(task)) continue;

      pending.delete(task.id);
      for (const r of task.resources) held.add(r);
      started = true;

      // `Promise.resolve().then` and not a bare async IIFE: an IIFE body runs
      // SYNCHRONOUSLY up to its first `await`, so a `run` that throws before
      // returning a promise would reach the `finally` — and delete this task
      // from `inflight` — before the `.set` below ever put it there. The loop
      // would then spin forever on an entry that can never be removed. Deferring
      // to a microtask makes the ordering unconditional rather than incidental.
      const promise = Promise.resolve().then(async () => {
        try {
          results.set(task.id, await run(task));
        } catch (e) {
          errors.set(task.id, e instanceof Error ? e : new Error(String(e)));
        } finally {
          for (const r of task.resources) held.delete(r);
          done.add(task.id);
          inflight.delete(task.id);
        }
      });
      inflight.set(task.id, promise);
    }

    if (inflight.size === 0) {
      if (pending.size === 0) break;
      if (!started) {
        // Nothing running, nothing startable: either a cycle, or a task whose
        // resource set can never be released. Report it instead of hanging.
        deadlocked = [...pending.keys()].sort();
        break;
      }
      continue;
    }

    await Promise.race(inflight.values());
  }

  return { results, cancelled: cancelled.sort(), deadlocked, errors };
}

/**
 * Cycle detection over `after` edges (Kahn).
 *
 * Config already rejects `dependsOn` cycles, and the pool degrades to
 * `deadlocked` rather than hanging, but a cycle discovered at PREFLIGHT names
 * the components involved — which the pool's "nothing was startable" cannot.
 */
export function findCycles(tasks: readonly PoolTask[]): readonly string[] {
  const known = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    const deps = t.after.filter((d) => known.has(d));
    indegree.set(t.id, deps.length);
    for (const d of deps) {
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [t.id]);
      else list.push(t.id);
    }
  }
  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let settled = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    settled += 1;
    for (const dep of dependents.get(id) ?? []) {
      const n = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, n);
      if (n === 0) queue.push(dep);
    }
  }
  if (settled === tasks.length) return [];
  return [...indegree.entries()]
    .filter(([, n]) => n > 0)
    .map(([id]) => id)
    .sort();
}
