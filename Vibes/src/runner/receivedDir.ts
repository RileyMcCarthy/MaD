/**
 * The received directory — gitignored scratch that `$VIBES_OUT_DIR` points at.
 *
 * This module owns the only `rm -rf` in the tool, so it is the only place where
 * a resolution bug can destroy a user's work. Every call is therefore gated by
 * a shape assertion that cannot be satisfied by anything except a path of the
 * exact form `<repoRoot>/.vibes/received/<component>/<producer>` — no symlinked
 * ancestors, no `..`, no fewer segments.
 *
 * WHY wipe at all (`clean` defaults TRUE in types.ts): without it, output from
 * a corpus entry that has since been DELETED lingers in the directory and
 * compares byte-equal to its baseline. The deletion is then invisible, which is
 * precisely the change an honesty tool exists to surface.
 */

import { lstatSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { RECEIVED_DIR, STATE_DIR } from './constants.js';

export class UnsafeReceivedDirError extends Error {
  readonly received: string;
  readonly repoRoot: string;
  readonly reason: string;

  constructor(repoRoot: string, received: string, reason: string) {
    super(`refusing to clean ${received}: ${reason}`);
    this.name = 'UnsafeReceivedDirError';
    this.repoRoot = repoRoot;
    this.received = received;
    this.reason = reason;
  }
}

/** `<repoRoot>/.vibes/received/<component>/<producer>` — the only legal shape. */
export function receivedDirFor(repoRoot: string, component: string, producer: string): string {
  return join(resolve(repoRoot), STATE_DIR, RECEIVED_DIR, component, producer);
}

export function receivedRepoPath(component: string, producer: string): string {
  return `${STATE_DIR}/${RECEIVED_DIR}/${component}/${producer}`;
}

/**
 * Throws unless `received` is exactly a producer scratch dir under `repoRoot`.
 *
 * Deliberately strict about the segment COUNT. `.vibes/received` on its own
 * would wipe every producer's output including ones already finished, and
 * `.vibes` would take the logs, the report and the committed policy lock with
 * it.
 */
export function assertSafeReceivedDir(repoRoot: string, received: string): void {
  const root = resolve(repoRoot);
  const abs = resolve(received);
  const fail = (reason: string): never => {
    throw new UnsafeReceivedDirError(root, abs, reason);
  };

  if (!isAbsolute(abs)) fail('not an absolute path');
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) fail('outside the repo root');

  const segments = rel.split(sep);
  if (segments.length !== 4) {
    fail(`expected ${STATE_DIR}/${RECEIVED_DIR}/<component>/<producer>, got ${rel}`);
  }
  if (segments[0] !== STATE_DIR || segments[1] !== RECEIVED_DIR) {
    fail(`expected ${STATE_DIR}/${RECEIVED_DIR}/… prefix, got ${rel}`);
  }
  if (segments.some((s) => s === '' || s === '.' || s === '..')) fail(`degenerate segment in ${rel}`);

  // A symlinked ancestor turns the containment check above into a lie: the
  // lexical path stays inside the repo while the deletion lands elsewhere.
  let probe = root;
  for (const segment of segments) {
    probe = join(probe, segment);
    let st;
    try {
      st = lstatSync(probe);
    } catch {
      break; // does not exist yet — nothing to delete through
    }
    if (st.isSymbolicLink()) fail(`${probe} is a symlink`);
  }
}

export interface PrepareResult {
  readonly dir: string;
  readonly wiped: boolean;
}

export async function prepareReceivedDir(
  repoRoot: string,
  received: string,
  clean: boolean,
): Promise<PrepareResult> {
  assertSafeReceivedDir(repoRoot, received);
  const dir = resolve(received);
  if (clean) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return { dir, wiped: clean };
}
