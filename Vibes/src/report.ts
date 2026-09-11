/**
 * Render a ledger diff for a human.
 *
 * Ordered by what a reviewer must act on, not by what the tool finds
 * interesting: broken first, then removed, then respecified, then added. The
 * headline is a sentence naming the worst thing present — a badge or a count
 * reads as "green" to someone skimming, which is how a report stops being read.
 */

import type { Behaviour } from './ledger.js';
import type { LedgerDiff, Respecified } from './diff.js';

export function headline(d: LedgerDiff): string {
  if (d.unreported.length > 0) {
    const n = d.unreported.length;
    return `${n} behaviour${n === 1 ? '' : 's'} without a verdict — a suite failed to report.`;
  }
  if (d.broken.length > 0) {
    const n = d.broken.length;
    return `${n} behaviour${n === 1 ? '' : 's'} stopped holding.`;
  }
  if (d.removed.length > 0) {
    const n = d.removed.length;
    return `${n} behaviour${n === 1 ? '' : 's'} removed — the repo no longer claims ${n === 1 ? 'it' : 'them'}.`;
  }
  if (d.notHolding.length > 0) {
    const n = d.notHolding.length;
    return `${n} behaviour${n === 1 ? '' : 's'} not holding.`;
  }
  if (d.respecified.length > 0 && d.added.length > 0) {
    return `${d.added.length} new, ${d.respecified.length} respecified.`;
  }
  if (d.added.length > 0) {
    return `${d.added.length} new behaviour${d.added.length === 1 ? '' : 's'}.`;
  }
  if (d.respecified.length > 0) {
    return `${d.respecified.length} behaviour${d.respecified.length === 1 ? '' : 's'} respecified.`;
  }
  return 'No behaviour added, removed or respecified.';
}

/* Markdown soft-wraps a plain newline inside a list item, so every line of a
 * row has to end in two spaces or the claim, its scene and its reason render as
 * one run-on paragraph — which reads as though two separate specs collided. */
const BR = '  \n';

function one(b: Behaviour): string {
  const lines = [`- **${b.then}**`, `  given ${b.given}`];
  if (b.why !== undefined) lines.push(`  because ${b.why}`);
  /* The test is the evidence; the covered symbol is the code. Both belong on
   * the row so a reviewer can open the test without grepping the ledger. */
  lines.push(`  \`${b.file}#${b.test}\``);
  if (b.covers !== undefined) lines.push(`  \`${b.covers}\``);
  return lines.join(BR);
}

/* Ordered by what a reviewer needs first. The claim is was/now on its own;
 * everything else nests the two texts under the field name so a reason cannot
 * render as "because was" — which names the field and hides the sentence. */
const RESPEC_ORDER = ['then', 'given', 'why', 'covers'] as const;
const RESPEC_LABEL = { given: 'given', why: 'because', covers: 'covers' } as const;

function respec(r: Respecified): string {
  const lines = [`- \`${r.after.id}\``];
  for (const f of RESPEC_ORDER) {
    if (!r.fields.includes(f)) continue;
    const was = r.before[f] ?? '(none)';
    const now = r.after[f] ?? '(none)';
    if (f === 'then') {
      lines.push(`  - was: **${was}**`);
      lines.push(`  - now: **${now}**`);
      continue;
    }
    lines.push(`  - ${RESPEC_LABEL[f]}:`);
    lines.push(`    - was: ${was}`);
    lines.push(`    - now: ${now}`);
  }
  return lines.join('\n');
}

export function renderMarkdown(d: LedgerDiff): string {
  const out: string[] = [`# ${headline(d)}`, ''];

  if (d.broken.length > 0) {
    out.push('## Stopped holding', '');
    out.push(
      'These behaviours passed before this change and do not now. The claim did not change; the code did.',
      '',
    );
    for (const s of d.broken) out.push(`- **${s.after.then}**${BR}  \`${s.after.id}\` · was ${s.before}, now ${s.after.status}`);
    out.push('');
  }

  if (d.unreported.length > 0) {
    out.push('## No verdict — the suite did not report', '');
    out.push(
      'These were in the ledger, and this run learned NOTHING about them: their whole suite declared no behaviours, usually a build or startup failure. This is not removal and it is not a pass.',
      '',
    );
    for (const b of d.unreported) out.push(`- **${b.then}**${BR}  \`${b.id}\` · suite \`${b.suite}\``);
    out.push('');
  }

  if (d.removed.length > 0) {
    out.push('## No longer claimed', '');
    out.push('Nothing in the repo asserts these any more.', '');
    for (const b of d.removed) out.push(`- **${b.then}**${BR}  \`${b.id}\` · was in \`${b.file}\``);
    out.push('');
  }

  if (d.respecified.length > 0) {
    out.push('## Respecified', '');
    out.push('Same behaviour id, different claim. Read these as deliberate redefinitions.', '');
    for (const r of d.respecified) out.push(respec(r));
    out.push('');
  }

  if (d.added.length > 0) {
    out.push(`## New behaviour (${d.added.length})`, '');
    const bySuite = new Map<string, Behaviour[]>();
    for (const b of d.added) {
      const list = bySuite.get(b.suite) ?? [];
      list.push(b);
      bySuite.set(b.suite, list);
    }
    for (const [suite, items] of bySuite) {
      if (bySuite.size > 1) out.push(`### ${suite}`, '');
      for (const b of items) out.push(one(b));
      out.push('');
    }
  }

  // The one line that says "and nothing else moved" — the count a reviewer
  // checks against the ledger size to know the diff above is the whole story.
  out.push('---', '');
  out.push(`_${d.unchanged} behaviour${d.unchanged === 1 ? '' : 's'} unchanged and holding._`);
  return out.join('\n') + '\n';
}
