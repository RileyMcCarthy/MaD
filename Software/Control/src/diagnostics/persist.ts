/**
 * Crash-survivable log persistence (main thread).
 *
 * The in-memory ring dies with the page, which is the wrong behaviour for the
 * case people most often report: the app froze or crashed, so they reloaded —
 * and reloading destroys the only evidence of what went wrong. This mirrors the
 * merged timeline into IndexedDB as it is produced, so the *previous* session's
 * log is still there after a restart and rides along in the next bug report.
 *
 * Design constraints:
 *  - Never on the hot path. Entries are buffered and flushed on a timer, plus
 *    on `visibilitychange`, which is the last reliable moment before a tab dies.
 *  - Never able to break the app. Every IndexedDB call is best-effort; a denied
 *    quota or a private-mode failure degrades to "no persistence", not an error.
 *  - Bounded. One record per session, oldest sessions pruned, entries capped —
 *    diagnostics must not grow without limit in someone's browser profile.
 */

import { logSnapshot, subscribeLog, type LogEntry } from './log';

const DB_NAME = 'mad-diagnostics';
const DB_VERSION = 1;
const STORE = 'sessions';

/** Sessions retained, newest first. Two prior sessions is plenty of history. */
export const MAX_SESSIONS = 3;
/** Entries persisted per session — the tail is what matters after a crash. */
export const MAX_PERSISTED_ENTRIES = 2000;
/** Flush cadence. Slow enough to be free, fast enough to survive a hard crash. */
const FLUSH_INTERVAL_MS = 5000;

export interface PersistedSession {
  id: string;
  startedAt: number;
  updatedAt: number;
  entries: LogEntry[];
  /** True once the session ended cleanly, so a crash is distinguishable. */
  closed: boolean;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/** Sessions in the store, newest first. */
export async function readPersistedSessions(): Promise<PersistedSession[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE, 'readonly');
    const all = await idbRequest(tx.objectStore(STORE).getAll() as IDBRequest<PersistedSession[]>);
    return (all ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * The most recent session that is not this one — i.e. what was lost to a
 * reload. `closed: false` on it means the page went away without a clean
 * shutdown, which is itself a strong diagnostic signal.
 */
export async function readPreviousSession(currentId: string): Promise<PersistedSession | null> {
  const sessions = await readPersistedSessions();
  return sessions.find((s) => s.id !== currentId) ?? null;
}

export interface LogPersistence {
  sessionId: string;
  flush(): Promise<void>;
  /** Mark the session cleanly ended and stop persisting. */
  close(): Promise<void>;
}

/**
 * Start mirroring the log to IndexedDB.
 *
 * `sessionId` must be stable for the life of the page; the caller supplies it
 * so the same id can be stamped into an exported bundle.
 */
export function startLogPersistence(sessionId: string): LogPersistence {
  let pending: LogEntry[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let closed = false;
  let writing = false;

  const unsubscribe = subscribeLog((entry) => {
    pending.push(entry);
  });

  async function write(): Promise<void> {
    // Overlapping writes would interleave read-modify-write on one record.
    if (writing || stopped) return;
    if (pending.length === 0 && !closed) return;
    writing = true;
    const batch = pending;
    pending = [];
    const db = await openDb();
    if (!db) {
      writing = false;
      return;
    }
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const existing = await idbRequest(store.get(sessionId) as IDBRequest<PersistedSession>);
      const snap = logSnapshot();
      const merged = [...(existing?.entries ?? []), ...batch];
      const record: PersistedSession = {
        id: sessionId,
        startedAt: existing?.startedAt ?? snap.startedAt,
        updatedAt: Date.now(),
        // Keep the tail: after a crash the last entries are the interesting ones.
        entries: merged.slice(-MAX_PERSISTED_ENTRIES),
        closed,
      };
      store.put(record);

      // Prune here rather than on a separate pass — this is the only writer.
      const all = await idbRequest(store.getAll() as IDBRequest<PersistedSession[]>);
      const ordered = (all ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const old of ordered.slice(MAX_SESSIONS)) store.delete(old.id);
    } catch {
      // Quota, private mode, or a closed connection. Persistence is a bonus.
    } finally {
      db.close();
      writing = false;
    }
  }

  const onVisibility = (): void => {
    // The last reliable moment before a tab is discarded — `beforeunload` is
    // not fired for crashes and is deliberately unused elsewhere in this app.
    if (document.visibilityState === 'hidden') void write();
  };
  document.addEventListener('visibilitychange', onVisibility);
  timer = setInterval(() => void write(), FLUSH_INTERVAL_MS);

  return {
    sessionId,
    flush: write,
    async close() {
      closed = true;
      await write();
      stopped = true;
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

/** Remove every persisted session (used by the report preview's discard path). */
export async function clearPersistedSessions(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
  } catch {
    // Best-effort.
  } finally {
    db.close();
  }
}
