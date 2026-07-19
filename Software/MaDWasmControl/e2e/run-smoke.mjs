/**
 * Run the e2e smoke subset listed in smoke-ids.txt.
 * Same preconditions as `npm run e2e` (playground + bridge + dev server).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const ids = fs
  .readFileSync(path.join(here, 'smoke-ids.txt'), 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*/, '').trim())
  .filter(Boolean)
  .join(',');

if (!ids) {
  console.error('e2e/smoke-ids.txt is empty');
  process.exit(2);
}

console.log(`e2e smoke SCENARIOS=${ids}`);
const r = spawnSync(process.execPath, [path.join(here, 'run-all.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, SCENARIOS: ids },
});
process.exit(r.status ?? 1);
