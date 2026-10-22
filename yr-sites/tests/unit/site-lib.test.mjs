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

const md1 = productMarkdown({ site, brand: 'YAORONG', catalog: led, p });
test('ML-01a product Markdown starts with the product name and has a specs table', () => {
  assert.match(md1, /^# UFO/);
  assert.match(md1, /\| Item \| Value \|/);
});
test('ML-01b product Markdown lists every certification', () => {
  for (const c of p.certifications) assert.ok(md1.includes(`- ${c}`));
});
test('ML-01c product Markdown states the MOQ', () => {
  assert.match(md1, /MOQ: 50 pcs/);
});
test('ML-01d product Markdown carries the reference-price disclaimer', () => {
  assert.match(md1, /Reference only — subject to the formal PI\. Freight not included\./);
});
test('ML-01e product Markdown points to the MCP endpoint', () => {
  assert.match(md1, /MCP endpoint https:\/\/www\.example\.test\/mcp/);
});
const hidden = { ...led, priceDisplay: 'hidden' };
test('ML-02a hidden-price product Markdown prints no price bands, only "quoted per project"', () => {
  const md = productMarkdown({ site, brand: 'Y', catalog: hidden, p });
  assert.doesNotMatch(md, /Reference price/);
  assert.match(md, /Quoted per project/);
});
test('ML-02b hidden-price Product JSON-LD has no offers', () => {
  assert.equal(productJsonLd({ site, brand: 'Y', catalog: hidden, p }).offers, undefined);
});
test('ML-03 Chinese Markdown uses the zh name / summary', () => {
  const g = grid.products[0];
  const md = productMarkdown({ site, brand: 'YR GRID', catalog: grid, p: g, lang: 'zh' });
  assert.ok(md.startsWith(`# ${g.nameZh || g.name}`));
});
const txt4 = llmsTxt({ site, brand: 'YAORONG', company: 'Shaanxi Yaorong Co.', about: 'LED lighting', catalog: led, pages: [{ title: 'Factory', path: '/factory/', desc: 'x' }], contact: { email: 's@x.test' } });
test('ML-04a llms.txt lists every product with a .md link', () => {
  for (const prod of led.products) assert.ok(txt4.includes(`${site}/products/${prod.slug}.md`), prod.slug);
});
test('ML-04b llms.txt names the MCP server entry point', () => {
  assert.match(txt4, /MCP server for AI agents: https:\/\/www\.example\.test\/mcp/);
});
test('ML-04c llms.txt gives the contact e-mail', () => {
  assert.match(txt4, /- Email: s@x\.test/);
});
test('ML-04d llms.txt links to llms-full.txt', () => {
  assert.match(txt4, /llms-full\.txt/);
});
test('ML-05 llms-full contains all products', () => {
  const full = llmsFull({ site, brand: 'Y', catalog: led });
  assert.equal((full.match(/^## /gm) || []).length, led.products.length);
});
const j6 = productJsonLd({ site, brand: 'YAORONG', catalog: led, p });
test('ML-06a Product JSON-LD is a schema.org Product with SKU and spec properties', () => {
  assert.equal(j6['@type'], 'Product');
  assert.equal(j6.sku, 'YR-HB-U2');
  assert.ok(j6.additionalProperty.length > 3);
});
test('ML-06b Product JSON-LD has an AggregateOffer spanning the public bands from the MOQ', () => {
  assert.equal(j6.offers['@type'], 'AggregateOffer');
  assert.equal(j6.offers.lowPrice, 32);
  assert.equal(j6.offers.highPrice, 52);
  assert.equal(j6.offers.eligibleQuantity.minValue, 50);
});
test('ML-07a FAQ JSON-LD of an empty list is null', () => {
  assert.equal(faqJsonLd([]), null);
});
test('ML-07b FAQ JSON-LD is an FAQPage with the answers', () => {
  const f = faqJsonLd([{ q: 'Q?', a: 'A.' }]);
  assert.equal(f['@type'], 'FAQPage');
  assert.equal(f.mainEntity[0].acceptedAnswer.text, 'A.');
});
const xml8 = rssXml({ site, title: 'News & <updates>', description: 'd', items: [{ title: 'A "quoted" & <b>', path: '/news/a/', date: '2026-01-02', description: 'x' }] });
test('ML-08a RSS escapes XML special characters in titles', () => {
  assert.match(xml8, /News &amp; &lt;updates&gt;/);
  assert.match(xml8, /A &quot;quoted&quot; &amp; &lt;b&gt;/);
});
test('ML-08b RSS uses absolute item links', () => {
  assert.match(xml8, /<link>https:\/\/www\.example\.test\/news\/a\/<\/link>/);
});
const xml9 = sitemapXml(site, [{ path: '/products/', lastmod: '2026-03-04T10:00:00Z', alternates: [{ lang: 'zh', path: '/zh/products/' }] }]);
test('ML-09a sitemap gives absolute locations with the lastmod date', () => {
  assert.match(xml9, /<loc>https:\/\/www\.example\.test\/products\/<\/loc><lastmod>2026-03-04<\/lastmod>/);
});
test('ML-09b sitemap lists hreflang alternates', () => {
  assert.match(xml9, /hreflang="zh" href="https:\/\/www\.example\.test\/zh\/products\/"/);
});
const r10 = robotsTxt(site);
test('ML-10a robots.txt welcomes AI crawlers', () => {
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Bingbot']) assert.match(r10, new RegExp(`User-agent: ${bot}\\nAllow: /`));
});
test('ML-10b robots.txt blocks admin and API paths', () => {
  assert.match(r10, /Disallow: \/admin/);
  assert.match(r10, /Disallow: \/api\//);
});
test('ML-10c robots.txt links the sitemap', () => {
  assert.match(r10, /Sitemap: https:\/\/www\.example\.test\/sitemap\.xml/);
});
const md11 = newsMarkdown({ site, entry: { id: 'a', body: 'Body', data: { title: 'T', description: 'D', date: '2026-01-01', faq: [{ q: 'Q', a: 'A' }], sources: [{ title: 'S', url: 'https://s.test' }] } } });
test('ML-11a news Markdown includes the FAQ', () => {
  assert.match(md11, /## FAQ/);
});
test('ML-11b news Markdown lists the sources as links', () => {
  assert.match(md11, /- \[S\]\(https:\/\/s\.test\)/);
});
test('ML-12a priceLine spans all bands', () => {
  assert.equal(priceLine(led, p), 'USD 32–52 per pc (FOB Shenzhen)');
});
test('ML-12b priceLine without bands is "On request"', () => {
  assert.equal(priceLine(led, { ...p, priceBands: [] }), 'On request');
});
