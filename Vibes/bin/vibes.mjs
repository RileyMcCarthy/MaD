#!/usr/bin/env node
import { main } from '../dist/cli.js';
main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { console.error(err?.stack ?? String(err)); process.exitCode = 70; },
);
