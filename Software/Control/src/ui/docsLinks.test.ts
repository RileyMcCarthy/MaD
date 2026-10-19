import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GUIDES, USER_GUIDE_PATH } from './docsLinks';

/** The MkDocs source folder at the repository root. */
const docsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs');

/**
 * The source pages MkDocs could build a link path from: with directory URLs,
 * `a/b/` is `docs/a/b.md` or `docs/a/b/index.md`. Returns the path when
 * neither exists, null when the page is there.
 */
function missingPage(path: string): string | null {
  const bare = path.replace(/\/$/, '');
  const candidates = [`${bare}.md`, join(bare, 'index.md')];
  return candidates.some((c) => existsSync(join(docsDir, c))) ? null : path;
}

describe('About page documentation links', () => {
  behaviour(
    {
      id: 'about.docs-links-resolve',
      covers: 'src/ui/docsLinks.ts#GUIDES',
      given: "the guides the About screen links into the documentation site, and its link to the full user guide",
      expect: {
        'guides-exist': 'every listed guide is a page in the documentation the site is built from',
        'user-guide-exists': 'the full user guide link is a page in that documentation too',
      },
      why: {
        'guides-exist':
          'the docs build does not look at the app, so a page renamed or moved under docs/ would otherwise leave a dead link on the About screen',
      },
    },
    () => {
      expect(existsSync(docsDir)).toBe(true);
      expect(GUIDES.length).toBeGreaterThan(0);
      expect(GUIDES.map((g) => missingPage(g.path)).filter((p) => p !== null)).toEqual([]);
      expect(missingPage(USER_GUIDE_PATH)).toBeNull();
    },
  );
});
