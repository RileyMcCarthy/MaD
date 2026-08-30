/**
 * Format detection.
 *
 * The manifest declares which key a glob sits under, so the adapter is known
 * before we open the file. Sniffing exists for one reason: to catch the case
 * where the declaration is WRONG — a `junit:` glob pointed at vitest's JSON
 * reporter output, say. Parsing that with the XML adapter yields zero cases,
 * which renders as "no tests" and reads as "tests are configured and empty".
 * Detecting the mismatch and parsing with the right adapter (loudly) is the
 * only outcome that is both useful and honest.
 */

import type { AdapterId } from './model.js';

export type SniffResult = AdapterId | 'unknown';

const BOM = '﻿';

/** Cheap, content-based, never trusts the file extension. */
export function sniff(text: string): SniffResult {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const head = body.slice(0, 8192);
  const trimmed = head.replace(/^\s+/, '');

  if (trimmed.startsWith('<')) {
    // An XML declaration, a comment or a doctype can precede the root element.
    // The character class must include '/': an empty document is written
    // <testsuites/>, and requiring whitespace-or-'>' misses it.
    return /<testsuites?[\s/>]/.test(head) ? 'junit-xml' : 'unknown';
  }

  if (trimmed.startsWith('{')) {
    // Structural keys, not a full parse: these files reach tens of MB.
    if (/"testResults"\s*:/.test(head) || /"numTotalTests"\s*:/.test(head)) return 'vitest-json';
    if (/"test_suites"\s*:/.test(head) || /"testcase_nums"\s*:/.test(head)) return 'pio-json';
    return 'unknown';
  }

  // LCOV is line-oriented `PREFIX:csv`. `SF:` is mandatory in every section,
  // and `end_of_record` is the only prefix-free line the format has.
  if (/^(TN:|SF:|DA:|FN:|FNF:|BRDA:|LF:|VER:)/m.test(head) || /^end_of_record\s*$/m.test(head)) {
    return 'lcov';
  }

  return 'unknown';
}

export function isTestAdapter(a: AdapterId): boolean {
  return a !== 'lcov';
}
