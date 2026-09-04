/**
 * The per-file review loop.
 *
 * Interactive is the DEFAULT and non-interactive is the flagged exception —
 * deliberately the opposite ordering from insta, which shipped bulk review
 * first and only added a non-TTY path at 1.44. Getting that order wrong makes
 * the unreviewed acceptance the frictionless one, and the frictionless path is
 * the one an agent takes every time.
 *
 * What the reviewer sees is the SAME rendering the report will show — the
 * renderer registry's blocks, printed as markdown. If the terminal view and the
 * report view were built separately they would drift, and then "I reviewed it"
 * would refer to something no reviewer of the PR can see.
 */

import { createInterface } from 'node:readline/promises';
import { promises as fs } from 'node:fs';

import { renderBlocksMarkdown } from '../emit/index.js';
import type { RenderLimits, RendererRegistry, SnapshotFileRef } from '../render/index.js';
import { DEFAULT_RENDER_LIMITS, defaultRegistry, renderSnapshot } from '../render/index.js';
import type { AcceptDecision, Candidate } from './model.js';

/* ─────────────────────────────── the port ────────────────────────────── */

export interface AcceptIo {
  readonly isTTY: boolean;
  write(text: string): void;
  /** Resolves with the operator's line, or null on EOF. */
  question(prompt: string): Promise<string | null>;
  close(): void;
}

/**
 * The readline interface is created LAZILY, on the first question.
 *
 * Constructing it eagerly attaches a stdin listener, and a live stdin listener
 * keeps the event loop alive: `vibes accept --yes` in a script — which never
 * asks a question — would print its summary and then hang forever. That is a
 * one-line bug with a very long debugging session attached to it.
 */
export function createStdioIo(): AcceptIo {
  let rl: ReturnType<typeof createInterface> | null = null;
  let closed = false;
  return {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    write(text) {
      process.stdout.write(text);
    },
    async question(prompt) {
      if (closed) return null;
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } catch {
        // The stream closed under us (Ctrl-D, a pipe going away). Null means
        // "no answer", which the loop treats as an abort — never as consent.
        return null;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      rl?.close();
      rl = null;
    },
  };
}

/* ─────────────────────────────── rendering ───────────────────────────── */

export interface ReviewRenderOptions {
  readonly registry?: RendererRegistry;
  readonly limits?: RenderLimits;
  /** Lines of rendered output shown before `d` expands. */
  readonly previewLines?: number;
}

const DEFAULT_PREVIEW_LINES = 60;

async function readOrNull(path: string | null): Promise<Buffer | null> {
  if (path === null) return null;
  try {
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

/** The full rendered view of one candidate, as markdown text. */
export async function renderCandidate(
  c: Candidate,
  options: ReviewRenderOptions = {},
): Promise<string> {
  const registry = options.registry ?? defaultRegistry();
  const limits = options.limits ?? DEFAULT_RENDER_LIMITS;
  // The "before" is the file that is about to be OVERWRITTEN — the committed
  // baseline on disk — not the blob at <base>. Refusal 7 guarantees they agree
  // for tracked content, and when they do not (a staged earlier accept) the
  // reviewer must see what actually changes on disk.
  const baseline = await readOrNull(c.absBaseline);
  const received = await readOrNull(c.absReceived);
  const ref: SnapshotFileRef = {
    component: c.component,
    producer: c.producer,
    file: c.file,
    repoPath: c.repoPath,
    state: c.state,
    verdict: c.verdict,
    bytes: c.bytes,
  };
  const rendered = await renderSnapshot({ ref, baseline, received }, { registry, limits });
  const body = renderBlocksMarkdown(rendered.blocks);
  const notes = rendered.notes.length === 0 ? '' : `\n${rendered.notes.map((n) => `note: ${n}`).join('\n')}\n`;
  return `${body}${notes}`;
}

function head(text: string, lines: number): { text: string; truncated: number } {
  const all = text.split('\n');
  if (all.length <= lines) return { text, truncated: 0 };
  return { text: all.slice(0, lines).join('\n'), truncated: all.length - lines };
}

/* ──────────────────────────────── the loop ───────────────────────────── */

export interface ReviewOutcome {
  readonly decisions: ReadonlyMap<string, AcceptDecision>;
  /** True when the operator pressed `q`. Nothing is written in that case. */
  readonly quit: boolean;
}

/** Key → decision. `d` is handled in the loop and re-prompts the same file. */
const KEYS: Readonly<Record<string, AcceptDecision>> = {
  a: 'accept',
  y: 'accept',
  r: 'reject',
  n: 'reject',
  s: 'skip',
};

const PROMPT = '  [a]ccept  [r]eject  [s]kip  [d]iff  [q]uit > ';

export function candidateKey(c: Candidate): string {
  return `${c.component}/${c.producer}:${c.file}`;
}

/**
 * Review every candidate.
 *
 * `q` ABORTS the whole invocation and writes nothing. The alternative — apply
 * what was accepted so far — silently commits a half-finished review under a
 * receipt claiming the batch was reviewed, and "quit" is the word people press
 * when they want out, not when they want a partial commit.
 */
export async function reviewCandidates(
  candidates: readonly Candidate[],
  io: AcceptIo,
  options: ReviewRenderOptions = {},
): Promise<ReviewOutcome> {
  const previewLines = options.previewLines ?? DEFAULT_PREVIEW_LINES;
  const decisions = new Map<string, AcceptDecision>();

  for (const [i, c] of candidates.entries()) {
    const verb = c.action === 'delete' ? 'DELETE' : c.verdict.kind.toUpperCase();
    io.write(`\n──────────────────────────────────────────────────────────────\n`);
    io.write(`(${i + 1}/${candidates.length}) ${verb}  ${c.repoPath}\n`);
    if (c.verdict.summary !== undefined) io.write(`  ${c.verdict.summary}\n`);
    if (c.action === 'delete') {
      io.write(
        '  This file exists in the baseline and the producer no longer emits it.\n' +
          '  Accepting REMOVES it from the corpus.\n',
      );
    }
    io.write('\n');

    let expanded = false;
    let rendered: string | null = null;
    let show = true;

    for (;;) {
      if (show && c.action !== 'delete') {
        rendered ??= await renderCandidate(c, options);
        if (expanded) {
          io.write(`${rendered}\n`);
        } else {
          const { text, truncated } = head(rendered, previewLines);
          io.write(`${text}\n`);
          if (truncated > 0) io.write(`  … ${truncated} more lines — press d to show them all\n`);
        }
      }
      show = false;

      const answer = await io.question(PROMPT);
      if (answer === null) {
        // EOF mid-review is not consent.
        return { decisions, quit: true };
      }
      const key = answer.trim().toLowerCase().slice(0, 1);
      if (key === 'q') return { decisions, quit: true };
      if (key === 'd') {
        expanded = !expanded;
        show = true;
        continue;
      }
      const decision = KEYS[key];
      if (decision === undefined) {
        io.write('  Unrecognised. a = accept, r = reject, s = skip, d = toggle full diff, q = quit.\n');
        continue;
      }
      decisions.set(candidateKey(c), decision);
      break;
    }
  }
  return { decisions, quit: false };
}
