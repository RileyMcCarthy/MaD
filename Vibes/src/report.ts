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

export interface Coverage {
  /** Added lines that coverage saw execute. */
  readonly covered: number;
  /** Added lines coverage saw and that never ran. */
  readonly uncovered: number;
  /** Files with added lines that no coverage report mentions. Named, because
   *  "not measured" must never render as "covered". */
  readonly unmeasuredFiles: readonly string[];
  /** file -> uncovered added line count, worst first. */
  readonly worst: readonly (readonly [string, number])[];
}

export function headline(d: LedgerDiff): string {
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

function one(b: Behaviour): string {
  const covers = b.covers === undefined ? '' : `  \`${b.covers}\``;
  return `- **${b.then}**\n  given ${b.given}${covers}${b.why === undefined ? '' : `\n  _${b.why}_`}`;
}

function respec(r: Respecified): string {
  const lines = [`- \`${r.after.id}\``];
  if (r.fields.includes('then')) {
    lines.push(`  - was: **${r.before.then}**`);
    lines.push(`  - now: **${r.after.then}**`);
  }
  if (r.fields.includes('given')) {
    lines.push(`  - given was: ${r.before.given}`);
    lines.push(`  - given now: ${r.after.given}`);
  }
  const other = r.fields.filter((f) => f !== 'then' && f !== 'given');
  if (other.length > 0) lines.push(`  - also changed: ${other.join(', ')}`);
  return lines.join('\n');
}

export function renderMarkdown(d: LedgerDiff, cov: Coverage | null): string {
  const out: string[] = [`# ${headline(d)}`, ''];

  if (d.broken.length > 0) {
    out.push('## Stopped holding', '');
    out.push(
      'These behaviours passed before this change and do not now. The claim did not change; the code did.',
      '',
    );
    for (const s of d.broken) out.push(`- **${s.after.then}**\n  \`${s.after.id}\` · was ${s.before}, now ${s.after.status}`);
    out.push('');
  }

  if (d.removed.length > 0) {
    out.push('## No longer claimed', '');
    out.push('Nothing in the repo asserts these any more.', '');
    for (const b of d.removed) out.push(`- **${b.then}**\n  \`${b.id}\` · was in \`${b.file}\``);
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

  /* Coverage answers the other half: not "what did you specify" but "what did
   * you add that nothing specifies". A percentage alone is not actionable; the
   * files with the most unspecified lines are. */
  out.push('## Added code nothing specifies', '');
  if (cov === null) {
    out.push(
      '_Coverage was not supplied to this run, so nothing here says whether the added code is exercised. This is not 0%._',
      '',
    );
  } else {
    const scored = cov.covered + cov.uncovered;
    if (scored === 0) {
      out.push('_No added line was instrumented, so there is nothing to score._', '');
    } else {
      const pct = ((100 * cov.covered) / scored).toFixed(0);
      out.push(`${cov.uncovered} of ${scored} added lines that coverage could score never ran (${pct}% covered).`, '');
      for (const [file, n] of cov.worst.slice(0, 10)) out.push(`- \`${file}\` — ${n} uncovered`);
      if (cov.worst.length > 0) out.push('');
    }
    if (cov.unmeasuredFiles.length > 0) {
      out.push(
        `**${cov.unmeasuredFiles.length} changed file(s) no coverage report mentions** — not covered, not uncovered, unmeasured:`,
        '',
      );
      for (const f of cov.unmeasuredFiles.slice(0, 10)) out.push(`- \`${f}\``);
      out.push('');
    }
  }

  out.push('---', '');
  out.push(
    `_${d.unchanged} behaviour(s) unchanged and holding. This report describes what the tests claim; it does not establish that the claims are the right ones._`,
  );
  return out.join('\n') + '\n';
}
