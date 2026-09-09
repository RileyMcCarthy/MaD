/**
 * `assertNoExternalRefs` — the one guarantee the HTML report makes about
 * itself: opening it never talks to the network.
 *
 * WHY it is a runtime check and not just a code review rule: the HTML is
 * assembled from blocks a PROJECT-AUTHORED renderer produced. A renderer that
 * emits a CDN URL turns every reviewer's report into a beacon, and it would do
 * it silently. This is the check that catches that, and it is a unit test too.
 *
 * WHY it scans structure rather than text: content is HTML-escaped before it is
 * embedded, so it can never contain a raw `<` or `"`. A scanner that requires a
 * real tag or a real quote therefore cannot be fooled BY content and cannot
 * false-positive ON content. A naive `indexOf('href=')` scan does both: a
 * snapshot of an HTML fixture containing `href="http://x"` escapes to
 * `href=&quot;http://x&quot;` and would be flagged forever.
 */

export interface ExternalRefViolation {
  readonly kind: 'attribute' | 'style' | 'script' | 'element';
  readonly detail: string;
}

/** Attributes that can cause a fetch. `href` on `<a>` is handled separately. */
const URL_ATTRIBUTES = new Set([
  'src',
  'srcset',
  'href',
  'data',
  'poster',
  'action',
  'formaction',
  'background',
  'cite',
  'codebase',
  'longdesc',
  'manifest',
  'ping',
  'profile',
  'usemap',
  'xlink:href',
]);

/** Elements whose `href` is a navigation, not a subresource fetch. */
const NAVIGATION_ELEMENTS = new Set(['a', 'area']);

/** A value that cannot reach the network. */
function isLocalValue(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (v.startsWith('#')) return true;
  if (v.startsWith('data:')) return true;
  return false;
}

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** Constructs that fetch from inside CSS or JS. */
const CSS_HAZARDS: readonly (readonly [RegExp, string])[] = [
  [/@import\b/i, '@import'],
  [/url\(\s*['"]?(?!data:|#)[a-z]+:/i, 'url() with a non-data scheme'],
  [/url\(\s*['"]?\/\//i, 'url() with a protocol-relative URL'],
];
const JS_HAZARDS: readonly (readonly [RegExp, string])[] = [
  [/\bfetch\s*\(/, 'fetch('],
  [/\bnew\s+Worker\b/, 'new Worker'],
  [/\bimportScripts\s*\(/, 'importScripts('],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bimport\s*\(/, 'dynamic import('],
];

/**
 * Returns a list of violations. Non-empty means the emitter MUST throw rather
 * than write the file: a report that phones home is worse than no report,
 * because it is a report a reviewer will trust.
 */
export function assertNoExternalRefs(html: string): string[] {
  const violations: string[] = [];

  // 1. Tag attributes. Only real tags with real quotes reach here.
  TAG_RE.lastIndex = 0;
  let tag: RegExpExecArray | null = TAG_RE.exec(html);
  while (tag !== null) {
    const name = (tag[1] ?? '').toLowerCase();
    const attrs = tag[2] ?? '';
    ATTR_RE.lastIndex = 0;
    let attr: RegExpExecArray | null = ATTR_RE.exec(attrs);
    while (attr !== null) {
      const attrName = (attr[1] ?? '').toLowerCase();
      const value = attr[3] ?? attr[4] ?? attr[5] ?? '';
      if (URL_ATTRIBUTES.has(attrName)) {
        const isNav = attrName === 'href' && NAVIGATION_ELEMENTS.has(name);
        if (!isLocalValue(value) && !isNav) {
          violations.push(`<${name} ${attrName}="${value.slice(0, 120)}"> is not a data: or # reference`);
        }
        if (isNav && !isLocalValue(value)) {
          // A link the user must click is not a load-time fetch, but a report
          // that links out is still worth surfacing rather than hiding.
          violations.push(
            `<${name} href="${value.slice(0, 120)}"> links off the page; only in-page anchors are allowed`,
          );
        }
      }
      if (attrName.startsWith('on')) {
        violations.push(`<${name} ${attrName}=…> inline event handler`);
      }
      if (attrName === 'style') {
        // An inline style is CSS, and CSS can fetch. Scanned with the same
        // rules as a <style> block rather than trusted for being short.
        for (const [re, label] of CSS_HAZARDS) {
          if (re.test(value)) violations.push(`<${name} style="…"> contains ${label}`);
        }
      }
      attr = ATTR_RE.exec(attrs);
    }
    tag = TAG_RE.exec(html);
  }

  // 2. Inline CSS.
  STYLE_RE.lastIndex = 0;
  let style: RegExpExecArray | null = STYLE_RE.exec(html);
  while (style !== null) {
    const css = style[1] ?? '';
    for (const [re, label] of CSS_HAZARDS) {
      if (re.test(css)) violations.push(`<style> contains ${label}`);
    }
    style = STYLE_RE.exec(html);
  }

  // 3. Scripts. An executable script is itself reportable: the report is
  //    required to be fully readable with JS disabled, so it should not have
  //    any. `type="application/json"` islands are data, not code.
  SCRIPT_RE.lastIndex = 0;
  let script: RegExpExecArray | null = SCRIPT_RE.exec(html);
  while (script !== null) {
    const attrs = (script[1] ?? '').toLowerCase();
    const body = script[2] ?? '';
    const isData = /type\s*=\s*["']application\/json["']/.test(attrs);
    if (!isData) {
      for (const [re, label] of JS_HAZARDS) {
        if (re.test(body)) violations.push(`<script> contains ${label}`);
      }
    }
    script = SCRIPT_RE.exec(html);
  }

  return violations;
}

/** Throwing wrapper for the emit path. */
export function throwIfExternalRefs(html: string, where: string): void {
  const violations = assertNoExternalRefs(html);
  if (violations.length > 0) {
    throw new Error(
      `${where}: the report must be self-contained, but it references external resources:\n  - ${violations.join('\n  - ')}`,
    );
  }
}
