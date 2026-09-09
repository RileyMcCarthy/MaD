import { describe, expect, it } from 'vitest';
import type { RunReport } from '../types.js';
import { assertHeadlineInvariant, DISCLOSURE_SENTENCE, headline, tally } from './headline.js';
import { buildHtml } from './html.js';
import { buildMarkdown } from './markdown.js';
import { prepare } from './prepare.js';
import { component, finding, makeReport, producer, snap } from './fixture.test.js';

/**
 * Every combination worth having. The point of the matrix is that the
 * invariant is proven over the CROSS PRODUCT of states, not over the three
 * cases someone thought of while writing the branch.
 */
function matrix(): RunReport[] {
  const reports: RunReport[] = [];
  const states = ['verified-unchanged', 'changed', 'added', 'deleted', 'not-selected', 'not-run'] as const;
  const outcomes = ['ok', 'failed', 'timedOut', 'not-selected', 'emptyOutput', 'blocked'] as const;
  for (const state of states) {
    for (const outcome of outcomes) {
      for (const fullyVerified of [true, false]) {
        reports.push(
          makeReport({
            fullyVerified,
            components: [
              component({
                state: outcome === 'ok' ? 'verified-unchanged' : 'not-run',
                producers: [producer('domain', outcome)],
                snapshots: [snap('a.txt', state), snap('b.txt', state)],
              }),
            ],
          }),
        );
      }
    }
  }
  return reports;
}

describe('THE HEADLINE INVARIANT', () => {
  it('never prints "unchanged" in a headline unless fullyVerified is true', () => {
    for (const report of matrix()) {
      const h = headline(report);
      if (!report.fullyVerified) {
        expect(
          /\bunchanged\b/i.test(h.sentence),
          `fullyVerified=false but headline said: ${h.sentence}`,
        ).toBe(false);
      }
      // The assertion helper agrees with the generator, always.
      expect(() => assertHeadlineInvariant(h.sentence, report.fullyVerified)).not.toThrow();
    }
  });

  it('the assertion throws when handed a dishonest headline', () => {
    expect(() => assertHeadlineInvariant('Everything is unchanged.', false)).toThrow(
      /headline invariant violated/,
    );
    expect(() => assertHeadlineInvariant('Everything is unchanged.', true)).not.toThrow();
  });

  it('reaches the "unchanged" wording only on a fully verified, all-identical run', () => {
    const clean = makeReport({
      fullyVerified: true,
      components: [
        component({
          snapshots: [snap('a.txt', 'verified-unchanged'), snap('b.txt', 'verified-unchanged')],
        }),
      ],
    });
    const h = headline(clean);
    expect(h.state).toBe('all-verified');
    expect(h.sentence).toMatch(/unchanged/);
  });

  it('is enforced at the emitter boundary for both surfaces', async () => {
    // A report whose flag and contents disagree is exactly the bug the
    // invariant exists for; both emitters must refuse it rather than print it.
    const lying = makeReport({
      fullyVerified: false,
      components: [component({ snapshots: [snap('a.txt', 'verified-unchanged')] })],
    });
    const prepared = await prepare(lying);
    const forged = { ...prepared, headline: { state: 'all-verified' as const, sentence: 'All unchanged.' } };
    expect(() => buildMarkdown(forged)).toThrow(/headline invariant/);
    expect(() => buildHtml(forged)).toThrow(/headline invariant/);
  });
});

describe('headline shape', () => {
  const cases: RunReport[] = matrix();

  it('is a sentence: never a badge, never leading with a count', () => {
    for (const report of cases) {
      const s = headline(report).sentence;
      expect(s.endsWith('.'), `not a sentence: ${s}`).toBe(true);
      expect(/^\d/.test(s), `leads with a count: ${s}`).toBe(false);
      // No badge syntax: no shields, no pipes, no bare state tokens.
      expect(s).not.toMatch(/[|]/);
      expect(s).not.toMatch(/^(PASS|FAIL|OK|GREEN|RED)\b/i);
      expect(s.split(' ').length).toBeGreaterThan(6);
    }
  });

  it('leads with the worst state present, not the most common', () => {
    const mostlyFine = makeReport({
      fullyVerified: false,
      components: [
        component({
          state: 'partial',
          producers: [producer('domain', 'ok'), producer('trace', 'timedOut')],
          snapshots: [
            ...Array.from({ length: 240 }, (_, i) => snap(`ok-${i}.txt`, 'verified-unchanged')),
            snap('trace.csv', 'not-run'),
          ],
        }),
      ],
    });
    const h = headline(mostlyFine);
    expect(h.state).toBe('producer-failed');
    expect(h.sentence).toMatch(/did not complete/);
    expect(h.sentence).not.toMatch(/240/);
  });

  it('prefers "changed" over a corpus move, and a corpus move over partial', () => {
    const changed = makeReport({
      components: [component({ state: 'changed', snapshots: [snap('a', 'changed'), snap('b', 'added')] })],
    });
    expect(headline(changed).state).toBe('changed');

    const corpus = makeReport({
      components: [component({ snapshots: [snap('b', 'added'), snap('c', 'deleted')] })],
    });
    expect(headline(corpus).state).toBe('corpus-moved');

    const partial = makeReport({
      fullyVerified: false,
      components: [component({ snapshots: [snap('a', 'verified-unchanged')] })],
    });
    expect(headline(partial).state).toBe('partial');
  });

  it('names an error-severity finding when nothing changed', () => {
    const blocked = makeReport({
      findings: [finding('governance-weakened', 'error')],
      components: [component({ snapshots: [snap('a', 'verified-unchanged')] })],
    });
    expect(headline(blocked).state).toBe('findings-error');
  });

  it('says nothing was measured rather than implying success', () => {
    const empty = makeReport({
      components: [component({ state: 'not-configured', producers: [], snapshots: [] })],
    });
    const h = headline(empty);
    expect(h.state).toBe('nothing-measured');
    expect(h.sentence).toMatch(/says nothing about behaviour/);
  });
});

describe('the tally', () => {
  it('counts producers and snapshot states separately, never collapsing states', () => {
    const report = makeReport({
      components: [
        component({
          producers: [producer('a', 'ok'), producer('b', 'failed'), producer('c', 'not-selected')],
          snapshots: [
            snap('1', 'verified-unchanged'),
            snap('2', 'changed'),
            snap('3', 'added'),
            snap('4', 'deleted'),
            snap('5', 'not-selected'),
            snap('6', 'not-run'),
          ],
        }),
      ],
    });
    const t = tally(report);
    expect(t.producersOk).toBe(1);
    expect(t.producersFailed).toBe(1);
    expect(t.producersNotSelected).toBe(1);
    expect(t.totalSnapshots).toBe(6);
    for (const state of Object.values(t.states)) expect(state).toBe(1);
  });
});

describe('the disclosure sentence', () => {
  it('is exactly the required text', () => {
    expect(DISCLOSURE_SENTENCE).toBe(
      'Vibes verifies that a producer claiming these paths ran and its committed output moved. It does not establish that any specific file was executed.',
    );
  });
});
