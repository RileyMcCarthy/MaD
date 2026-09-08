#!/usr/bin/env node
/**
 * What test cases did this branch add or remove?
 *
 * Test names are the specification of behaviour, so a diff of them is a
 * readable answer to "what does this PR implement" — without reading the code.
 *
 * Reads the diff and nothing else. No baselines, no config, no committed
 * artifacts, no test run. That is deliberate: the whole point is that this
 * costs nothing to keep working.
 *
 *   node scripts/whats-new-tests.mjs [base-ref] [--markdown]
 *
 * Covers this repo's three idioms: vitest (Control), Unity (Firmware) and
 * Rust `#[test]` (SIL, when it grows some). A language it does not know is
 * simply absent — it is not reported as "no new tests".
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const markdown = args.includes('--markdown');
const base = args.find((a) => !a.startsWith('--')) ?? 'origin/main';

const PATHSPECS = [
  '*.test.ts', '*.test.tsx', '*.spec.ts', '*.spec.tsx', // vitest
  'Firmware/MaDCore/test/**/*.c', // Unity
  '*.rs', // cargo
];

let diff;
try {
  diff = execFileSync('git', ['diff', '-U0', `${base}...HEAD`, '--', ...PATHSPECS], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
} catch (err) {
  console.error(`could not diff against "${base}": ${err.message.split('\n')[0]}`);
  console.error('in CI this usually means the checkout was shallow — set fetch-depth: 0');
  process.exit(2);
}

/* One matcher per idiom. Each returns the case name, or null. */
const MATCHERS = [
  // vitest / jest:  it('...')  test("...")  it.each`..`('...')
  (l) => /^[+-]\s*(?:it|test)(?:\.\w+)?\s*\(\s*['"`](.+?)['"`]/.exec(l)?.[1] ?? null,
  // Unity:  void test_thing_does_x(void)
  (l) => /^[+-]\s*(?:static\s+)?void\s+(test_\w+)\s*\(/.exec(l)?.[1] ?? null,
  // Rust:  #[test] on the previous line is not visible in -U0, so match fn under a test module
  (l) => /^[+-]\s*(?:async\s+)?fn\s+(test_\w+|\w+_test)\s*\(/.exec(l)?.[1] ?? null,
];
const SUITE = /^[+-]\s*describe(?:\.\w+)?\s*\(\s*['"`](.+?)['"`]/;

const added = new Map();
const removed = new Map();
let file = null;
let suite = '';

for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) {
    file = line.slice(6).trim();
    suite = '';
    continue;
  }
  if (file === null || file === '/dev/null') continue;
  const s = SUITE.exec(line);
  if (s?.[1] !== undefined) {
    suite = s[1];
    continue;
  }
  let name = null;
  for (const m of MATCHERS) {
    name = m(line);
    if (name !== null) break;
  }
  if (name === null) continue;
  const bucket = line.startsWith('+') ? added : removed;
  if (!bucket.has(file)) bucket.set(file, []);
  bucket.get(file).push({ suite, name });
}

/* A name present on both sides is a reword or a move, not new behaviour.
 * Without this, renaming a describe block reads as a full specification of
 * work that did not happen. */
for (const [f, list] of added) {
  const gone = removed.get(f) ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const j = gone.findIndex((g) => g.name === list[i].name);
    if (j !== -1) {
      gone.splice(j, 1);
      list.splice(i, 1);
    }
  }
}

const total = (m) => [...m.values()].reduce((n, v) => n + v.length, 0);
const nAdded = total(added);
const nRemoved = total(removed);

const out = [];
const H = markdown ? '### ' : '';
const bullet = markdown ? '- ' : '      ';

if (nAdded === 0 && nRemoved === 0) {
  out.push(`No test cases were added or removed against \`${base}\`.`);
  out.push('');
  out.push(
    markdown
      ? '_This says nothing about whether the change is safe — only that it specifies no new behaviour through tests._'
      : 'This says nothing about whether the change is safe - only that it specifies no new behaviour through tests.',
  );
} else {
  out.push(
    `**${nAdded}** test${nAdded === 1 ? '' : 's'} added, **${nRemoved}** removed, against \`${base}\`.`,
  );
  out.push('');

  for (const [f, list] of added) {
    if (list.length === 0) continue;
    out.push(`${H}${f}`);
    out.push('');
    const bySuite = new Map();
    for (const t of list) {
      const key = t.suite === '' ? '' : t.suite;
      if (!bySuite.has(key)) bySuite.set(key, []);
      bySuite.get(key).push(t.name);
    }
    for (const [s, names] of bySuite) {
      if (s !== '') out.push(markdown ? `**${s}**` : `  ${s}`);
      for (const n of names) out.push(`${bullet}${n}`);
      out.push('');
    }
  }

  for (const [f, list] of removed) {
    if (list.length === 0) continue;
    out.push(`${H}Removed from ${f}`);
    out.push('');
    for (const t of list) out.push(`${bullet}${t.suite === '' ? '' : `${t.suite} > `}${t.name}`);
    out.push('');
  }
}

const text = out.join('\n');
console.log(text);

// GitHub Actions: also write it where a reviewer will actually see it.
if (markdown && process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## What this PR specifies\n\n${text}\n`);
}
