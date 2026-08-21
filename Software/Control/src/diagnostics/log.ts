/**
 * Structured session log — one instance per thread (main + device worker).
 *
 * The app has no backend, so the only way to root-cause a field failure is to
 * carry enough detail in the page itself to reconstruct what happened. This is
 * that store: an always-on ring of structured entries that records EVERY level
 * (the console filter below only controls mirroring, never capture), so a bug
 * report is full-detail even when the console was quiet.
 *
 * Two hard rules shape the design:
 *
 *  1. The ~100 Hz sample path must stay allocation-free. Nothing here runs
 *     per-sample — call sites aggregate and log summaries. The ring itself is
 *     preallocated and `append` does no array growth.
 *  2. Nothing high-rate crosses Comlink. The worker's instance buffers its
 *     entries and flushes a batch every 250 ms (or 100 entries), which the main
 *     thread folds into the SAME ring via `ingestWorkerBatch` so `logSnapshot()`
 *     reads as one merged timeline.
 *
 * See docs/DIAGNOSTICS.md for where this sits in the wider bundle/report flow.
 */

/* ------------------------------------------------------------------ types -- */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogCat = 'app' | 'device' | 'proto' | 'store' | 'ui' | 'fs' | 'perf' | 'wasm';

export type LogThread = 'main' | 'worker';

export interface LogEntry {
  /** Monotonic per-thread counter. Survives `clearLog()` so ordering never repeats. */
  seq: number;
  /** Wall-clock ms with sub-ms precision — comparable across threads (see EPOCH_MS). */
  t: number;
  thread: LogThread;
  level: LogLevel;
  cat: LogCat;
  /** Short, groupable event name: 'connect', 'tx', 'nack'. Keyed into counters. */
  tag: string;
  msg?: string;
  /** Sanitized scalars only — see `sanitize`. */
  data?: Record<string, unknown>;
}

export interface LogSnapshot {
  /** Merged main + worker entries, sorted by `t`. */
  entries: LogEntry[];
  /** Per-`cat:tag` totals, including entries the ring has already evicted. */
  counters: Record<string, number>;
  /** Entries evicted by ring wrap, so truncation is visible in a report. */
  dropped: number;
  /** Wall-clock ms at logger init (or at the last `clearLog()`). */
  startedAt: number;
}

export type LogSubscriber = (entry: LogEntry) => void;

/** Batch transport out of the worker. Comlink proxies return promises. */
export type LogBatchSink = (entries: LogEntry[]) => void | Promise<void>;

export interface CategoryLogger {
  debug(tag: string, msg?: string, data?: Record<string, unknown>): void;
  info(tag: string, msg?: string, data?: Record<string, unknown>): void;
  warn(tag: string, msg?: string, data?: Record<string, unknown>): void;
  error(tag: string, msg?: string, data?: Record<string, unknown>): void;
}

/** Shape attached to `globalThis.__madLog` (see the bottom of this file). */
export interface MadLogHook {
  snapshot(): LogSnapshot;
  clear(): void;
  setFilter(cats: string, level?: LogLevel): void;
  mark(label: string): void;
}

/* -------------------------------------------------------------- time base -- */

/**
 * `performance.timeOrigin` differs between the main thread and a worker (a
 * worker's origin is its own construction time), so raw `performance.now()`
 * values from the two threads are NOT comparable. Anchoring once per thread to
 * `Date.now() - performance.now()` converts both to the same wall clock while
 * keeping `performance.now()`'s sub-ms resolution and monotonicity — no
 * handshake, no clock-sync message, and correct even if the worker is created
 * minutes after the page.
 *
 * (`Date.now()` alone would be ms-granular and can step backwards on NTP
 * adjustment, which would scramble the merged timeline.)
 */
const EPOCH_MS = Date.now() - performance.now();

/** Wall-clock ms, sub-ms precision, comparable across threads. */
export function nowMs(): number {
  return EPOCH_MS + performance.now();
}

const THREAD: LogThread =
  typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope
    ? 'worker'
    : 'main';

/** Which thread this module instance is running on. */
export function logThread(): LogThread {
  return THREAD;
}

/* ------------------------------------------------------------ ring buffer -- */

/** Retained entries. ~5k covers a long session of non-per-sample logging. */
export const LOG_CAPACITY = 5000;

const ring = new Array<LogEntry | undefined>(LOG_CAPACITY);
let ringHead = 0;
let ringSize = 0;
let dropped = 0;
let seqCounter = 0;
let startedAt = nowMs();

/** Per-`cat:tag` totals. Kept from the old recorder: "how many nacks this
 *  session" is one lookup, and it stays accurate after the ring wraps. */
const counters: Record<string, number> = {};

const subscribers = new Set<LogSubscriber>();

/**
 * Subscribe to entries as they are appended (including ingested worker
 * batches), so a live-tail UI can follow without polling. Returns the remover.
 */
export function subscribeLog(fn: LogSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function bumpCounter(key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

function append(entry: LogEntry): void {
  ring[ringHead] = entry;
  ringHead = (ringHead + 1) % LOG_CAPACITY;
  if (ringSize < LOG_CAPACITY) ringSize += 1;
  else dropped += 1;

  bumpCounter(`${entry.cat}:${entry.tag}`);

  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // A broken subscriber must never break logging (or throw into a device
      // callback that happens to be logging at the time).
      bumpCounter('app:log-subscriber-error');
    }
  }
}

/* ----------------------------------------------------- console mirroring -- */

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The real console methods, captured at module init.
 *
 * Deliberate: the diagnostics plan intercepts `console.error`/`console.warn` and
 * forwards them INTO this logger. If mirroring then called the intercepted
 * console, every error would loop forever. Binding the originals here (this
 * module loads before any interceptor, since the interceptor imports it) makes
 * that cycle impossible.
 */
const CONSOLE: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const LS_CATS = 'mad:log';
const LS_LEVEL = 'mad:loglevel';

/** Parsed form of `mad:log`: null = mirroring off, '*' = all cats. */
let mirrorCats: Set<string> | '*' | null = null;
let mirrorLevel: LogLevel = 'info';
/** Raw spec string, so `getLogFilter()` round-trips what was set. */
let mirrorSpec = '';

function isLevel(v: string | null): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error';
}

function parseCats(spec: string): Set<string> | '*' | null {
  const s = spec.trim();
  if (s === '') return null;
  if (s === '*') return '*';
  const set = new Set(
    s
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter((c) => c.length > 0),
  );
  return set.size > 0 ? set : null;
}

/** Workers have no `localStorage`, and private-mode Safari throws on access. */
function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Worker / private mode / quota. Live state still updated by the caller.
  }
}

function applyFilter(cats: string, level: LogLevel): void {
  mirrorSpec = cats;
  mirrorCats = parseCats(cats);
  mirrorLevel = level;
}

/**
 * Update the console mirror at runtime, persisting to `localStorage` where it
 * exists. `cats` is a comma-separated category list, `'*'` for all, or `''` to
 * silence mirroring entirely (capture is unaffected either way).
 *
 * The worker cannot read `localStorage`, so its filter is whatever the default
 * is until the main thread pushes one across; call this from the worker to sync.
 */
export function setLogFilter(cats: string, level?: LogLevel): void {
  applyFilter(cats, level ?? mirrorLevel);
  writeStored(LS_CATS, cats);
  if (level) writeStored(LS_LEVEL, level);
}

export function getLogFilter(): { cats: string; level: LogLevel } {
  return { cats: mirrorSpec, level: mirrorLevel };
}

/** Whether an entry of this category/level would reach the console right now. */
export function mirrorMatches(cat: string, level: LogLevel): boolean {
  if (mirrorCats === null) return false;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[mirrorLevel]) return false;
  return mirrorCats === '*' || mirrorCats.has(cat);
}

function mirror(entry: LogEntry): void {
  if (!mirrorMatches(entry.cat, entry.level)) return;
  // Worker logs land in the same DevTools console as main-thread logs, so the
  // thread has to be visible in the prefix or the two are indistinguishable.
  const prefix =
    entry.thread === 'worker'
      ? `[worker ${entry.cat}/${entry.tag}]`
      : `[${entry.cat}/${entry.tag}]`;
  const head = entry.msg ? `${prefix} ${entry.msg}` : prefix;
  // One console call per entry, with `data` trailing so DevTools renders it as
  // an expandable object rather than a flattened string.
  if (entry.data) CONSOLE[entry.level](head, entry.data);
  else CONSOLE[entry.level](head);
}

/* ------------------------------------------------------------ sanitization -- */

/** Longest retained string value; longer ones are truncated with a marker. */
export const SANITIZE_STRING_MAX = 200;
/** Longest JSON summary retained for a depth-1 nested object. */
const SANITIZE_NESTED_MAX = 200;
/** Keys past this are dropped, so one rogue object can't flood the ring. */
const SANITIZE_MAX_KEYS = 32;
/** Stack frames kept on an Error — enough to place it, short enough to store. */
const SANITIZE_STACK_LINES = 5;

/** Sentinel: this key is not representable and should be omitted entirely. */
const DROP = Symbol('drop');

const PATH_KEY_WORD = /(^|_)(path|dir|directory|dirname|file|filename|filepath|folder)$/;
const PATH_KEY_SUFFIX = /(path|dir|directory|filename|filepath|folder)$/;

function isPathKey(key: string): boolean {
  // Two spellings, because call sites write both: snake/word-boundary form
  // (`data_dir`, camelCase `dataDir` → `data_dir`) and run-together form
  // (`fileName` → `filename`).
  const word = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return PATH_KEY_WORD.test(word) || PATH_KEY_SUFFIX.test(word.replace(/[^a-z]/g, ''));
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function truncate(s: string): string {
  return s.length <= SANITIZE_STRING_MAX
    ? s
    : `${s.slice(0, SANITIZE_STRING_MAX)}…(+${s.length - SANITIZE_STRING_MAX} chars)`;
}

function describeType(v: object): string {
  if (Array.isArray(v)) return `Array(${v.length})`;
  const name = (v.constructor as { name?: string } | undefined)?.name;
  return name && name.length > 0 ? name : 'Object';
}

/**
 * Depth-1 rule: a nested object is summarised, never walked. Small ones are
 * cheap and genuinely useful as JSON; big or circular ones degrade to a type
 * tag. Either way the entry stays a bounded, structured-clone-safe blob.
 */
function summariseNested(v: object): string {
  try {
    const json = JSON.stringify(v);
    if (json === undefined) return describeType(v);
    if (json.length <= SANITIZE_NESTED_MAX) return json;
    return `${describeType(v)} ${json.slice(0, SANITIZE_NESTED_MAX)}…`;
  } catch {
    return describeType(v); // circular, or a throwing toJSON
  }
}

function sanitizeString(key: string, value: string): string {
  // Never leak filesystem layout (the bundle can end up in a public issue).
  // URLs are not paths — leave them alone apart from truncation.
  if (!value.includes('://') && (isPathKey(key) || /^(?:[A-Za-z]:)?[\\/].*[\\/]/.test(value))) {
    return truncate(basename(value));
  }
  return truncate(value);
}

function sanitizeValue(key: string, value: unknown): unknown | typeof DROP {
  switch (typeof value) {
    case 'undefined':
      return null; // keep the key: "present but empty" is information
    case 'boolean':
      return value;
    case 'number':
      // NaN/Infinity are not JSON-safe and would silently become null.
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return `${value}n`;
    case 'string':
      return sanitizeString(key, value);
    case 'function':
    case 'symbol':
      return DROP;
    default:
      break;
  }

  if (value === null) return null;
  const obj = value as object;

  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: truncate(obj.message),
      stack: (obj.stack ?? '').split('\n').slice(0, SANITIZE_STACK_LINES).join('\n'),
    };
  }
  // Payload bytes are never inlined: they belong in the byte ring, where they
  // are bounded, and inlining them here would evict the whole log in seconds.
  if (obj instanceof ArrayBuffer) return { bytes: obj.byteLength };
  if (ArrayBuffer.isView(obj)) return { bytes: obj.byteLength };
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof Map) return `Map(${obj.size})`;
  if (obj instanceof Set) return `Set(${obj.size})`;

  // File System Access handles: identity only, never contents or full path.
  const handle = obj as { kind?: unknown; name?: unknown };
  if (
    (handle.kind === 'file' || handle.kind === 'directory') &&
    typeof handle.name === 'string'
  ) {
    return `${handle.kind}:${basename(handle.name)}`;
  }

  return summariseNested(obj);
}

/**
 * Flatten arbitrary call-site data into scalars that are safe to store, safe to
 * structured-clone across the worker boundary, and safe to paste into a public
 * issue. Shallow (depth 1) by contract — see `summariseNested`.
 *
 * Never throws: logging must not be able to break the code it is observing.
 */
export function sanitize(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined;
  const out: Record<string, unknown> = {};
  try {
    let kept = 0;
    let skipped = 0;
    for (const key of Object.keys(data)) {
      if (kept >= SANITIZE_MAX_KEYS) {
        skipped += 1;
        continue;
      }
      let clean: unknown;
      try {
        clean = sanitizeValue(key, data[key]); // a getter can throw
      } catch {
        clean = '<unreadable>';
      }
      if (clean === DROP) continue;
      out[key] = clean;
      kept += 1;
    }
    if (skipped > 0) out._keysDropped = skipped;
  } catch {
    return { _sanitizeFailed: true };
  }
  return out;
}

/* ------------------------------------------------------- worker → main flush -- */

export const LOG_FLUSH_INTERVAL_MS = 250;
export const LOG_FLUSH_MAX_ENTRIES = 100;

let flushSink: LogBatchSink | null = null;
let pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Install the batch transport (worker side). The worker exposes this over
 * Comlink as `setLogSink`, mirroring the existing `setEventSink` pattern, and
 * the main thread registers a proxy that calls `ingestWorkerBatch`.
 *
 * Buffering is gated on the sink being present rather than on the thread, which
 * keeps the batching logic testable in isolation.
 */
export function setLogSink(sink: LogBatchSink | null): void {
  if (!sink) {
    flushLog();
    pending.length = 0;
  }
  flushSink = sink;
}

/**
 * Send any buffered entries now. Called on the 250 ms timer, on the 100-entry
 * threshold, and — critically — on the worker's shutdown path, so the last
 * entries before a crash or disconnect still reach the merged timeline.
 */
export function flushLog(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const sink = flushSink;
  if (sink === null || pending.length === 0) return;
  const batch = pending;
  pending = [];
  try {
    // A dead Comlink proxy rejects rather than throwing; swallow both. We must
    // NOT log the failure — that would re-enter the buffer and could loop.
    void Promise.resolve(sink(batch)).catch(() => bumpCounter('app:log-flush-failed'));
  } catch {
    bumpCounter('app:log-flush-failed');
  }
}

function enqueueForFlush(entry: LogEntry): void {
  pending.push(entry);
  if (pending.length >= LOG_FLUSH_MAX_ENTRIES) {
    flushLog();
    return;
  }
  if (flushTimer === null) flushTimer = setTimeout(flushLog, LOG_FLUSH_INTERVAL_MS);
}

/**
 * Fold a worker batch into this thread's ring (main side).
 *
 * Not mirrored to the console: the worker already mirrored these against its
 * own filter, and a worker's console output shares the page's DevTools console,
 * so re-mirroring here would double every line.
 */
export function ingestWorkerBatch(entries: readonly LogEntry[]): void {
  for (const e of entries) {
    append(e.thread === 'worker' ? e : { ...e, thread: 'worker' });
  }
}

/* ------------------------------------------------------------------- emit -- */

function emit(
  level: LogLevel,
  cat: LogCat,
  tag: string,
  msg?: string,
  data?: Record<string, unknown>,
): void {
  const entry: LogEntry = {
    seq: seqCounter++,
    t: nowMs(),
    thread: THREAD,
    level,
    cat,
    tag,
  };
  if (msg !== undefined && msg !== '') entry.msg = msg;
  const clean = sanitize(data);
  if (clean !== undefined) entry.data = clean;

  append(entry);
  mirror(entry);
  if (flushSink !== null) enqueueForFlush(entry);
}

const loggers = new Map<LogCat, CategoryLogger>();

/**
 * Category-scoped logger — the ergonomic surface for call sites:
 * `const log = logger('device'); log.info('connect', 'opened', { baud });`
 *
 * Instances are cached per category so call sites may also do
 * `logger('proto').debug(...)` inline without allocating.
 */
export function logger(cat: LogCat): CategoryLogger {
  const cached = loggers.get(cat);
  if (cached) return cached;
  const made: CategoryLogger = {
    debug: (tag, msg, data) => emit('debug', cat, tag, msg, data),
    info: (tag, msg, data) => emit('info', cat, tag, msg, data),
    warn: (tag, msg, data) => emit('warn', cat, tag, msg, data),
    error: (tag, msg, data) => emit('error', cat, tag, msg, data),
  };
  loggers.set(cat, made);
  return made;
}

/* --------------------------------------------------------------- snapshot -- */

/**
 * Merged, time-ordered view of everything retained.
 *
 * Entries are returned by reference (they are never mutated after append), so
 * this is cheap enough to call from an export path or a Playwright hook.
 */
export function logSnapshot(): LogSnapshot {
  const entries: LogEntry[] = [];
  const start = (ringHead - ringSize + LOG_CAPACITY) % LOG_CAPACITY;
  for (let i = 0; i < ringSize; i++) {
    const e = ring[(start + i) % LOG_CAPACITY];
    if (e !== undefined) entries.push(e);
  }
  // Worker batches arrive late, so ring order is not time order. Sort by `t`;
  // within one thread break ties by `seq` (identical sub-ms stamps do happen),
  // and across threads fall back to Array#sort's stability, which preserves
  // arrival order rather than inventing an interleaving.
  entries.sort((a, b) => a.t - b.t || (a.thread === b.thread ? a.seq - b.seq : 0));
  return { entries, counters: { ...counters }, dropped, startedAt };
}

/**
 * Drop a named marker into the timeline.
 *
 * Exists for the e2e harness: a dump annotated with scenario and step
 * boundaries is readable, where an undifferentiated wall of protocol frames is
 * not. Harmless in production — it is just another entry.
 */
export function markLog(label: string): void {
  emit('info', 'app', 'mark', label);
}

/** Drop everything retained and start a new window (`startedAt` moves). */
export function clearLog(): void {
  ring.fill(undefined);
  ringHead = 0;
  ringSize = 0;
  dropped = 0;
  pending.length = 0;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const k of Object.keys(counters)) delete counters[k];
  startedAt = nowMs();
  // `seqCounter` deliberately keeps counting: seq stays unique for the life of
  // the thread, so a cleared-then-refilled log can't be confused with the old one.
}

/* ------------------------------------------------------------------- init -- */

{
  // Dev mirrors everything at info; prod mirrors errors only. Unit tests mirror
  // nothing — capture is what the tests assert on, and a per-entry console call
  // would bury the runner's output. `mad:log` overrides all three.
  const env = import.meta.env;
  const fallback: { cats: string; level: LogLevel } = env.MODE === 'test'
    ? { cats: '', level: 'error' }
    : env.DEV
      ? { cats: '*', level: 'info' }
      : { cats: '*', level: 'error' };

  const storedCats = readStored(LS_CATS);
  const storedLevel = readStored(LS_LEVEL);
  applyFilter(storedCats ?? fallback.cats, isLevel(storedLevel) ? storedLevel : fallback.level);

  // Debug hook: Playwright dumps the full merged main+worker timeline on a
  // failed assertion with `page.evaluate(() => window.__madLog.snapshot())`.
  // Present in dev, and in prod only when the user has opted in via `mad:log`.
  if (env.DEV || storedCats !== null) {
    globalThis.__madLog = {
      snapshot: logSnapshot,
      clear: clearLog,
      setFilter: setLogFilter,
      mark: markLog,
    };
  }
}
