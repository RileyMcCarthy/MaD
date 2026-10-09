/**
 * Callbacks that cross the worker boundary.
 *
 * A function the main thread hands the device worker (the event sink, the log
 * sink, a download progress callback) arrives as a Comlink proxy. A Comlink
 * proxy only looks like a function: every property read on it becomes another
 * step in a remote path, `bind` and `then` excepted. So `proxy.call(self, x)` is
 * a remote call to a function named "call" whose first argument is `self`, and
 * Comlink has to structured-clone `self` to send it. A worker object is not
 * cloneable (it holds stream readers, promises, timers), so the post throws a
 * `DataCloneError`, the returned promise rejects, and nothing arrives.
 *
 * Bundlers emit exactly that shape for an optional call on a member: with
 * Vite's default `build.target`, esbuild lowers `this.sink?.(events)` to
 * `(n = this.sink) == null || n.call(this, events)`. The dev server does not
 * lower it, so the failure exists only in the production bundle.
 *
 * `boundaryCallback` turns the proxy into a plain local function that makes one
 * bare call on it. Store and call THAT, never the proxy: however a transpiler
 * rewrites the call site, `.call`/`.apply` then land on a real function.
 */

/**
 * Wrap a callback that arrived over Comlink as a plain function.
 *
 * The returned function resolves when the other thread has run the callback
 * and rejects with whatever stopped it (a clone failure, a released proxy, a
 * throw on the far side), so the caller can report a delivery that failed.
 */
export function boundaryCallback<A>(remote: (arg: A) => unknown): (arg: A) => Promise<void> {
  return async (arg: A): Promise<void> => {
    await remote(arg);
  };
}
