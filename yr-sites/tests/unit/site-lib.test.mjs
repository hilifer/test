// Module: shared/site-lib.mjs — the machine-readable layer for AI agents (GEO). IDs ML-xx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { productMarkdown, llmsTxt, llmsFull, productJsonLd, faqJsonLd, rssXml, sitemapXml, robotsTxt, newsMarkdown, priceLine } from '../../shared/site-lib.mjs';

const require = createRequire(import.meta.url);
const led = require('../../sites/led/src/data/catalog.json');
const grid = require('../../sites/grid/src/data/catalog.json');
const site = 'https://www.example.test';
const p = led.products.find((x) => x.id === 'YR-HB-U2');

test('ML-01 product Markdown has specs table, certifications, MOQ and the reference-price disclaimer', () => {
  const md = productMarkdown({ site, brand: 'YAORONG', catalog: led, p });
  assert.match(md, /^# UFO/);
  assert.match(md, /\| Item \| Value \|/);
  for (const c of p.certifications) assert.ok(md.includes(`- ${c}`));
  assert.match(md, /MOQ: 50 pcs/);
  assert.match(md, /Reference only — subject to the formal PI\. Freight not included\./);
  assert.match(md, /MCP endpoint https:\/\/www\.example\.test\/mcp/);
});
test('ML-02 hidden-price catalog never prints price bands in Markdown or JSON-LD', () => {
  const hidden = { ...led, priceDisplay: 'hidden' };
  const md = productMarkdown({ site, brand: 'Y', catalog: hidden, p });
  assert.doesNotMatch(md, /Reference price/);
  assert.match(md, /Quoted per project/);
  assert.equal(productJsonLd({ site, brand: 'Y', catalog: hidden, p }).offers, undefined);
});
test('ML-03 Chinese Markdown uses the zh name / summary', () => {
  const g = grid.products[0];
  const md = productMarkdown({ site, brand: 'YR GRID', catalog: grid, p: g, lang: 'zh' });
  assert.ok(md.startsWith(`# ${g.nameZh || g.name}`));
});
test('ML-04 llms.txt lists every product with a .md link, quote + MCP entry points', () => {
  const txt = llmsTxt({ site, brand: 'YAORONG', company: 'Shaanxi Yaorong Co.', about: 'LED lighting', catalog: led, pages: [{ title: 'Factory', path: '/factory/', desc: 'x' }], contact: { email: 's@x.test' } });
  for (const prod of led.products) assert.ok(txt.includes(`${site}/products/${prod.slug}.md`), prod.slug);
  assert.match(txt, /MCP server for AI agents: https:\/\/www\.example\.test\/mcp/);
  assert.match(txt, /- Email: s@x\.test/);
  assert.match(txt, /llms-full\.txt/);
});
test('ML-05 llms-full contains all products', () => {
  const full = llmsFull({ site, brand: 'Y', catalog: led });
  assert.equal((full.match(/^## /gm) || []).length, led.products.length);
});
test('ML-06 Product JSON-LD: schema.org Product + AggregateOffer from public bands', () => {
  const j = productJsonLd({ site, brand: 'YAORONG', catalog: led, p });
  assert.equal(j['@type'], 'Product');
  assert.equal(j.sku, 'YR-HB-U2');
  assert.equal(j.offers['@type'], 'AggregateOffer');
  assert.equal(j.offers.lowPrice, 32);
  assert.equal(j.offers.highPrice, 52);
  assert.equal(j.offers.eligibleQuantity.minValue, 50);
  assert.ok(j.additionalProperty.length > 3);
});
test('ML-07 FAQ JSON-LD', () => {
  assert.equal(faqJsonLd([]), null);
  const f = faqJsonLd([{ q: 'Q?', a: 'A.' }]);
  assert.equal(f['@type'], 'FAQPage');
  assert.equal(f.mainEntity[0].acceptedAnswer.text, 'A.');
});
test('ML-08 RSS escapes XML and uses absolute links', () => {
  const xml = rssXml({ site, title: 'News & <updates>', description: 'd', items: [{ title: 'A "quoted" & <b>', path: '/news/a/', date: '2026-01-02', description: 'x' }] });
  assert.match(xml, /News &amp; &lt;updates&gt;/);
  assert.match(xml, /A &quot;quoted&quot; &amp; &lt;b&gt;/);
  assert.match(xml, /<link>https:\/\/www\.example\.test\/news\/a\/<\/link>/);
});
test('ML-09 sitemap with lastmod + hreflang alternates', () => {
  const xml = sitemapXml(site, [{ path: '/products/', lastmod: '2026-03-04T10:00:00Z', alternates: [{ lang: 'zh', path: '/zh/products/' }] }]);
  assert.match(xml, /<loc>https:\/\/www\.example\.test\/products\/<\/loc><lastmod>2026-03-04<\/lastmod>/);
  assert.match(xml, /hreflang="zh" href="https:\/\/www\.example\.test\/zh\/products\/"/);
});
test('ML-10 robots.txt welcomes AI crawlers, blocks admin/api, links sitemap + llms.txt', () => {
  const r = robotsTxt(site);
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Bingbot']) assert.match(r, new RegExp(`User-agent: ${bot}\\nAllow: /`));
  assert.match(r, /Disallow: \/admin/);
  assert.match(r, /Disallow: \/api\//);
  assert.match(r, /Sitemap: https:\/\/www\.example\.test\/sitemap\.xml/);
});
test('ML-11 news Markdown includes FAQ and sources', () => {
  const md = newsMarkdown({ site, entry: { id: 'a', body: 'Body', data: { title: 'T', description: 'D', date: '2026-01-01', faq: [{ q: 'Q', a: 'A' }], sources: [{ title: 'S', url: 'https://s.test' }] } } });
  assert.match(md, /## FAQ/);
  assert.match(md, /- \[S\]\(https:\/\/s\.test\)/);
});
test('ML-12 priceLine spans all bands', () => {
  assert.equal(priceLine(led, p), 'USD 32–52 per pc (FOB Shenzhen)');
  assert.equal(priceLine(led, { ...p, priceBands: [] }), 'On request');
});
