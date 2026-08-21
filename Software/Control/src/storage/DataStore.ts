/**
 * Persistent storage over the File System Access API.
 *
 * Mirrors the desktop `dataManager` on-disk layout so files are interchangeable
 * with the on-disk layout:
 *   <dataDir>/sampleProfiles/<name>.json
 *   <dataDir>/motionProfiles/<name>.json
 *   <dataDir>/sets/<name>.json
 *   <dataDir>/testRuns/<testName>.json    (metadata)
 *   <dataDir>/testRuns/<testName>.csv     (sample data)
 *   <dataDir>/testRuns/index.json         (lightweight manifest)
 *
 * The chosen directory handle is persisted in IndexedDB so it survives reloads
 * (the browser re-prompts for permission as required). A small settings record
 * (the monotonic test counter) also lives in IndexedDB.
 */

import { get as idbGet, set as idbSet } from 'idb-keyval';
import {
  SampleProfileEntry,
  MotionProfileEntry,
  TestRunEntry,
  Set as MotionSet,
} from '@/domain';
import { logger, nowMs } from '@/diagnostics/log';

// Folder *names* are logged (they identify which data folder the user picked);
// full paths and file contents never are — a bundle can end up in a public issue.
const logFs = logger('fs');

const DIR_HANDLE_KEY = 'mad.dataDirHandle';
const TEST_COUNTER_KEY = 'mad.testCounter';

const SAMPLE_PROFILES_DIR = 'sampleProfiles';
const MOTION_PROFILES_DIR = 'motionProfiles';
const SETS_DIR = 'sets';
const TEST_RUNS_DIR = 'testRuns';
const TEST_INDEX_FILE = 'index.json';

/** Lightweight test-run manifest row for fast listing. */
export interface TestRunIndexRow {
  id: string;
  testName: string;
  startedAt: string;
  completedAt?: string;
  status: TestRunEntry['status'];
  sampleProfileName?: string;
  motionProfileName?: string;
}

function sanitizeName(name: string): string {
  return (name || 'untitled').replace(/[^a-z0-9_-]/gi, '_');
}

export class DataStore {
  private root: FileSystemDirectoryHandle | null = null;

  /** A restored handle that still needs a user gesture to re-grant permission
   *  (or whose folder couldn't be reached). Kept so requestPermission/Settings
   *  can recover it — never silently discarded. */
  private pendingHandle: FileSystemDirectoryHandle | null = null;

  /** Serializes mutating operations so a read-modify-write of index.json (or any
   *  shared file) from two callers can't interleave and drop an update. Only
   *  PUBLIC entry points go through this — internal helpers must not, or they'd
   *  deadlock waiting on the chain they're already part of. */
  private mutex: Promise<unknown> = Promise.resolve();

  private run<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    const started = nowMs();
    const next = this.mutex.then(fn, fn);
    // Keep the chain alive even if this op rejects (callers still see the error).
    this.mutex = next.then(
      () => undefined,
      () => undefined,
    );
    // Every public op funnels through here, so this one hook covers the whole
    // surface. Failures matter most: a quota or revoked-permission error is the
    // usual cause of "my test didn't save", and it is otherwise silent.
    if (label !== undefined) {
      void next.then(
        () => {
          logFs.debug(label, undefined, { durMs: Math.round(nowMs() - started) });
        },
        (err: unknown) => {
          logFs.error(label, err instanceof Error ? err.message : String(err), {
            durMs: Math.round(nowMs() - started),
            name: err instanceof Error ? err.name : undefined,
          });
        },
      );
    }
    return next;
  }

  /** Whether a usable (granted + reachable) data directory is connected. */
  get connected(): boolean {
    return this.root !== null;
  }

  /** True when a folder was remembered but needs a gesture to re-grant access. */
  get needsPermission(): boolean {
    return this.root === null && this.pendingHandle !== null;
  }

  /** Prompt the user to choose a data directory (needs a user gesture). */
  async chooseDirectory(): Promise<void> {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    logFs.info('folder-chosen', undefined, { name: handle.name });
    this.root = handle;
    this.pendingHandle = null;
    await idbSet(DIR_HANDLE_KEY, handle);
    // Ask the browser to keep our IndexedDB (folder handle + test counter) from
    // being evicted under storage pressure. Best-effort; ignore the result.
    void requestPersistentStorage();
  }

  /** Try to restore the previously chosen directory; returns true on success.
   *  Never deletes the remembered handle — an un-granted or briefly unreachable
   *  folder becomes `pendingHandle` (recoverable via requestPermission) so a
   *  transient hiccup can't silently wipe the user's saved choice. */
  async restoreDirectory(): Promise<boolean> {
    const handle = await idbGet<FileSystemDirectoryHandle>(DIR_HANDLE_KEY);
    if (!handle) {
      logFs.info('folder-restore', 'no remembered folder');
      return false;
    }
    if (!(await verifyPermission(handle, false))) {
      this.pendingHandle = handle; // needs a user gesture to re-grant
      logFs.warn('folder-restore', 'permission not granted', { name: handle.name });
      return false;
    }
    // A granted handle can still be unreachable (folder moved) — probe it, but
    // keep it pending rather than discarding on a transient failure.
    try {
      await handle.keys().next();
    } catch (err) {
      this.pendingHandle = handle;
      logFs.warn('folder-restore', 'folder unreachable', {
        name: handle.name,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    this.root = handle;
    this.pendingHandle = null;
    logFs.info('folder-restore', 'restored', { name: handle.name });
    return true;
  }

  /** Re-request read/write permission (call from a user gesture). */
  async requestPermission(): Promise<boolean> {
    const handle = this.root ?? this.pendingHandle;
    if (!handle) return false;
    const ok = await verifyPermission(handle, true);
    logFs.info('folder-permission', ok ? 'granted' : 'denied', { name: handle.name });
    if (ok) {
      this.root = handle;
      this.pendingHandle = null;
    }
    return ok;
  }

  get directoryName(): string | null {
    return (this.root ?? this.pendingHandle)?.name ?? null;
  }

  // ── Sample profiles ──

  async getSampleProfiles(): Promise<SampleProfileEntry[]> {
    return this.readAllJson<SampleProfileEntry>(SAMPLE_PROFILES_DIR);
  }

  async saveSampleProfile(entry: SampleProfileEntry, overwrite = false): Promise<boolean> {
    return this.run(() => this.saveJsonUnique(SAMPLE_PROFILES_DIR, entry.name, entry, overwrite), 'saveSampleProfile');
  }

  async deleteSampleProfile(id: string): Promise<void> {
    await this.run(() => this.deleteJsonById(SAMPLE_PROFILES_DIR, id), 'deleteSampleProfile');
  }

  // ── Motion profiles ──

  async getMotionProfiles(): Promise<MotionProfileEntry[]> {
    return this.readAllJson<MotionProfileEntry>(MOTION_PROFILES_DIR);
  }

  async saveMotionProfile(entry: MotionProfileEntry, overwrite = false): Promise<boolean> {
    return this.run(() => this.saveJsonUnique(MOTION_PROFILES_DIR, entry.name, entry, overwrite), 'saveMotionProfile');
  }

  async deleteMotionProfile(id: string): Promise<void> {
    await this.run(() => this.deleteJsonById(MOTION_PROFILES_DIR, id), 'deleteMotionProfile');
  }

  // ── Sets ──

  async getSets(): Promise<MotionSet[]> {
    return this.readAllJson<MotionSet>(SETS_DIR);
  }

  async saveSet(set: MotionSet, overwrite = false): Promise<boolean> {
    return this.run(() => this.saveJsonUnique(SETS_DIR, set.name, set, overwrite), 'saveSet');
  }

  // ── Test runs ──

  /**
   * Reserve the next monotonic six-digit test name.
   *
   * The name is also the filename for the .json/.csv, so it must never collide
   * with an existing run in the *current folder*: we take max(origin counter,
   * highest existing numeric name in the folder) + 1. The origin-scoped counter
   * is a floor (kept monotonic per browser profile); the folder scan prevents a
   * fresh profile / cleared site / folder switch from overwriting real results.
   */
  async nextTestName(): Promise<string> {
    return this.run(async () => {
      const floor = (await idbGet<number>(TEST_COUNTER_KEY)) ?? 0;
      let maxExisting = 0;
      if (this.root) {
        const dir = await this.subdir(TEST_RUNS_DIR);
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind !== 'file') continue;
          const m = /^(\d{1,9})\.(json|csv)$/.exec(name);
          if (m) maxExisting = Math.max(maxExisting, parseInt(m[1], 10));
        }
      }
      const next = Math.max(floor, maxExisting) + 1;
      await idbSet(TEST_COUNTER_KEY, next);
      return String(next).padStart(6, '0');
    }, 'nextTestName');
  }

  async getTestRunIndex(): Promise<TestRunIndexRow[]> {
    if (!this.root) return [];
    const dir = await this.subdir(TEST_RUNS_DIR);
    const rows = await readJsonFile<TestRunIndexRow[]>(dir, TEST_INDEX_FILE);
    if (rows && rows.length > 0) return rows;
    // Index missing/empty/corrupt: if run files exist on disk, rebuild from them
    // so runs (e.g. copied in by hand, or after a half-written index)
    // never silently vanish from History. Treat index.json as a cache only.
    if (await this.hasAnyRunFiles(dir)) return this.rebuildIndex();
    return rows ?? [];
  }

  /** Rebuild index.json by enumerating the per-run .json files (source of truth). */
  async rebuildIndex(): Promise<TestRunIndexRow[]> {
    return this.run(async () => {
      if (!this.root) return [];
      const dir = await this.subdir(TEST_RUNS_DIR);
      const rows: TestRunIndexRow[] = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file' || !name.endsWith('.json') || name === TEST_INDEX_FILE) continue;
        const entry = await readJsonFile<TestRunEntry>(dir, name);
        if (entry?.id && entry.testName) rows.push(indexRow(entry));
      }
      rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)); // newest first
      await writeJsonFile(dir, TEST_INDEX_FILE, rows);
      return rows;
    }, 'rebuildIndex');
  }

  private async hasAnyRunFiles(dir: FileSystemDirectoryHandle): Promise<boolean> {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && name.endsWith('.json') && name !== TEST_INDEX_FILE) return true;
    }
    return false;
  }

  async getTestRun(testName: string): Promise<TestRunEntry | null> {
    const dir = await this.subdir(TEST_RUNS_DIR);
    return readJsonFile<TestRunEntry>(dir, `${sanitizeName(testName)}.json`);
  }

  async createTestRun(entry: TestRunEntry): Promise<void> {
    return this.run(async () => {
      const dir = await this.subdir(TEST_RUNS_DIR);
      await writeJsonFile(dir, `${sanitizeName(entry.testName)}.json`, entry);
      await this.updateIndex((rows) => [indexRow(entry), ...rows.filter((r) => r.id !== entry.id)]);
    }, 'createTestRun');
  }

  async updateTestRun(testName: string, patch: Partial<TestRunEntry>): Promise<void> {
    return this.run(async () => {
      const existing = await this.getTestRun(testName);
      if (!existing) return;
      const merged = { ...existing, ...patch };
      const dir = await this.subdir(TEST_RUNS_DIR);
      await writeJsonFile(dir, `${sanitizeName(testName)}.json`, merged);
      await this.updateIndex((rows) => rows.map((r) => (r.id === merged.id ? indexRow(merged) : r)));
    }, 'updateTestRun');
  }

  async deleteTestRun(testName: string): Promise<void> {
    return this.run(async () => {
      const dir = await this.subdir(TEST_RUNS_DIR);
      const base = sanitizeName(testName);
      const existing = await this.getTestRun(testName);
      await removeIfExists(dir, `${base}.json`);
      await removeIfExists(dir, `${base}.csv`);
      if (existing) {
        await this.updateIndex((rows) => rows.filter((r) => r.id !== existing.id));
      }
    }, 'deleteTestRun');
  }

  async saveTestCsv(testName: string, csv: string): Promise<string> {
    return this.run(async () => {
      const dir = await this.subdir(TEST_RUNS_DIR);
      const fileName = `${sanitizeName(testName)}.csv`;
      await writeTextFile(dir, fileName, csv);
      return `${TEST_RUNS_DIR}/${fileName}`;
    }, 'saveTestCsv');
  }

  async readTestCsv(testName: string): Promise<string | null> {
    const dir = await this.subdir(TEST_RUNS_DIR);
    return readTextFile(dir, `${sanitizeName(testName)}.csv`);
  }

  // ── Internals ──

  private requireRoot(): FileSystemDirectoryHandle {
    if (!this.root) throw new Error('No data directory selected');
    return this.root;
  }

  private subdir(name: string): Promise<FileSystemDirectoryHandle> {
    return this.requireRoot().getDirectoryHandle(name, { create: true });
  }

  private async readAllJson<T>(dirName: string): Promise<T[]> {
    if (!this.root) return [];
    const dir = await this.subdir(dirName);
    const out: T[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.json') || name === TEST_INDEX_FILE) continue;
      const value = await readJsonFile<T>(dir, name);
      if (value) out.push(value);
    }
    return out;
  }

  private async saveJsonUnique<T>(
    dirName: string,
    name: string,
    value: T,
    overwrite: boolean,
  ): Promise<boolean> {
    const dir = await this.subdir(dirName);
    const fileName = `${sanitizeName(name)}.json`;
    if (!overwrite && (await fileExists(dir, fileName))) {
      return false; // name collision; caller decides whether to overwrite
    }
    await writeJsonFile(dir, fileName, value);
    return true;
  }

  private async deleteJsonById(dirName: string, id: string): Promise<void> {
    const dir = await this.subdir(dirName);
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
      const value = await readJsonFile<{ id?: string }>(dir, name);
      if (value?.id === id) {
        await dir.removeEntry(name);
        return;
      }
    }
  }

  private async updateIndex(
    mutate: (rows: TestRunIndexRow[]) => TestRunIndexRow[],
  ): Promise<void> {
    const dir = await this.subdir(TEST_RUNS_DIR);
    const rows = (await readJsonFile<TestRunIndexRow[]>(dir, TEST_INDEX_FILE)) ?? [];
    await writeJsonFile(dir, TEST_INDEX_FILE, mutate(rows));
  }
}

function indexRow(entry: TestRunEntry): TestRunIndexRow {
  return {
    id: entry.id,
    testName: entry.testName,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    status: entry.status,
    sampleProfileName: entry.sampleProfile?.serial || undefined,
    motionProfileName: entry.motionProfile?.name || undefined,
  };
}

// ── File helpers ──

async function verifyPermission(
  handle: FileSystemHandle,
  request: boolean,
): Promise<boolean> {
  const opts = { mode: 'readwrite' as const };
  // OPFS handles (navigator.storage.getDirectory) have no permission model and
  // omit queryPermission/requestPermission — access is always granted there.
  const queryable = handle as FileSystemHandle & {
    queryPermission?: (o: typeof opts) => Promise<PermissionState>;
    requestPermission?: (o: typeof opts) => Promise<PermissionState>;
  };
  if (typeof queryable.queryPermission !== 'function') return true;
  if ((await queryable.queryPermission(opts)) === 'granted') return true;
  if (!request) return false;
  if (typeof queryable.requestPermission !== 'function') return true;
  return (await queryable.requestPermission(opts)) === 'granted';
}

async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return file.text();
  } catch {
    return null;
  }
}

async function readJsonFile<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  const text = await readTextFile(dir, name);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    // A present-but-unparseable file is corruption, not "absent" — log it so it
    // isn't fully indistinguishable from no data (callers still get null).
     
    console.warn(`DataStore: ignoring corrupt JSON in ${name}:`, err);
    return null;
  }
}

/** Ask the browser to mark our origin storage persistent (handle + counter
 *  survive eviction). Best-effort: unsupported / denied just returns false. */
async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  content: string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

function writeJsonFile<T>(dir: FileSystemDirectoryHandle, name: string, value: T): Promise<void> {
  return writeTextFile(dir, name, JSON.stringify(value, null, 2));
}

async function removeIfExists(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {
    /* not present */
  }
}

/** Singleton data store for the app. */
export const dataStore = new DataStore();
