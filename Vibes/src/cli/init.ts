import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT, type ExitCode } from './exit.js';
import { str, type ParsedCommand } from './args.js';

const MANIFEST = (id: string): string => `// Vibes manifest for "${id}". MECHANICS ONLY.
// Identity, root, enabled and dependsOn live in the root vibes.config.mjs
// registry, and are errors if declared here.
//
// .mjs is mandatory when the repo root has no package.json: a bare .js would
// load as CommonJS and \`export default\` would be a SyntaxError.
export default {
  component: '${id}',
  producers: [
    // {
    //   name: 'example',
    //   cmd: 'node vibes/producers/example.mjs',   // writes into $VIBES_OUT_DIR
    //   out: 'snapshots/example',                  // relative to THIS file
    //   ciJob: '<the CI job this runs in>',
    //   tier: 'pr',
    // },
  ],
  // Source paths these snapshots CLAIM to cover. Root-relative.
  witnesses: [],
};
`;

export async function cmdInit(p: ParsedCommand, log: (s: string) => void): Promise<ExitCode> {
  const cwd = str(p, 'cwd') ?? process.cwd();
  const id = str(p, 'component');
  const root = str(p, 'root');
  if (id === undefined || root === undefined) {
    process.stderr.write('vibes init: --component <id> --root <repo-relative-path> are both required\n');
    return EXIT.USAGE;
  }
  const dir = join(cwd, root, 'vibes');
  await mkdir(join(dir, 'producers'), { recursive: true });
  await writeFile(join(dir, 'vibes.manifest.mjs'), MANIFEST(id), { flag: 'wx' }).catch(() => {
    log(`vibes init: ${join(root, 'vibes', 'vibes.manifest.mjs')} already exists, left alone.`);
  });
  log(`vibes init: wrote ${join(root, 'vibes', 'vibes.manifest.mjs')}`);
  log('');
  log('Now add the component to the registry in vibes.config.mjs:');
  log(`    { id: '${id}', root: '${root}' },`);
  log('The registry is the guarantee — a component that is not listed there does not exist,');
  log('and a listed root that does not exist is a hard error rather than a silent skip.');
  return EXIT.OK;
}
