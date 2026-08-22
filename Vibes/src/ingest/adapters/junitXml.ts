/**
 * JUnit XML — the portable fallback adapter.
 *
 * There is no JUnit XML standard, only a family of dialects. The two this repo
 * can actually produce were captured and read before this was written:
 *
 *   vitest 2.1.9  <testsuite name="test/a.test.ts" …><testcase classname="test/a.test.ts"
 *                 name="outer &gt; inner &gt; passes" time="0.0006"/>
 *   PlatformIO    <testsuite name="native_test:test_gcode" …><testcase name="…"
 *                 time="0" status="PASSED" file="test/x/main.c" line="42"/>
 *
 * They disagree on nearly everything: pio has no `classname` and carries
 * `status`/`file`/`line`; vitest has no `file` and encodes the hierarchy into
 * the case name. So status is decided from CHILD ELEMENTS first (present in
 * every dialect) and only then from a `status` attribute.
 *
 * TWO fast-xml-parser SETTINGS ARE MANDATORY, and both are silent when wrong:
 *
 *   ignoreAttributes: false — attributes are DROPPED by default. Every count,
 *     every classname, every file and every time vanishes and the file parses
 *     into an empty shell that reports zero tests.
 *   isArray for testsuite/testcase/failure/error/skipped — a suite holding
 *     exactly ONE <testcase> otherwise parses as an object, not an array, so
 *     the single-test suite (the beta.test.ts case in the captured fixture)
 *     is skipped by every `for … of` in the file.
 */

import { XMLParser } from 'fast-xml-parser';

import type { RepoPath, TestCaseResult, TestSummary } from '../../types.js';
import { mapArtifactPath, type Relativizer } from '../paths.js';
import { createRelativizer } from '../paths.js';
import {
  AdapterParseError,
  capMessage,
  secondsToMs,
  type ParseNote,
  type TestParseOptions,
  type TestParseResult,
} from './shared.js';

const ARRAY_TAGS = new Set(['testsuite', 'testcase', 'failure', 'error', 'skipped']);

function makeParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Keep every value a string: `name="1.0"` must not become the number 1,
    // and a test named "007" must not lose its leading zeros.
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
    isArray: (name, _jpath, _isLeaf, isAttribute) => !isAttribute && ARRAY_TAGS.has(name),
  });
}

type XmlNode = Record<string, unknown>;

export function parseJUnitXml(text: string, opts: TestParseOptions): TestParseResult {
  let doc: XmlNode;
  try {
    doc = makeParser().parse(text) as XmlNode;
  } catch (err) {
    throw new AdapterParseError(`JUnit XML parse failed: ${(err as Error).message}`);
  }

  const relativize: Relativizer = createRelativizer(opts.repoRoot);
  const notes: ParseNote[] = [];
  const cases: TestCaseResult[] = [];

  const rootSuites = nodes(doc['testsuites']);
  const bareSuites = nodes(doc['testsuite']);
  if (rootSuites.length === 0 && bareSuites.length === 0) {
    throw new AdapterParseError('no <testsuites> or <testsuite> element found');
  }

  let rootTimeMs: number | null = null;
  let declaredTests: number | null = null;
  let declaredFailures: number | null = null;
  let declaredErrors: number | null = null;

  for (const rs of rootSuites) {
    rootTimeMs = rootTimeMs ?? secondsToMs(str(rs['@_time']));
    declaredTests = declaredTests ?? intAttr(rs['@_tests']);
    declaredFailures = declaredFailures ?? intAttr(rs['@_failures']);
    declaredErrors = declaredErrors ?? intAttr(rs['@_errors']);
    for (const s of nodes(rs['testsuite'])) walkSuite(s, [], cases, opts, relativize, notes);
    // Some emitters put <testcase> directly under <testsuites>.
    collectCases(rs, suiteName(rs, []), cases, opts, relativize, notes);
  }
  for (const s of bareSuites) walkSuite(s, [], cases, opts, relativize, notes);

  let suiteTimeMs: number | null = null;
  for (const s of allSuites(doc)) {
    const t = secondsToMs(str(s['@_time']));
    if (t !== null) suiteTimeMs = (suiteTimeMs ?? 0) + t;
  }

  const summary = tally(cases, rootTimeMs ?? suiteTimeMs, opts);

  // The header counts are the file's own claim about itself; disagreement with
  // the case list means one of the two is wrong and neither may be trusted
  // silently.
  if (declaredTests !== null && declaredTests !== summary.total) {
    notes.push({
      reason: 'count-mismatch',
      severity: 'warn',
      detail: `<testsuites tests="${declaredTests}"> but ${summary.total} <testcase> element(s) found`,
    });
  }
  const declaredBad = (declaredFailures ?? 0) + (declaredErrors ?? 0);
  if ((declaredFailures !== null || declaredErrors !== null) && declaredBad !== summary.failed) {
    notes.push({
      reason: 'count-mismatch',
      severity: 'warn',
      detail: `header claims ${declaredBad} failure/error(s), case list has ${summary.failed}`,
    });
  }

  return { summary, notes };
}

function walkSuite(
  suite: XmlNode,
  ancestry: readonly string[],
  out: TestCaseResult[],
  opts: TestParseOptions,
  relativize: Relativizer,
  notes: ParseNote[],
): void {
  const name = suiteName(suite, ancestry);
  collectCases(suite, name, out, opts, relativize, notes);
  // Nested <testsuite> is legal (maven surefire aggregates, jest nests).
  for (const child of nodes(suite['testsuite'])) {
    walkSuite(child, [...ancestry, suiteOwnName(suite)], out, opts, relativize, notes);
  }
}

function collectCases(
  suite: XmlNode,
  suiteLabel: string,
  out: TestCaseResult[],
  opts: TestParseOptions,
  relativize: Relativizer,
  notes: ParseNote[],
): void {
  for (const tc of nodes(suite['testcase'])) {
    const name = str(tc['@_name']) ?? '<unnamed>';
    // Presence, not shape: a self-closing `<skipped/>` parses to the EMPTY
    // STRING, so an object-typed check silently classifies every skipped test
    // as passed. Verified against the captured vitest XML, which writes
    // exactly that form.
    const failures = rawNodes(tc['failure']);
    const errors = rawNodes(tc['error']);
    const skips = rawNodes(tc['skipped']);
    const statusAttr = (str(tc['@_status']) ?? '').toLowerCase();

    let status: TestCaseResult['status'];
    if (skips.length > 0 || statusAttr.startsWith('skip') || statusAttr === 'notrun' || statusAttr === 'disabled') {
      status = 'skipped';
    } else if (failures.length > 0 || errors.length > 0 || statusAttr.startsWith('fail') || statusAttr.startsWith('error')) {
      status = 'failed';
    } else {
      status = 'passed';
    }

    const message = failureMessage([...failures, ...errors, ...skips]);
    // R-I5: only `file=` is a path. `classname` is opaque — maven writes an
    // FQCN there and vitest writes a path, and there is no way to tell.
    const fileRaw = str(tc['@_file']);
    let file: RepoPath | undefined;
    if (fileRaw !== undefined && fileRaw !== '') {
      const mapped = mapArtifactPath(fileRaw, {
        relativize,
        repoRoot: opts.repoRoot,
        anchorAbs: opts.rootAbs,
        trackedPaths: opts.trackedPaths,
      });
      if (mapped.ok) file = mapped.path;
      else {
        notes.push({
          reason: 'unmapped-paths',
          severity: 'info',
          detail: `testcase file="${fileRaw}" is ${mapped.reason}; attribution dropped`,
        });
      }
    }

    out.push({
      suite: suiteLabel,
      name,
      status,
      durationMs: secondsToMs(str(tc['@_time'])),
      ...(message !== undefined ? { message } : {}),
      ...(file !== undefined ? { file } : {}),
    });
  }
}

function failureMessage(nodesIn: readonly unknown[]): string | undefined {
  const parts: string[] = [];
  for (const n of nodesIn) {
    if (typeof n === 'string') {
      if (n !== '') parts.push(n);
      continue;
    }
    if (n === null || typeof n !== 'object') continue;
    const node = n as XmlNode;
    const type = str(node['@_type']);
    const msg = str(node['@_message']);
    const text = str(node['#text']);
    const head = [type, msg].filter((x): x is string => x !== undefined && x !== '').join(': ');
    const body = [head, text].filter((x): x is string => x !== undefined && x !== '').join('\n');
    if (body !== '') parts.push(body);
  }
  if (parts.length === 0) return undefined;
  return capMessage(parts.join('\n---\n'));
}

function tally(cases: readonly TestCaseResult[], durationMs: number | null, opts: TestParseOptions): TestSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.status === 'passed') passed += 1;
    else if (c.status === 'failed') failed += 1;
    else skipped += 1;
  }
  return {
    total: cases.length,
    passed,
    failed,
    skipped,
    durationMs,
    cases,
    source: opts.sourceLabel,
    stale: opts.stale,
  };
}

/* ──────────────────────────────── helpers ─────────────────────────────── */

function suiteOwnName(suite: XmlNode): string {
  return str(suite['@_name']) ?? '<unnamed suite>';
}

function suiteName(suite: XmlNode, ancestry: readonly string[]): string {
  const own = suiteOwnName(suite);
  return ancestry.length === 0 ? own : [...ancestry, own].join(' > ');
}

function allSuites(doc: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  const visit = (n: XmlNode): void => {
    for (const s of nodes(n['testsuite'])) {
      out.push(s);
      visit(s);
    }
  };
  for (const rs of nodes(doc['testsuites'])) visit(rs);
  visit(doc);
  return out;
}

/** Every value under a tag, unfiltered — empty elements arrive as ''. */
function rawNodes(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** isArray guarantees arrays for the tags we care about; this stays defensive
 *  because a document can also carry a single <testsuites> object. */
function nodes(v: unknown): XmlNode[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x): x is XmlNode => typeof x === 'object' && x !== null);
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function intAttr(v: unknown): number | null {
  const s = str(v);
  if (s === undefined) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
