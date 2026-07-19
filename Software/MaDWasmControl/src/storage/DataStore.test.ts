/**
 * DataStore integrity class tests:
 *  - mutating ops serialize through the async mutex (no dropped index updates)
 *  - nextTestName is monotonic / folder-scoped
 *  - rebuildIndex recovers from missing/empty index when run files exist
 *
 * Uses an in-memory File System Access fake — never touches real disk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const idb = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (key: string) => idb.get(key),
  set: async (key: string, value: unknown) => {
    idb.set(key, value);
  },
}));

// ── In-memory FS Access fake ──────────────────────────────────────────────

type FileEntry = { kind: 'file'; data: string };
type DirEntry = { kind: 'dir'; children: Map<string, FileEntry | DirEntry> };
type Entry = FileEntry | DirEntry;

function makeMemoryRoot(): FileSystemDirectoryHandle {
  const root: DirEntry = { kind: 'dir', children: new Map() };

  function getDir(path: string[]): Map<string, Entry> {
    let cur: Map<string, Entry> = root.children;
    for (const p of path) {
      let next = cur.get(p);
      if (!next || next.kind !== 'dir') {
        next = { kind: 'dir', children: new Map() };
        cur.set(p, next);
      }
      cur = next.children;
    }
    return cur;
  }

  function dirHandle(path: string[]): FileSystemDirectoryHandle {
    const handle = {
      kind: 'directory' as const,
      name: path[path.length - 1] ?? 'root',
      async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
        const children = getDir(path);
        let e = children.get(name);
        if (!e) {
          if (!opts?.create) throw new DOMException('NotFoundError');
          e = { kind: 'dir', children: new Map() };
          children.set(name, e);
        }
        if (e.kind !== 'dir') throw new DOMException('TypeMismatch');
        return dirHandle([...path, name]);
      },
      async getFileHandle(name: string, opts?: { create?: boolean }) {
        const children = getDir(path);
        let e = children.get(name);
        if (!e) {
          if (!opts?.create) throw new DOMException('NotFoundError');
          e = { kind: 'file', data: '' };
          children.set(name, e);
        }
        if (e.kind !== 'file') throw new DOMException('TypeMismatch');
        const fileEntry = e;
        return {
          kind: 'file' as const,
          name,
          async getFile() {
            return new File([fileEntry.data], name, { type: 'application/json' });
          },
          async createWritable() {
            let buf = '';
            return {
              async write(data: string | BufferSource | Blob) {
                if (typeof data === 'string') buf += data;
                else if (data instanceof Blob) buf += await data.text();
                else buf += new TextDecoder().decode(data as ArrayBuffer);
              },
              async close() {
                fileEntry.data = buf;
              },
              async abort() {},
              async seek() {},
              async truncate() {},
            } as unknown as FileSystemWritableFileStream;
          },
        } as unknown as FileSystemFileHandle;
      },
      async removeEntry(name: string) {
        getDir(path).delete(name);
      },
      async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
        for (const [name, e] of getDir(path)) {
          if (e.kind === 'file') {
            yield [name, { kind: 'file' } as FileSystemHandle];
          } else {
            yield [name, dirHandle([...path, name]) as unknown as FileSystemHandle];
          }
        }
      },
      async *keys() {
        for (const name of getDir(path).keys()) yield name;
      },
      async *values() {
        for await (const [, h] of handle.entries()) yield h;
      },
      async isSameEntry() {
        return false;
      },
      async resolve() {
        return null;
      },
      async queryPermission() {
        return 'granted' as PermissionState;
      },
      async requestPermission() {
        return 'granted' as PermissionState;
      },
    };
    return handle as unknown as FileSystemDirectoryHandle;
  }

  return dirHandle([]);
}

// Import after mocks so DataStore sees the stubbed idb-keyval.
const { DataStore } = await import('./DataStore');

function sampleRun(testName: string, id = `id-${testName}`) {
  return {
    id,
    testName,
    status: 'completed' as const,
    gcode: ['G122'],
    sampleProfileId: 'sp-1',
    motionProfileId: 'mp-1',
    sampleProfile: {
      maxForce: 100,
      maxVelocity: 10,
      maxDisplacement: 50,
      sampleWidth: 1,
      sampleThickness: 1,
      serial: 'S',
    },
    motionProfile: { name: 'M', description: '', sets: [] },
    startedAt: new Date(2020, 0, 1).toISOString(),
    completedAt: new Date(2020, 0, 1, 0, 1).toISOString(),
  };
}

describe('DataStore mutex + index integrity', () => {
  let store: InstanceType<typeof DataStore>;

  beforeEach(async () => {
    idb.clear();
    store = new DataStore();
    // Bypass chooseDirectory (needs showDirectoryPicker) by restoring a granted handle.
    const root = makeMemoryRoot();
    idb.set('mad.dataDirHandle', root);
    // restoreDirectory verifies permission via handle methods — our fake grants.
    const ok = await store.restoreDirectory();
    // If restore fails permission probe, force-assign for the unit test.
    if (!ok) {
      // @ts-expect-error test access
      store.root = root;
    }
  });

  it('serializes concurrent createTestRun so both rows survive in the index', async () => {
    // Fire many creates without awaiting each — mutex must not drop rows.
    const names = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(6, '0'));
    await Promise.all(names.map((n) => store.createTestRun(sampleRun(n))));

    const index = await store.getTestRunIndex();
    expect(index).toHaveLength(12);
    const ids = new Set(index.map((r) => r.id));
    expect(ids.size).toBe(12);
  });

  it('nextTestName is monotonic across concurrent callers', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.nextTestName()));
    const nums = results.map((s) => parseInt(s, 10)).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(8);
    // Contiguous block of 8 distinct names.
    expect(nums[nums.length - 1]! - nums[0]!).toBe(7);
  });

  it('rebuildIndex recovers runs when index.json is missing', async () => {
    await store.createTestRun(sampleRun('000001'));
    await store.createTestRun(sampleRun('000002'));

    // Corrupt/wipe the index by writing an empty list through a parallel path:
    // delete both by rewriting index only via rebuild after wiping file content.
    const dir = await (store as unknown as { subdir: (n: string) => Promise<FileSystemDirectoryHandle> }).subdir(
      'testRuns',
    );
    const fh = await dir.getFileHandle('index.json', { create: true });
    const w = await fh.createWritable();
    await w.write('[]');
    await w.close();

    // getTestRunIndex should detect files and rebuild.
    const index = await store.getTestRunIndex();
    expect(index.length).toBe(2);
    expect(index.map((r) => r.testName).sort()).toEqual(['000001', '000002']);
  });

  it('updateTestRun patches status without losing sibling runs', async () => {
    await store.createTestRun(sampleRun('000010'));
    await store.createTestRun(sampleRun('000011'));
    await store.updateTestRun('000010', { status: 'downloaded' });

    const a = await store.getTestRun('000010');
    const b = await store.getTestRun('000011');
    expect(a?.status).toBe('downloaded');
    expect(b?.status).toBe('completed');

    const index = await store.getTestRunIndex();
    expect(index.find((r) => r.testName === '000010')?.status).toBe('downloaded');
    expect(index).toHaveLength(2);
  });
});
