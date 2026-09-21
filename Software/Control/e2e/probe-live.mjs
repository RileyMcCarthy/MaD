import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('10.0.2.2')) page = p;
if (!page) { console.log('no app page'); process.exit(0); }
const snap = await page.evaluate(() => {
  const s = globalThis.__madLog?.snapshot?.() ?? { entries: [], counters: {} };
  const last = s.entries.slice(-14).map(e => `${e.tag} ${JSON.stringify(e.data ?? {}).slice(0,140)}`);
  return { counters: s.counters, last, total: s.entries.length };
});
console.log('entries:', snap.total);
console.log('counters:', JSON.stringify(snap.counters));
console.log('--- last entries:'); snap.last.forEach(l => console.log('  ', l));
await b.close();
