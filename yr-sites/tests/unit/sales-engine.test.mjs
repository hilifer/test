// Module: shared/sales-engine.js — product search, reference quotes, lead grading, intent parsing,
// rules-mode replies. Test case IDs (SE-xx) map to docs/测试用例.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  searchProducts, getProduct, productView, estimateQuote, scoreLead, parseIntent, demoReply, publicCatalog, pricesHidden, isCJK, FREE_MAIL,
} from '../../shared/sales-engine.js';

const require = createRequire(import.meta.url);
const led = require('../../sites/led/src/data/catalog.json');
const grid = require('../../sites/grid/src/data/catalog.json');
const ledProfile = { ...require('../../server/profiles/led.json'), site: 'led' };
const gridProfile = { ...require('../../server/profiles/grid.json'), site: 'grid' };

describe('searchProducts', () => {
  test('SE-01 free-text query ranks the matching category first', () => {
    const r = searchProducts(led, { query: 'warehouse ufo high bay' });
    assert.ok(r.length > 0);
    assert.equal(r[0].id, 'YR-HB-U2');
  });
  test('SE-02 wattage filter only returns products covering that power', () => {
    const r = searchProducts(led, { minWatt: 1000 });
    assert.ok(r.length >= 1);
    for (const p of r) assert.ok(p.wattMax >= 1000, `${p.id} max ${p.wattMax}`);
  });
  test('SE-03 category + certification filters combine', () => {
    const r = searchProducts(led, { category: 'high-bay', certification: 'DLC Premium' });
    assert.deepEqual(r.map((p) => p.id), ['YR-HB-U2']);
  });
  test('SE-04 unknown text returns no products (never invents models)', () => {
    assert.deepEqual(searchProducts(led, { query: 'submarine periscope' }), []);
  });
  test('SE-05 limit is respected', () => {
    assert.equal(searchProducts(led, { limit: 2 }).length, 2);
  });
  test('SE-06 Chinese query matches bilingual grid catalog', () => {
    const r = searchProducts(grid, { query: '储能' });
    assert.ok(r.some((p) => p.category.includes('storage')));
  });
});

describe('getProduct / productView', () => {
  test('SE-07a lookup by id is case-insensitive', () => {
    assert.equal(getProduct(led, 'yr-hb-u2').id, 'YR-HB-U2');
  });
  test('SE-07b lookup by slug', () => {
    assert.equal(getProduct(led, 'ufo-high-bay-u2').id, 'YR-HB-U2');
  });
  test('SE-07c an unknown id or slug returns null', () => {
    assert.equal(getProduct(led, 'nope'), null);
  });
  const v8 = productView(led, getProduct(led, 'YR-HB-U2'), 'https://x.test');
  test('SE-08a public view links to the product page and its Markdown version', () => {
    assert.equal(v8.url, 'https://x.test/products/ufo-high-bay-u2/');
    assert.equal(v8.markdown, 'https://x.test/products/ufo-high-bay-u2.md');
  });
  test('SE-08b public view carries the reference price with the disclaimer', () => {
    assert.equal(v8.referencePrice.note, led.priceNote);
  });
  test('SE-08c public view exposes no internal fields (cost, floor price)', () => {
    assert.ok(!('cost' in v8) && !('floorPrice' in v8));
  });
  const hidden = { ...led, priceDisplay: 'hidden' };
  test('SE-09a hidden-price mode is detected', () => {
    assert.equal(pricesHidden(hidden), true);
  });
  test('SE-09b hidden-price mode removes price bands from the public catalog', () => {
    assert.ok(publicCatalog(hidden).products.every((p) => !('priceBands' in p)));
  });
  test('SE-09c hidden-price mode removes the reference price from the product view', () => {
    assert.equal(productView(hidden, getProduct(hidden, 'YR-HB-U2')).referencePrice, null);
  });
  test('SE-09d with prices shown the public catalog is returned unchanged', () => {
    assert.equal(publicCatalog(led), led);
  });
});

describe('estimateQuote', () => {
  const p = getProduct(led, 'YR-HB-U2');
  test('SE-10a picks the unit price band for the quantity', () => {
    const q = estimateQuote(led, p, 600);
    assert.equal(q.ok, true);
    assert.deepEqual(q.unitPrice, { low: 35, high: 46 });
  });
  test('SE-10b multiplies the band by the quantity for the totals', () => {
    assert.deepEqual(estimateQuote(led, p, 600).total, { low: 21000, high: 27600 });
  });
  test('SE-10c the quote carries the disclaimer and the trade term', () => {
    const q = estimateQuote(led, p, 600);
    assert.equal(q.note, led.priceNote);
    assert.equal(q.term, 'FOB Shenzhen');
  });
  test('SE-11 band boundaries (499 / 500)', () => {
    assert.equal(estimateQuote(led, p, 499).unitPrice.low, 39);
    assert.equal(estimateQuote(led, p, 500).unitPrice.low, 35);
  });
  test('SE-12 below MOQ → no price, offers samples', () => {
    const q = estimateQuote(led, p, 10);
    assert.equal(q.ok, false);
    assert.equal(q.reason, 'below_moq');
    assert.equal(q.moq, 50);
  });
  test('SE-13 volume far beyond the last band → handoff, no price', () => {
    const q = estimateQuote(led, p, 50000);
    assert.equal(q.ok, false);
    assert.equal(q.reason, 'volume_project');
    assert.equal(q.handoff, true);
  });
  test('SE-14 hidden prices → price_on_request + handoff', () => {
    const q = estimateQuote({ ...led, priceDisplay: 'hidden' }, p, 600);
    assert.equal(q.reason, 'price_on_request');
    assert.equal(q.handoff, true);
    assert.ok(!('unitPrice' in q));
  });
  test('SE-15 garbage quantity is coerced to 1 (below MOQ)', () => {
    assert.equal(estimateQuote(led, p, 'abc').reason, 'below_moq');
  });
});

describe('scoreLead', () => {
  test('SE-16 empty lead is D', () => assert.equal(scoreLead({}).grade, 'D'));
  test('SE-17 business email + company + 1000 pcs + ASAP + phone → A', () => {
    const s = scoreLead({ email: 'buyer@acme-lighting.com', company: 'Acme', quantity: 1200, timeline: 'ASAP', phone: '+1 555' });
    assert.equal(s.grade, 'A');
    assert.ok(s.reasons.includes('company email'));
  });
  test('SE-18 free-mail addresses do not earn the company-email point', () => {
    assert.ok(FREE_MAIL.test('a@gmail.com'));
    assert.ok(!scoreLead({ email: 'a@gmail.com' }).reasons.includes('company email'));
  });
  test('SE-19a a score of 4–6 is grade B', () => {
    assert.equal(scoreLead({ email: 'x@corp.com', quantity: 300 }).grade, 'B'); // 2+2
  });
  test('SE-19b a score of 2–3 is grade C', () => {
    assert.equal(scoreLead({ email: 'x@corp.com' }).grade, 'C'); // 2
  });
  test('SE-20 channel buyers and quote lists add points', () => {
    const s = scoreLead({ needs: 'distributor for our region', source: 'wholesale', lines: 3 });
    assert.equal(s.score, 2 + 2 + 1);
  });
  test('SE-21 Chinese timeline keywords', () => {
    assert.ok(scoreLead({ timeline: '马上' }).reasons.includes('buying within 1 month'));
    assert.ok(scoreLead({ timeline: '三个月内' }).reasons.includes('buying within 3 months'));
  });
});

describe('parseIntent', () => {
  const it22 = parseIntent('Price for 150W UFO, 1,200 pcs? mail me at bob@corp.com');
  test('SE-22a extracts the wattage', () => {
    assert.equal(it22.watt, 150);
  });
  test('SE-22b extracts the quantity with a thousands separator', () => {
    assert.equal(it22.qty, 1200);
  });
  test('SE-22c detects a price question', () => {
    assert.equal(it22.price, true);
  });
  test('SE-22d extracts the e-mail address', () => {
    assert.equal(it22.email, 'bob@corp.com');
  });
  const it23 = parseIntent('215kWh 储能柜 100kw 需要 5 台 报价');
  test('SE-23a extracts kWh', () => {
    assert.equal(it23.kwh, 215);
  });
  test('SE-23b extracts kW (case-insensitive)', () => {
    assert.equal(it23.kw, 100);
  });
  test('SE-23c extracts a Chinese quantity (台)', () => {
    assert.equal(it23.qty, 5);
  });
  test('SE-23d detects a Chinese price question (报价)', () => {
    assert.equal(it23.price, true);
  });
  test('SE-24a flags an OEM request', () => {
    assert.equal(parseIntent('Can you do OEM with our logo?').oem, true);
  });
  test('SE-24b flags a request for a human', () => {
    assert.equal(parseIntent('I want to talk to a real person').human, true);
  });
  test('SE-24c flags a certification question, but not a bare certification name', () => {
    assert.equal(parseIntent('Does it have UL?').cert, true);
    assert.equal(parseIntent('UL').cert, false);
  });
  test('SE-25 isCJK', () => { assert.equal(isCJK('你好'), true); assert.equal(isCJK('hello'), false); });
});

describe('demoReply (rules mode, same red lines as the AI)', () => {
  const r26 = demoReply(led, ledProfile, [], 'price for 600 pcs ufo high bay 150W');
  test('SE-26a a price question with quantity gets the price range', () => {
    assert.match(r26.reply, /US\$35–US\$46/);
  });
  test('SE-26b the price answer carries the disclaimer', () => {
    assert.match(r26.reply, /Reference only/);
  });
  test('SE-26c the price answer asks for lead details and records the quoted quantity', () => {
    assert.equal(r26.askLead, true);
    assert.equal(r26.quote.quantity, 600);
  });
  test('SE-27 price without quantity asks for quantity first', () => {
    const r = demoReply(led, ledProfile, [], 'how much is the ufo high bay?');
    assert.match(r.reply, /How many units/);
    assert.equal(r.quote, undefined);
  });
  test('SE-28 quantity from earlier turns is remembered', () => {
    const r = demoReply(led, ledProfile, [{ role: 'user', content: 'ufo high bay 150W, 600 pcs' }], 'what is the price?');
    assert.ok(r.quote && r.quote.quantity === 600);
  });
  test('SE-29 OEM request hands off and never quotes', () => {
    const r = demoReply(led, ledProfile, [], 'OEM high bay with my logo, best price for 5000 pcs');
    assert.equal(r.handoff, true);
    assert.doesNotMatch(r.reply, /\$\d/);
  });
  test('SE-30 below-MOQ answer offers samples', () => {
    const r = demoReply(led, ledProfile, [], 'price for 5 pcs ufo high bay');
    assert.match(r.reply, /MOQ/);
    assert.match(r.reply, /samples/i);
  });
  test('SE-31 volume beyond bands hands off', () => {
    const r = demoReply(led, ledProfile, [], 'price for 90000 pcs ufo high bay');
    assert.equal(r.handoff, true);
  });
  test('SE-32 Chinese question gets a Chinese answer with the Chinese disclaimer', () => {
    const r = demoReply(grid, gridProfile, [], '215kWh 工商业储能柜 3 台 报价');
    assert.match(r.reply, /仅供参考，以正式 PI 为准/);
  });
  test('SE-33 grid ROI question links to the calculator', () => {
    const r = demoReply(grid, gridProfile, [], 'what is the payback / ROI?');
    assert.ok(r.link && r.link.href.includes('calculator'));
  });
  const r34 = demoReply(led, ledProfile, [], 'my email is bob@corp.com');
  test('SE-34a a shared e-mail is captured', () => {
    assert.equal(r34.capturedEmail, 'bob@corp.com');
  });
  test('SE-34b a shared e-mail flags the reply for lead capture', () => {
    assert.equal(r34.askLead, true);
  });
  test('SE-35 certification answer comes from the catalog only', () => {
    const r = demoReply(led, ledProfile, [], 'Does the ufo high bay have DLC certification?');
    assert.match(r.reply, /DLC Premium/);
  });
  test('SE-36 every money figure in a rules reply carries a disclaimer (fuzz over products × qty)', () => {
    for (const p of led.products) for (const q of [p.moq, p.moq * 3, 999]) {
      const r = demoReply(led, ledProfile, [], `price for ${q} pcs ${p.name}`);
      if (/US\$\d/.test(r.reply)) assert.match(r.reply, /Reference only/, `${p.id} × ${q}: ${r.reply}`);
    }
  });
});
