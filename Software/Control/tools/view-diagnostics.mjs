#!/usr/bin/env node
/**
 * Render a mad-diagnostics-*.json bundle as a readable report.
 *
 * The bundle is built to be complete, not to be read: 5000 log entries and
 * base64 serial chunks are the right wire format and the wrong thing to open in
 * an editor. This prints the triage summary, the merged timeline, and — the
 * part that is otherwise unusable — an annotated hex dump of the raw serial
 * window with inter-chunk timing.
 *
 *   node tools/view-diagnostics.mjs report.json
 *   node tools/view-diagnostics.mjs report.json --bytes        # hex dump too
 *   node tools/view-diagnostics.mjs report.json --level warn   # filter
 *   node tools/view-diagnostics.mjs report.json --cat proto,flash
 *   node tools/view-diagnostics.mjs report.json --previous     # prior session
 */

import { readFile } from 'node:fs/promises';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const paint = {
  debug: (s) => dim(s),
  info: (s) => s,
  warn: (s) => c('33', s),
  error: (s) => c('31', s),
};

function parseArgs(argv) {
  const args = { file: null, bytes: false, level: 'debug', cats: null, previous: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bytes') args.bytes = true;
    else if (a === '--previous') args.previous = true;
    else if (a === '--level') args.level = argv[++i];
    else if (a === '--cat') args.cats = new Set(argv[++i].split(','));
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

const clock = (t) => new Date(t).toISOString().slice(11, 23);

function renderTimeline(entries, args) {
  const min = LEVELS[args.level] ?? LEVELS.debug;
  let shown = entries.filter((e) => (LEVELS[e.level] ?? 0) >= min);
  if (args.cats) shown = shown.filter((e) => args.cats.has(e.cat));
  if (args.limit > 0) shown = shown.slice(-args.limit);

  for (const e of shown) {
    const thread = e.thread === 'worker' ? 'W' : 'M';
    const head = `${clock(e.t)} ${e.level.padEnd(5)} ${thread} ${e.cat}/${e.tag}`;
    const data = e.data ? ` ${dim(JSON.stringify(e.data))}` : '';
    console.log(`${paint[e.level] ? paint[e.level](head) : head} ${e.msg ?? ''}${data}`.trimEnd());
  }
  const hidden = entries.length - shown.length;
  if (hidden > 0) console.log(dim(`  … ${hidden} entries hidden by filters`));
}

/** Classic offset + hex + ASCII dump. */
function hexDump(bytes, indent = '  ') {
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const slice = bytes.subarray(off, off + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${indent}${off.toString(16).padStart(6, '0')}  ${hex}  |${ascii}|`);
  }
  return lines.join('\n');
}

function renderSerial(tail) {
  console.log(bold('\n── Raw serial window ──'));
  console.log(
    `${tail.chunks.length} chunks · ${tail.totalRxBytes} B received · ${tail.totalTxBytes} B sent · ` +
      `capacity ${(tail.capacityBytes / 1024).toFixed(0)} KiB` +
      (tail.droppedChunks > 0 ? ` · ${tail.droppedChunks} chunks evicted` : ''),
  );
  let prev = null;
  for (const chunk of tail.chunks) {
    // Inter-chunk gaps are the signal: a frame split across two reads with a
    // long pause between them looks nothing like one that arrived whole.
    const gap = prev === null ? '' : dim(` (+${(chunk.at - prev).toFixed(1)} ms)`);
    prev = chunk.at;
    const dir = chunk.dir === 'rx' ? c('36', 'RX') : c('35', 'TX');
    const clipped = chunk.clipped ? dim(` [${chunk.clipped} B overwritten]`) : '';
    console.log(`\n${clock(chunk.at)} ${dir} ${chunk.len} B${gap}${clipped}`);
    console.log(hexDump(Buffer.from(chunk.b64, 'base64')));
  }
}

function renderTriage(t) {
  if (!t) return;
  console.log(bold('── Summary ──'));
  console.log(t.headline);
  console.log(
    `Session ${(t.sessionMs / 1000).toFixed(1)}s · ${t.entries} entries` +
      (t.dropped > 0 ? ` (+${t.dropped} evicted)` : ''),
  );
  console.log(
    `Link: ${t.everConnected ? 'connected' : c('31', 'never connected')}` +
      (t.everConnected ? (t.everResponded ? ', responded' : c('33', ', never responded')) : ''),
  );
  for (const flag of t.flags ?? []) console.log(c('33', `  ! ${flag}`));
  if (t.firstError) console.log(`First error: ${t.firstError.tag} ${t.firstError.msg}`);
  for (const f of t.topFailures ?? []) console.log(dim(`  ${f.tag}: ${f.count}`));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('usage: node tools/view-diagnostics.mjs <bundle.json> [--bytes] [--level warn] [--cat proto] [--previous] [--limit N]');
    process.exit(2);
  }
  const bundle = JSON.parse(await readFile(args.file, 'utf8'));

  console.log(bold(`MaD diagnostics · ${bundle.generatedAt ?? 'unknown time'}`));
  console.log(
    `app ${bundle.version ?? '?'} (${bundle.gitSha ?? '?'}) · firmware ${
      bundle.device?.firmwareVersion ?? 'unknown'
    } · ${bundle.buildMode ?? '?'}`,
  );
  console.log(dim(bundle.userAgent ?? ''));
  console.log();
  renderTriage(bundle.triage);

  if (args.previous) {
    const prev = bundle.previousSession;
    if (!prev) {
      console.log('\nNo previous session was attached to this bundle.');
      return;
    }
    console.log(
      bold(`\n── Previous session ${prev.id} ──`) +
        (prev.closed ? '' : c('33', ' (ended unexpectedly)')),
    );
    renderTimeline(prev.entries ?? [], args);
    return;
  }

  console.log(bold('\n── Timeline ──'));
  renderTimeline(bundle.log?.entries ?? [], args);

  if (bundle.previousSession) {
    console.log(
      dim(
        `\n(a previous session's log is attached — ${bundle.previousSession.entries?.length ?? 0} entries; pass --previous)`,
      ),
    );
  }
  if (args.bytes && bundle.serialTail) renderSerial(bundle.serialTail);
  else if (bundle.serialTail) {
    console.log(dim(`\n(${bundle.serialTail.chunks.length} serial chunks captured; pass --bytes)`));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
