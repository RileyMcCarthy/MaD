/**
 * Where the About screen points into the documentation site (MkDocs on
 * GitHub Pages). Kept apart from the screen so a test can check every path
 * against the pages under `docs/` without rendering React.
 */

/** The project's documentation site. */
export const DOCS = 'https://rileymccarthy.github.io/MaD/';

/** The guides listed on the About screen, as paths under {@link DOCS}. */
export const GUIDES: { title: string; path: string; what: string }[] = [
  { title: 'Getting started', path: 'getting-started/operators/', what: 'first-time setup, start to first test' },
  { title: 'Connecting', path: 'user-guide/connecting/', what: 'adapters, ports and baud rate' },
  { title: 'Running a test', path: 'user-guide/running-a-test/', what: 'from profiles to results' },
  { title: 'Settings & data', path: 'user-guide/settings-and-data/', what: 'the data folder and what it holds' },
  { title: 'Troubleshooting', path: 'user-guide/troubleshooting/', what: 'common problems and fixes' },
];

/** The "everything else is in the user guide" link, under {@link DOCS}. */
export const USER_GUIDE_PATH = 'user-guide/';
