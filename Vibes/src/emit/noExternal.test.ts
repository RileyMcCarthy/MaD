import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escape.js';
import { assertNoExternalRefs, throwIfExternalRefs } from './noExternal.js';

describe('assertNoExternalRefs catches every way a page can phone home', () => {
  const hostile: readonly (readonly [string, string])[] = [
    ['stylesheet link', '<link rel="stylesheet" href="https://cdn.example.com/a.css">'],
    ['script src', '<script src="https://cdn.example.com/x.js"></script>'],
    ['image', '<img src="http://tracker.example.com/pixel.gif">'],
    ['protocol-relative image', '<img src="//cdn.example.com/x.png">'],
    ['srcset', '<img srcset="https://cdn.example.com/x@2x.png 2x">'],
    ['iframe', '<iframe src="https://example.com/"></iframe>'],
    ['object data', '<object data="https://example.com/a.pdf"></object>'],
    ['form action', '<form action="https://example.com/collect"></form>'],
    ['css @import', '<style>@import url("https://fonts.example.com/x.css");</style>'],
    ['css url()', '<style>body{background:url(https://cdn.example.com/bg.png)}</style>'],
    ['css protocol-relative url()', '<style>body{background:url(//cdn.example.com/bg.png)}</style>'],
    ['inline style url()', '<div style="background:url(https://cdn.example.com/b.png)"></div>'],
    ['fetch', '<script>fetch("https://example.com/x")</script>'],
    ['worker', '<script>const w = new Worker("w.js")</script>'],
    ['websocket', '<script>new WebSocket("wss://example.com")</script>'],
    ['dynamic import', '<script>import("https://example.com/m.js")</script>'],
    ['inline handler', '<button onclick="go()">x</button>'],
    ['outbound link', '<a href="https://example.com/">docs</a>'],
  ];

  for (const [label, html] of hostile) {
    it(`flags ${label}`, () => {
      expect(assertNoExternalRefs(html).length).toBeGreaterThan(0);
    });
  }
});

describe('assertNoExternalRefs accepts a self-contained page', () => {
  const benign: readonly (readonly [string, string])[] = [
    ['inline style block', '<style>body{background:var(--bg)}</style>'],
    ['data uri image', '<img src="data:image/png;base64,iVBORw0KGgo=">'],
    ['in-page anchor', '<a href="#findings">findings</a>'],
    ['empty href', '<a href="">x</a>'],
    ['inline svg', '<svg viewBox="0 0 10 10"><polyline points="0,0 1,1" fill="none"/></svg>'],
    ['json island', '<script type="application/json">{"url":"https://example.com"}</script>'],
    ['data-attributes', '<div data-theme="dark" data-count="3"></div>'],
  ];

  for (const [label, html] of benign) {
    it(`accepts ${label}`, () => {
      expect(assertNoExternalRefs(html)).toEqual([]);
    });
  }
});

/**
 * The whole reason the scanner is structural rather than textual.
 *
 * A snapshot of an HTML fixture legitimately contains the literal text
 * `href="https://…"`. After escaping, it cannot contain a real quote, so a
 * scanner that requires real quotes cannot see it — while a naive
 * `html.includes('href=')` scan would flag it on every run forever, and the
 * team would delete the check.
 */
describe('escaped snapshot content never trips the scanner', () => {
  const hostileContent = [
    '<link rel="stylesheet" href="https://cdn.example.com/a.css">',
    '<script src="https://evil.example.com/x.js"></script>',
    'body { background: url(https://cdn.example.com/bg.png) }',
    '@import "https://fonts.example.com/x.css";',
    'fetch("https://example.com")',
    'new Worker("w.js")',
    '<img srcset="https://cdn.example.com/x 2x">',
    'onclick="alert(1)"',
  ];

  it('embeds hostile-looking snapshot text without a violation', () => {
    const page = `<style>body{color:var(--fg)}</style><main><pre><code>${hostileContent
      .map(escapeHtml)
      .join('\n')}</code></pre></main>`;
    expect(assertNoExternalRefs(page)).toEqual([]);
  });

  it('still catches the same markup when it is NOT escaped', () => {
    const page = `<main>${hostileContent.join('\n')}</main>`;
    expect(assertNoExternalRefs(page).length).toBeGreaterThan(0);
  });
});

describe('throwIfExternalRefs', () => {
  it('throws with every violation named', () => {
    expect(() =>
      throwIfExternalRefs('<img src="https://a.example/1.png"><script src="https://b.example/x.js"></script>', 'report.html'),
    ).toThrow(/report\.html: the report must be self-contained/);
  });

  it('is silent on a clean page', () => {
    expect(() => throwIfExternalRefs('<p>hello</p>', 'report.html')).not.toThrow();
  });
});
