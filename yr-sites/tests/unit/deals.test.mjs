// Modules: server/src/ops/deals.js — AI negotiation within finance's authority (trust grade, stepped concessions, floor
// prices, caps, approval queue) and e-contracts (template, frozen + hashed text, e-signature, order creation). IDs DL-xx.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { useTempEnv } from '../helpers/env.mjs';

useTempEnv({ site: 'led', ERP_MODE: 'local' });
const D = await import('../../server/src/ops/deals.js');
const S = await import('../../server/src/ops/service.js');
const C = await import('../../server/src/catalog/store.js');
const { db } = await import('../../server/src/db.js');

const base = { category: 'indoor', summary: 'Negotiation test product.', warranty: '5 years', unit: 'pcs', moq: 10, leadTimeDays: [15, 25], sampleDays: [3, 5], specs: 'Power: 100 W' };
C.saveProduct({ ...base, id: 'NEG-1', name: 'Negotiable Panel' }, { isNew: true, status: 'published', salesMode: 'both', variants: [{ sku: 'NEG-1-A', price: '100', min_qty: '10', tier_prices: '500:90', weight_kg: '1', stock_local: '100000' }] });
C.saveProduct({ ...base, id: 'NEG-2', name: 'Banded Flood', priceBands: '10-99:50-60 | 100+:45-55' }, { isNew: true, status: 'published', salesMode: 'inquiry', variants: [{ sku: 'NEG-2-A', price: '', min_qty: '10' }] });
C.saveProduct({ ...base, id: 'NEG-3', name: 'Project Only' }, { isNew: true, status: 'published', salesMode: 'inquiry', variants: [{ sku: 'NEG-3-A', price: '', min_qty: '10' }] });
C.publishCatalog();
S.seedSkus();

const mails = (to) => db.prepare('SELECT subject, body FROM mail_outbox WHERE to_addr = ? ORDER BY id').all(to);
let n = 0;
const fresh = (domain = 'buyer-co.test') => `p${++n}@${domain}`;
const offer = (email, lines, extra = {}) => D.prepareOffer({ email, company: 'Buyer Co', name: 'Pat Lee', country: 'US', lines, ...extra });

describe('policy & trust grade', () => {
  test('DL-01 policy defaults; validation; save', () => {
    assert.deepEqual(D.dealPolicy().maxDiscountPct, { A: 10, B: 6, C: 3 });
    assert.throws(() => D.saveDealPolicy({ pct_A: '50', pct_B: '6', pct_C: '3', maxOrderValue: 'x', maxRounds: '0', validityDays: '99', paymentTerms: [], incoterms: [] }), /A 级[\s\S]*最大订单金额[\s\S]*轮数[\s\S]*有效期[\s\S]*付款方式[\s\S]*价格条款/);
    const p = D.saveDealPolicy({ enabled: '1', pct_A: '10', pct_B: '6', pct_C: '3', maxOrderValue: '30000', maxRounds: '3', validityDays: '7', paymentTerms: ['tt30', 'tt100', 'bogus'], incoterms: ['EXW', 'FOB'] });
    assert.deepEqual(p.paymentTerms, ['tt30', 'tt100']);
  });
  test('DL-02 trust grade uses verifiable signals only: free webmail C, company domain B, paid order A', () => {
    assert.equal(D.trustGrade('someone@gmail.com'), 'C');
    assert.equal(D.trustGrade('buyer@acme-lighting.test'), 'B');
    const cust = S.findOrCreateCustomer({ email: 'repeat@acme-lighting.test' });
    const q = S.createQuote({ customer: cust, lines: [{ sku: 'NEG-1-A', qty: 10, unit_price: 100 }] });
    S.setQuoteStatus(q.id, 'sent');
    const o = S.acceptQuote(q.id);
    assert.equal(D.trustGrade('repeat@acme-lighting.test'), 'B'); // an order alone is not enough
    S.recordPayment(o.id, { kind: 'deposit', amount: 300 });
    assert.equal(D.trustGrade('repeat@acme-lighting.test'), 'A');
  });
});

describe('negotiation', () => {
  test('DL-03 no target → list price (SKU tier price); the model never receives limits, floors or the grade', () => {
    const r = offer(fresh(), [{ product_id: 'NEG-1', qty: 200 }]);
    assert.equal(r.status, 'offer');
    assert.equal(r.lines[0].unit_price, 100);
    assert.equal(r.total, 20000);
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 600 }]).lines[0].unit_price, 90); // tier price for 500+
    const json = JSON.stringify(r);
    assert.doesNotMatch(json, /floor|maxDiscount|grade|authority/i);
  });
  test('DL-04 stepped concessions: round 1 gives half the authority, round 2 the full authority; a reachable target is accepted', () => {
    const email = fresh(); // B grade: 6 %
    const r1 = offer(email, [{ product_id: 'NEG-1', qty: 100, target_price: 80 }]);
    assert.equal(r1.status, 'counter_offer');
    assert.equal(r1.lines[0].unit_price, 97);
    const r2 = offer(email, [{ product_id: 'NEG-1', qty: 100, target_price: 80 }]);
    assert.equal(r2.lines[0].unit_price, 94);
    const r3 = offer(email, [{ product_id: 'NEG-1', qty: 100, target_price: 96 }]);
    assert.equal(r3.status, 'offer');
    assert.equal(r3.lines[0].unit_price, 96);
    assert.equal(r3.saving_vs_list, 400);
  });
  test('DL-05 grades get different authority; target_discount_pct works; never above list price', () => {
    const c = offer(fresh('gmail.com'), [{ product_id: 'NEG-1', qty: 100 }], { target_discount_pct: 50 });
    assert.equal(c.lines[0].unit_price, 98.5); // C grade 3 % → round 1 half = 1.5 %
    const up = offer(fresh(), [{ product_id: 'NEG-1', qty: 100, target_price: 150 }]);
    assert.equal(up.lines[0].unit_price, 100);
  });
  test('DL-06 floor price beats the discount authority', () => {
    D.setFloorPrice('NEG-1-A', '99');
    const email = fresh();
    offer(email, [{ product_id: 'NEG-1', qty: 100, target_price: 50 }]);
    const r = offer(email, [{ product_id: 'NEG-1', qty: 100, target_price: 50 }]);
    assert.equal(r.lines[0].unit_price, 99);
    assert.throws(() => D.setFloorPrice('NOPE', '1'), /SKU 不存在/);
    assert.throws(() => D.setFloorPrice('NEG-1-A', '-1'), /大于 0/);
    D.setFloorPrice('NEG-1-A', '');
    assert.equal(D.floorPrices()['NEG-1-A'], undefined);
  });
  test('DL-07 price bands are used when the SKU has no price; no price at all → approval', () => {
    const r = offer(fresh(), [{ product_id: 'NEG-2', qty: 50 }]);
    assert.equal(r.lines[0].unit_price, 60);
    const x = offer(fresh(), [{ product_id: 'NEG-3', qty: 50 }]);
    assert.equal(x.status, 'needs_approval');
    assert.match(x.tell_customer, /approval/);
  });
  test('DL-08 outside authority → needs_approval: value cap, payment terms, incoterm, too many rounds', () => {
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 1000 }]).status, 'needs_approval'); // 90 000 > 30 000
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }], { payment_terms: 'lc' }).status, 'needs_approval');
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }], { incoterm: 'DDP' }).status, 'needs_approval');
    const e = fresh();
    for (let i = 0; i < 3; i++) assert.notEqual(offer(e, [{ product_id: 'NEG-1', qty: 10, target_price: 1 }]).status, 'needs_approval');
    const four = offer(e, [{ product_id: 'NEG-1', qty: 10, target_price: 1 }]);
    assert.equal(four.status, 'needs_approval');
    assert.deepEqual(D.getOffer(four.offer_id).reasons, ['max_rounds']);
  });
  test('DL-09 input errors: e-mail, lines, unknown product, quantity, MOQ; disabled policy hands off', () => {
    assert.equal(D.prepareOffer({ lines: [{ product_id: 'NEG-1', qty: 10 }] }).error, 'email_required');
    assert.equal(offer(fresh(), []).error, 'lines_required');
    assert.equal(offer(fresh(), [{ product_id: 'NOPE', qty: 10 }]).error, 'unknown_product');
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 0 }]).error, 'bad_quantity');
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 5 }]).error, 'below_moq');
    D.saveDealPolicy({ pct_A: '10', pct_B: '6', pct_C: '3', maxOrderValue: '30000', maxRounds: '3', validityDays: '7', paymentTerms: ['tt30', 'tt100'], incoterms: ['EXW', 'FOB'] }); // enabled unticked
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }]).error, 'negotiation_disabled');
    D.saveDealPolicy({ enabled: '1', pct_A: '10', pct_B: '6', pct_C: '3', maxOrderValue: '30000', maxRounds: '3', validityDays: '7', paymentTerms: ['tt30', 'tt100'], incoterms: ['EXW', 'FOB'] });
  });
});

describe('contracts & e-signature', () => {
  const ctx = {};
  test('DL-10 accepted offer → PI (sent) + contract e-mailed to the offer address only; idempotent; mismatched e-mail refused', async () => {
    ctx.email = fresh();
    const o = offer(ctx.email, [{ product_id: 'NEG-1', qty: 100, target_price: 97 }], { company: '<script>alert(1)</script> Ltd', port: 'Shenzhen' });
    assert.equal((await D.issueContract(o.offer_id, { email: 'other@x.test' })).error, 'email_mismatch');
    const r = await D.issueContract(o.offer_id, { email: ctx.email });
    assert.equal(r.issued, true);
    assert.equal(r.sent_to, ctx.email);
    assert.doesNotMatch(JSON.stringify(r), /portal\/contract/); // the link is not handed to the chat
    ctx.k = D.getContract(r.contract_number);
    const q = S.getQuote(ctx.k.quote_id);
    assert.equal(q.status, 'sent');
    assert.equal(q.total, 9700);
    assert.equal((await D.issueContract(o.offer_id, { email: ctx.email })).already, true);
    const m = mails(ctx.email).find((x) => /for your signature/.test(x.subject));
    assert.ok(m.body.includes(`/portal/contract/${ctx.k.token}`));
    assert.equal(D.getOffer(o.offer_id).status, 'contracted');
  });
  test('DL-11 contract text: template clauses, goods table, totals, terms; values escaped; fingerprint = SHA-256 of the frozen text', () => {
    const k = ctx.k;
    assert.match(k.body, /Sales Contract/);
    assert.match(k.body, /NEG-1-A/);
    assert.match(k.body, /USD 9,700\.00/);
    assert.match(k.body, /30% T\/T deposit, 70% before shipment/);
    assert.match(k.body, /5 years from the date of shipment/);
    assert.match(k.body, /15–25 days/);
    assert.doesNotMatch(k.body, /<script>/);
    assert.match(k.body, /&lt;script&gt;/);
    assert.equal(k.hash, createHash('sha256').update(k.body).digest('hex'));
  });
  test('DL-12 signing: name and consent required; then signed with time/IP/UA, order created with 30 % deposit, copy e-mailed', async () => {
    await assert.rejects(D.signContract(ctx.k.token, { name: 'P', agree: '1' }), /full name/);
    await assert.rejects(D.signContract(ctx.k.token, { name: 'Pat Lee' }), /read and agree/);
    const order = await D.signContract(ctx.k.token, { name: 'Pat Lee', title: 'Purchasing Manager', agree: '1', ip: '203.0.113.9', ua: 'UnitTest/1.0' });
    assert.equal(order.status, 'awaiting_deposit');
    assert.equal(order.deposit_due, 2910);
    const k = D.getContract(ctx.k.id);
    assert.equal(k.status, 'signed');
    assert.equal(k.signer_ip, '203.0.113.9');
    assert.equal(k.signer_email, ctx.email);
    assert.deepEqual(D.verifyContract(k), { intact: true, hash: k.hash, signature: true });
    assert.equal(S.getQuote(k.quote_id).status, 'accepted');
    assert.ok(mails(ctx.email).some((m) => m.subject.includes(`order ${order.number}`)));
    await assert.rejects(D.signContract(ctx.k.token, { name: 'Pat Lee', agree: '1' }), /already been signed/);
  });
  test('DL-13 tampered contract text cannot be signed and fails verification', async () => {
    const o = offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }]);
    const r = await D.issueContract(o.offer_id, { email: D.getOffer(o.offer_id).email });
    const k = D.getContract(r.contract_number);
    db.prepare('UPDATE contracts SET body = replace(body, ?, ?) WHERE id = ?').run('1,000.00', '1.00', k.id);
    await assert.rejects(D.signContract(k.token, { name: 'Pat Lee', agree: '1' }), /integrity/);
    assert.equal(D.verifyContract(D.getContract(k.id)).intact, false);
  });
  test('DL-14 approval queue: approve with adjusted price → contract issued; floor enforced by the admin; reject e-mails the buyer; only pending offers', async () => {
    const big = offer(fresh(), [{ product_id: 'NEG-1', qty: 1000 }]);
    const id = D.getOffer(big.offer_id).id;
    await assert.rejects(D.decideOffer(id, { approve: true, prices: { 'NEG-1-A': '0' } }), /请填写单价/);
    const r = await D.decideOffer(id, { approve: true, note: 'Volume deal', prices: { 'NEG-1-A': '85' } });
    assert.equal(r.issued, true);
    assert.equal(S.getQuote(D.getContract(r.contract_number).quote_id).total, 85000);
    assert.equal(D.getOffer(id).decided_by, 'admin');
    await assert.rejects(D.decideOffer(id, { approve: true }), /只有待审批/);
    const lc = offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }], { payment_terms: 'lc' });
    const lcOffer = D.getOffer(lc.offer_id);
    assert.equal((await D.issueContract(lc.offer_id, { email: lcOffer.email })).error, 'awaiting_approval');
    await D.decideOffer(lcOffer.id, { approve: false, note: 'L/C not available for first orders' });
    assert.equal(D.getOffer(lcOffer.id).status, 'rejected');
    assert.ok(mails(lcOffer.email).some((m) => /L\/C not available/.test(m.body)));
  });
  test('DL-15 staff contract from a quote; void (reason required, only unsigned); a void contract cannot be signed', async () => {
    const cust = S.findOrCreateCustomer({ email: 'manual@buyer-co.test', company: 'Manual Co' });
    const q = S.createQuote({ customer: cust, lines: [{ sku: 'NEG-1-A', qty: 20, unit_price: 95 }] });
    const k = await D.createContractForQuote(q.id);
    assert.equal(S.getQuote(q.id).status, 'sent');
    assert.equal((await D.createContractForQuote(q.id)).id, k.id); // one open contract per quote
    assert.throws(() => D.voidContract(k.id, ''), /作废原因/);
    D.voidContract(k.id, 'price changed');
    await assert.rejects(D.signContract(k.token, { name: 'Pat Lee', agree: '1' }), /no longer open/);
    assert.throws(() => D.voidContract(ctx.k.id, 'x'), /只有待签署/);
    const k2 = await D.createContractForQuote(q.id);
    assert.notEqual(k2.id, k.id);
  });
  test('DL-16 template: validation; a new template applies to new contracts only', async () => {
    assert.throws(() => D.saveContractTemplate('too short'), /太短/);
    assert.throws(() => D.saveContractTemplate('x'.repeat(300)), /goods_table/);
    const before = D.getContract(ctx.k.id).body;
    D.saveContractTemplate(`## Goods\n{{goods_table}}\nTotal {{currency}} {{total}}.\n\n## Payment\n{{payment_terms}}.\n\n## Special clause\nCUSTOM-CLAUSE-XYZ ${'lorem ipsum '.repeat(20)}`);
    const cust = S.findOrCreateCustomer({ email: 'tpl@buyer-co.test' });
    const q = S.createQuote({ customer: cust, lines: [{ sku: 'NEG-1-A', qty: 10, unit_price: 100 }] });
    const k = await D.createContractForQuote(q.id);
    assert.match(k.body, /CUSTOM-CLAUSE-XYZ/);
    assert.equal(D.getContract(ctx.k.id).body, before);
  });
  test('DL-17 expired offers cannot become contracts; expireOffers closes them', async () => {
    const o = offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }]);
    db.prepare('UPDATE deal_offers SET valid_until = ? WHERE number = ?').run('2020-01-01T00:00:00Z', o.offer_id);
    const o2 = offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }]);
    db.prepare('UPDATE deal_offers SET valid_until = ? WHERE number = ?').run('2020-01-01T00:00:00Z', o2.offer_id);
    assert.equal((await D.issueContract(o.offer_id, { email: D.getOffer(o.offer_id).email })).error, 'offer_expired');
    assert.ok(D.expireOffers() >= 1);
    assert.equal(D.getOffer(o2.offer_id).status, 'expired');
  });
});
