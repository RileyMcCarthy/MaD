/**
 * Escaping. All of it lives here so neither emitter can quietly grow its own.
 *
 * The security argument is short: after `escapeHtml`, snapshot content cannot
 * contain a raw `<`, `>`, `"`, `'` or `&`. That is what makes
 * `assertNoExternalRefs` sound — a scanner that requires a REAL quote or a REAL
 * tag can never be fooled by content, and can never false-positive on a
 * snapshot that happens to contain the literal text `href="http://…"`.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * JSON destined for a `<script type="application/json">` island.
 *
 * `</script` inside a string would end the element and blank the rest of the
 * report — the failure is total, not cosmetic. U+2028/U+2029 are escaped
 * because they are literal line terminators to a JS parser.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Markdown characters that would otherwise turn content into formatting. */
export function escapeMarkdownInline(input: string): string {
  return input.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
}

/** Cell text for a GitHub-flavoured markdown table. */
export function markdownCell(input: string | number | null): string {
  if (input === null) return '';
  const text = typeof input === 'number' ? formatNumber(input) : input;
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/**
 * A fence long enough for its content.
 *
 * A snapshot line containing ``` breaks a 3-backtick fence and everything after
 * it renders as prose — which reads as if the diff simply had fewer lines.
 * CommonMark allows any run of 3+ backticks, so the fix is to count.
 */
export function fenceFor(content: string, minimum = 3): string {
  let longest = 0;
  const re = /`+/g;
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    longest = Math.max(longest, m[0].length);
    m = re.exec(content);
  }
  return '`'.repeat(Math.max(minimum, longest + 1));
}

/** Byte length, because every budget in this tool is stated in bytes. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** A GitHub-compatible anchor slug. Used for in-report links only. */
export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 64);
}
