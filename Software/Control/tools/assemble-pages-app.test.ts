import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMPTY_APP_REFUSAL,
  assemble,
  compareVersions,
  redirectPage,
  releasesFromDir,
} from './assemble-pages-app.mts';
import type { Bundled } from './firmwareRelease';

/* The assembler is driven the way pages.yml's ZIP_DIR dry run drives it: real
 * mad-control-v*.zip files in a temp folder, unpacked by the real `unzip` into
 * a temp OUT. The firmware lookup is stubbed, so nothing touches GitHub. */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A minimal stored (uncompressed) zip, so the test needs no `zip` binary. */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const FIRMWARE: Bundled = {
  manifest: {
    tag: 'firmware-v0.13',
    version: '0.13',
    assetName: 'MaD-Firmware-0.13-madEdge.bin',
    size: 4,
    sha256: 'ab'.repeat(32),
    publishedAt: '2026-10-18T06:50:07Z',
    htmlUrl: 'https://example.invalid/r',
  },
  image: Buffer.from([1, 2, 3, 4]),
};

// The CLI test starts vite-node, which takes about a second on its own.
vi.setConfig({ testTimeout: 30_000 });

let root: string;
let zipDir: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'assemble-pages-test-'));
  zipDir = join(root, 'zips');
  out = join(root, 'app');
  mkdirSync(zipDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes one release build, as `release-app` attaches it, into ZIP_DIR. */
function release(version: string): void {
  writeFileSync(
    join(zipDir, `mad-control-v${version}.zip`),
    zipOf({ 'index.html': `<p>app ${version}</p>`, 'assets/app.js': `console.log(${JSON.stringify(version)})` }),
  );
}

function run(fetchFirmware = vi.fn(async () => FIRMWARE)) {
  return assemble({ out, listReleases: () => releasesFromDir(zipDir), fetchFirmware, log: () => undefined });
}

describe('assemble-pages-app', () => {
  behaviour(
    {
      id: 'pages-assemble.zip-dir-unpacks-every-release',
      covers: 'tools/assemble-pages-app.mts#assemble',
      given: 'a local dry run whose zip folder holds two released app builds and an unrelated zip',
      expect: {
        'each-in-own-folder': 'each release is unpacked, files intact, into its own version folder under the app folder',
        'others-ignored': 'a zip not named like a released app build is not published',
        'shared-firmware': 'the latest firmware release is written once, beside the versions, for every version to share',
        'retires-old-worker': "a script that removes the old unversioned app's service worker is written at the app folder's root",
      },
    },
    async () => {
      release('0.4.0');
      release('0.4.1');
      writeFileSync(join(zipDir, 'something-else.zip'), zipOf({ 'x.txt': 'x' }));
      await run();
      expect(readFileSync(join(out, 'v0.4.0/index.html'), 'utf8')).toBe('<p>app 0.4.0</p>');
      expect(readFileSync(join(out, 'v0.4.1/index.html'), 'utf8')).toBe('<p>app 0.4.1</p>');
      expect(readFileSync(join(out, 'v0.4.1/assets/app.js'), 'utf8')).toBe('console.log("0.4.1")');
      expect(existsSync(join(out, 'vsomething-else'))).toBe(false);
      expect(JSON.parse(readFileSync(join(out, 'firmware/latest.json'), 'utf8'))).toEqual(FIRMWARE.manifest);
      expect([...readFileSync(join(out, 'firmware/latest.bin'))]).toEqual([1, 2, 3, 4]);
      expect(readFileSync(join(out, 'sw.js'), 'utf8')).toMatch(/registration\.unregister\(\)/);
    },
  );

  behaviour(
    {
      id: 'pages-assemble.versions-newest-first',
      covers: 'tools/assemble-pages-app.mts#assemble',
      given: 'released builds 0.9.0, 0.10.0 and 0.4.1, found in no particular order',
      expect: {
        'newest-first': 'the published version list runs newest first by version number, not alphabetically',
        'latest-is-highest': 'the version marked latest is the highest version number, 0.10.0',
        'publish-time-kept': 'each listed version carries when it was published',
      },
    },
    async () => {
      for (const v of ['0.9.0', '0.10.0', '0.4.1']) release(v);
      await run();
      const versions = JSON.parse(readFileSync(join(out, 'versions.json'), 'utf8')) as {
        latest: string;
        versions: { version: string; publishedAt: string | null }[];
      };
      expect(versions.versions.map((v) => v.version)).toEqual(['0.10.0', '0.9.0', '0.4.1']);
      expect(versions.latest).toBe('0.10.0');
      for (const v of versions.versions) expect(Number.isNaN(Date.parse(v.publishedAt ?? ''))).toBe(false);
    },
  );

  behaviour(
    {
      id: 'pages-assemble.compare-versions',
      covers: 'tools/assemble-pages-app.mts#compareVersions',
      given: 'version numbers that sort differently as text than as numbers, one with a pre-release suffix',
      expect: {
        numeric: 'each part is compared as a number, so 0.10.0 sorts before 0.9.0 and 1.0.0 before both',
        'suffix-ignored': 'a suffix after the patch number does not change the order',
      },
    },
    () => {
      expect(['0.9.0', '1.0.0', '0.10.0'].sort(compareVersions)).toEqual(['1.0.0', '0.10.0', '0.9.0']);
      expect(compareVersions('0.4.0-rc.1', '0.4.0')).toBe(0);
    },
  );

  behaviour(
    {
      id: 'pages-assemble.redirect-keeps-route',
      covers: 'tools/assemble-pages-app.mts#redirectPage',
      given: 'the app entry page is written for latest release 0.10.0',
      expect: {
        'to-latest': "the page sends the browser on to the latest release's folder",
        'keeps-query-and-hash': 'the address part after the page, its query and its fragment, is carried over unchanged',
        'works-without-script': 'with scripts off, a meta refresh and a link still lead to the latest release',
      },
      why: {
        'keeps-query-and-hash': 'a bookmarked or shared /app/ link to a screen must land on that screen of the latest release',
      },
    },
    async () => {
      release('0.9.0');
      release('0.10.0');
      await run();
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      expect(html).toBe(redirectPage('0.10.0'));
      expect(html).toContain('location.replace("v0.10.0/" + location.search + location.hash);');
      expect(html).toContain('<meta http-equiv="refresh" content="0; url=v0.10.0/">');
      expect(html).toContain('<a href="v0.10.0/"');
    },
  );

  behaviour(
    {
      id: 'pages-assemble.empty-refused',
      covers: 'tools/assemble-pages-app.mts#assemble',
      given: 'no released app build is found, and the app folder already holds an earlier assembly',
      expect: {
        refused: 'the assembly fails saying it refuses to publish an empty app',
        'out-untouched': 'the existing app folder is left exactly as it was',
        'no-firmware-fetch': 'the firmware release is not looked up',
      },
    },
    async () => {
      writeFileSync(join(zipDir, 'notes.txt'), 'not a release');
      mkdirSync(out);
      writeFileSync(join(out, 'versions.json'), '{"latest":"0.4.0"}');
      const fetchFirmware = vi.fn(async () => FIRMWARE);
      await expect(run(fetchFirmware)).rejects.toThrow(EMPTY_APP_REFUSAL);
      expect(readFileSync(join(out, 'versions.json'), 'utf8')).toBe('{"latest":"0.4.0"}');
      expect(fetchFirmware).not.toHaveBeenCalled();
    },
  );

  behaviour(
    {
      id: 'pages-assemble.cli-empty-exits-nonzero',
      covers: 'tools/assemble-pages-app.mts#main',
      given: 'the assembler is run as the deploy runs it, with an empty zip folder',
      expect: {
        'exit-nonzero': 'the process exits with a failure status, so the deploy stops',
        'says-why': 'the error output says it refuses to publish an empty app',
        'nothing-written': 'no app folder is created',
      },
    },
    () => {
      const viteNode = fileURLToPath(new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url));
      const script = fileURLToPath(new URL('./assemble-pages-app.mts', import.meta.url));
      const r = spawnSync(process.execPath, [viteNode, script], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, VITEST: '', ZIP_DIR: zipDir, OUT: out, GITHUB_TOKEN: '' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(r.status).not.toBe(0);
      expect(r.status).not.toBeNull();
      expect(r.stderr).toContain('refusing to publish an empty app');
      expect(existsSync(out)).toBe(false);
    },
  );
});
