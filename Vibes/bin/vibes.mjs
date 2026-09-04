#!/usr/bin/env node
// Thin launcher. All logic lives in src/cli/main.ts (compiled to dist/).
import { main } from '../dist/cli/main.js';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(err?.stack ?? String(err));
    process.exitCode = 70; // EX_SOFTWARE
  },
);
