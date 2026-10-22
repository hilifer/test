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
  test('DL-01a the deal policy has default discount authority per grade', () => {
    assert.deepEqual(D.dealPolicy().maxDiscountPct, { A: 10, B: 6, C: 3 });
  });
  test('DL-01b an invalid policy is refused with every problem listed', () => {
    assert.throws(() => D.saveDealPolicy({ pct_A: '50', pct_B: '6', pct_C: '3', maxOrderValue: 'x', maxRounds: '0', validityDays: '99', paymentTerms: [], incoterms: [] }), /A 级[\s\S]*最大订单金额[\s\S]*轮数[\s\S]*有效期[\s\S]*付款方式[\s\S]*价格条款/);
  });
  test('DL-01c saving the policy keeps only known payment terms', () => {
    const p = D.saveDealPolicy({ enabled: '1', pct_A: '10', pct_B: '6', pct_C: '3', maxOrderValue: '30000', maxRounds: '3', validityDays: '7', paymentTerms: ['tt30', 'tt100', 'bogus'], incoterms: ['EXW', 'FOB'] });
    assert.deepEqual(p.paymentTerms, ['tt30', 'tt100']);
  });
  test('DL-02a a free webmail address gets trust grade C', () => {
    assert.equal(D.trustGrade('someone@gmail.com'), 'C');
  });
  test('DL-02b a company domain gets trust grade B', () => {
    assert.equal(D.trustGrade('buyer@acme-lighting.test'), 'B');
  });
  const tg = {};
  test('DL-02c an order without payment does not raise the grade', () => {
    const cust = S.findOrCreateCustomer({ email: 'repeat@acme-lighting.test' });
    const q = S.createQuote({ customer: cust, lines: [{ sku: 'NEG-1-A', qty: 10, unit_price: 100 }] });
    S.setQuoteStatus(q.id, 'sent');
    tg.o = S.acceptQuote(q.id);
    assert.equal(D.trustGrade('repeat@acme-lighting.test'), 'B'); // an order alone is not enough
  });
  test('DL-02d a customer with a paid order gets trust grade A', () => {
    S.recordPayment(tg.o.id, { kind: 'deposit', amount: 300 });
    assert.equal(D.trustGrade('repeat@acme-lighting.test'), 'A');
  });
});

describe('negotiation', () => {
  const neg = {};
  test('DL-03a without a target the offer is at list price', () => {
    const r = neg.r = offer(fresh(), [{ product_id: 'NEG-1', qty: 200 }]);
    assert.equal(r.status, 'offer');
    assert.equal(r.lines[0].unit_price, 100);
    assert.equal(r.total, 20000);
  });
  test('DL-03b without a target the SKU tier price applies for large quantities', () => {
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 600 }]).lines[0].unit_price, 90); // tier price for 500+
  });
  test('DL-03c the offer handed to the model contains no limits, floors or grade', () => {
    const json = JSON.stringify(neg.r);
    assert.doesNotMatch(json, /floor|maxDiscount|grade|authority/i);
  });
  test('DL-04a round 1: an unreachable target gets a counter-offer with half the authority', () => {
    neg.email = fresh(); // B grade: 6 %
    const r1 = offer(neg.email, [{ product_id: 'NEG-1', qty: 100, target_price: 80 }]);
    assert.equal(r1.status, 'counter_offer');
    assert.equal(r1.lines[0].unit_price, 97);
  });
  test('DL-04b round 2: the counter-offer uses the full authority', () => {
    const r2 = offer(neg.email, [{ product_id: 'NEG-1', qty: 100, target_price: 80 }]);
    assert.equal(r2.lines[0].unit_price, 94);
  });
  test('DL-04c a target within the authority is accepted, with the saving against list price', () => {
    const r3 = offer(neg.email, [{ product_id: 'NEG-1', qty: 100, target_price: 96 }]);
    assert.equal(r3.status, 'offer');
    assert.equal(r3.lines[0].unit_price, 96);
    assert.equal(r3.saving_vs_list, 400);
  });
  test('DL-05a a C-grade buyer gets less authority; target_discount_pct is honoured', () => {
    const c = offer(fresh('gmail.com'), [{ product_id: 'NEG-1', qty: 100 }], { target_discount_pct: 50 });
    assert.equal(c.lines[0].unit_price, 98.5); // C grade 3 % → round 1 half = 1.5 %
  });
  test('DL-05b a target above list price never raises the price', () => {
    const up = offer(fresh(), [{ product_id: 'NEG-1', qty: 100, target_price: 150 }]);
    assert.equal(up.lines[0].unit_price, 100);
  });
  test('DL-06a a floor price beats the discount authority', () => {
    D.setFloorPrice('NEG-1-A', '99');
    const email = fresh();
    offer(email, [{ product_id: 'NEG-1', qty: 100, target_price: 50 }]);
    const r = offer(email, [{ product_id: 'NEG-1', qty: 100, target_price: 50 }]);
    assert.equal(r.lines[0].unit_price, 99);
  });
  test('DL-06b a floor price for an unknown SKU is refused', () => {
    assert.throws(() => D.setFloorPrice('NOPE', '1'), /SKU 不存在/);
  });
  test('DL-06c a floor price that is not positive is refused', () => {
    assert.throws(() => D.setFloorPrice('NEG-1-A', '-1'), /大于 0/);
  });
  test('DL-06d an empty floor price removes it', () => {
    D.setFloorPrice('NEG-1-A', '');
    assert.equal(D.floorPrices()['NEG-1-A'], undefined);
  });
  test('DL-07a price bands are used when the SKU has no price', () => {
    const r = offer(fresh(), [{ product_id: 'NEG-2', qty: 50 }]);
    assert.equal(r.lines[0].unit_price, 60);
  });
  test('DL-07b a product with no price at all needs approval and the buyer is told so', () => {
    const x = offer(fresh(), [{ product_id: 'NEG-3', qty: 50 }]);
    assert.equal(x.status, 'needs_approval');
    assert.match(x.tell_customer, /approval/);
  });
  test('DL-08a an order value above the cap needs approval', () => {
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 1000 }]).status, 'needs_approval'); // 90 000 > 30 000
  });
  test('DL-08b payment terms outside the policy need approval', () => {
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }], { payment_terms: 'lc' }).status, 'needs_approval');
  });
  test('DL-08c an incoterm outside the policy needs approval', () => {
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }], { incoterm: 'DDP' }).status, 'needs_approval');
  });
  test('DL-08d more rounds than allowed need approval, with reason max_rounds', () => {
    const e = fresh();
    for (let i = 0; i < 3; i++) assert.notEqual(offer(e, [{ product_id: 'NEG-1', qty: 10, target_price: 1 }]).status, 'needs_approval');
    const four = offer(e, [{ product_id: 'NEG-1', qty: 10, target_price: 1 }]);
    assert.equal(four.status, 'needs_approval');
    assert.deepEqual(D.getOffer(four.offer_id).reasons, ['max_rounds']);
  });
  test('DL-09a an offer request without an e-mail is an error', () => {
    assert.equal(D.prepareOffer({ lines: [{ product_id: 'NEG-1', qty: 10 }] }).error, 'email_required');
  });
  test('DL-09b an offer request without lines is an error', () => {
    assert.equal(offer(fresh(), []).error, 'lines_required');
  });
  test('DL-09c an offer request for an unknown product is an error', () => {
    assert.equal(offer(fresh(), [{ product_id: 'NOPE', qty: 10 }]).error, 'unknown_product');
  });
  test('DL-09d an offer request with an invalid quantity is an error', () => {
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 0 }]).error, 'bad_quantity');
  });
  test('DL-09e an offer request below the MOQ is an error', () => {
    assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 5 }]).error, 'below_moq');
  });
  test('DL-09f with negotiation disabled the request is handed off', () => {
    D.saveDealPolicy({ pct_A: '10', pct_B: '6', pct_C: '3', maxOrderValue: '30000', maxRounds: '3', validityDays: '7', paymentTerms: ['tt30', 'tt100'], incoterms: ['EXW', 'FOB'] }); // enabled unticked
    try {
      assert.equal(offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }]).error, 'negotiation_disabled');
    } finally {
      D.saveDealPolicy({ enabled: '1', pct_A: '10', pct_B: '6', pct_C: '3', maxOrderValue: '30000', maxRounds: '3', validityDays: '7', paymentTerms: ['tt30', 'tt100'], incoterms: ['EXW', 'FOB'] });
    }
  });
});

describe('contracts & e-signature', () => {
  const ctx = {};
  test('DL-10a issuing a contract for a different e-mail than the offer is refused', async () => {
    ctx.email = fresh();
    ctx.o = offer(ctx.email, [{ product_id: 'NEG-1', qty: 100, target_price: 97 }], { company: '<script>alert(1)</script> Ltd', port: 'Shenzhen' });
    assert.equal((await D.issueContract(ctx.o.offer_id, { email: 'other@x.test' })).error, 'email_mismatch');
  });
  test('DL-10b an accepted offer is issued as a contract sent to the offer address; the link is not returned to the chat', async () => {
    const r = await D.issueContract(ctx.o.offer_id, { email: ctx.email });
    assert.equal(r.issued, true);
    assert.equal(r.sent_to, ctx.email);
    assert.doesNotMatch(JSON.stringify(r), /portal\/contract/); // the link is not handed to the chat
    ctx.k = D.getContract(r.contract_number);
  });
  test('DL-10c issuing the contract creates a sent PI (quote) with the offer total', () => {
    const q = S.getQuote(ctx.k.quote_id);
    assert.equal(q.status, 'sent');
    assert.equal(q.total, 9700);
  });
  test('DL-10d issuing the contract again is idempotent', async () => {
    assert.equal((await D.issueContract(ctx.o.offer_id, { email: ctx.email })).already, true);
  });
  test('DL-10e the signing link is e-mailed to the offer address', () => {
    const m = mails(ctx.email).find((x) => /for your signature/.test(x.subject));
    assert.ok(m.body.includes(`/portal/contract/${ctx.k.token}`));
  });
  test('DL-10f the offer is marked contracted', () => {
    assert.equal(D.getOffer(ctx.o.offer_id).status, 'contracted');
  });
  test('DL-11a contract text contains the template heading and the goods table', () => {
    assert.match(ctx.k.body, /Sales Contract/);
    assert.match(ctx.k.body, /NEG-1-A/);
  });
  test('DL-11b contract text contains the formatted total', () => {
    assert.match(ctx.k.body, /USD 9,700\.00/);
  });
  test('DL-11c contract text contains payment, warranty and lead-time terms', () => {
    const k = ctx.k;
    assert.match(k.body, /30% T\/T deposit, 70% before shipment/);
    assert.match(k.body, /5 years from the date of shipment/);
    assert.match(k.body, /15–25 days/);
  });
  test('DL-11d values inserted into the contract are HTML-escaped', () => {
    assert.doesNotMatch(ctx.k.body, /<script>/);
    assert.match(ctx.k.body, /&lt;script&gt;/);
  });
  test('DL-11e the contract fingerprint is the SHA-256 of the frozen text', () => {
    assert.equal(ctx.k.hash, createHash('sha256').update(ctx.k.body).digest('hex'));
  });
  test('DL-12a signing requires a full name', async () => {
    await assert.rejects(D.signContract(ctx.k.token, { name: 'P', agree: '1' }), /full name/);
  });
  test('DL-12b signing requires consent', async () => {
    await assert.rejects(D.signContract(ctx.k.token, { name: 'Pat Lee' }), /read and agree/);
  });
  test('DL-12c signing creates an order awaiting a 30 % deposit', async () => {
    const order = ctx.order = await D.signContract(ctx.k.token, { name: 'Pat Lee', title: 'Purchasing Manager', agree: '1', ip: '203.0.113.9', ua: 'UnitTest/1.0' });
    assert.equal(order.status, 'awaiting_deposit');
    assert.equal(order.deposit_due, 2910);
  });
  test('DL-12d the signed contract records the signer and still verifies', () => {
    const k = D.getContract(ctx.k.id);
    assert.equal(k.status, 'signed');
    assert.equal(k.signer_ip, '203.0.113.9');
    assert.equal(k.signer_email, ctx.email);
    assert.deepEqual(D.verifyContract(k), { intact: true, hash: k.hash, signature: true });
  });
  test('DL-12e signing marks the quote accepted', () => {
    assert.equal(S.getQuote(D.getContract(ctx.k.id).quote_id).status, 'accepted');
  });
  test('DL-12f a copy with the order number is e-mailed to the buyer', () => {
    assert.ok(mails(ctx.email).some((m) => m.subject.includes(`order ${ctx.order.number}`)));
  });
  test('DL-12g a signed contract cannot be signed again', async () => {
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
  const ap = {};
  test('DL-14a approving an offer with a zero price is refused', async () => {
    const big = offer(fresh(), [{ product_id: 'NEG-1', qty: 1000 }]);
    ap.id = D.getOffer(big.offer_id).id;
    await assert.rejects(D.decideOffer(ap.id, { approve: true, prices: { 'NEG-1-A': '0' } }), /请填写单价/);
  });
  test('DL-14b approving with an adjusted price issues the contract at that price, recording who decided', async () => {
    const r = await D.decideOffer(ap.id, { approve: true, note: 'Volume deal', prices: { 'NEG-1-A': '85' } });
    assert.equal(r.issued, true);
    assert.equal(S.getQuote(D.getContract(r.contract_number).quote_id).total, 85000);
    assert.equal(D.getOffer(ap.id).decided_by, 'admin');
  });
  test('DL-14c only pending offers can be decided', async () => {
    await assert.rejects(D.decideOffer(ap.id, { approve: true }), /只有待审批/);
  });
  test('DL-14d an offer awaiting approval cannot become a contract', async () => {
    const lc = offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }], { payment_terms: 'lc' });
    ap.lc = D.getOffer(lc.offer_id);
    assert.equal((await D.issueContract(lc.offer_id, { email: ap.lc.email })).error, 'awaiting_approval');
  });
  test('DL-14e rejecting an offer marks it rejected and e-mails the buyer the reason', async () => {
    await D.decideOffer(ap.lc.id, { approve: false, note: 'L/C not available for first orders' });
    assert.equal(D.getOffer(ap.lc.id).status, 'rejected');
    assert.ok(mails(ap.lc.email).some((m) => /L\/C not available/.test(m.body)));
  });
  const st = {};
  test('DL-15a staff can create a contract from a quote, which marks the quote sent', async () => {
    const cust = S.findOrCreateCustomer({ email: 'manual@buyer-co.test', company: 'Manual Co' });
    st.q = S.createQuote({ customer: cust, lines: [{ sku: 'NEG-1-A', qty: 20, unit_price: 95 }] });
    st.k = await D.createContractForQuote(st.q.id);
    assert.equal(S.getQuote(st.q.id).status, 'sent');
  });
  test('DL-15b a quote has at most one open contract', async () => {
    assert.equal((await D.createContractForQuote(st.q.id)).id, st.k.id); // one open contract per quote
  });
  test('DL-15c voiding a contract requires a reason', () => {
    assert.throws(() => D.voidContract(st.k.id, ''), /作废原因/);
  });
  test('DL-15d a void contract cannot be signed', async () => {
    D.voidContract(st.k.id, 'price changed');
    await assert.rejects(D.signContract(st.k.token, { name: 'Pat Lee', agree: '1' }), /no longer open/);
  });
  test('DL-15e a signed contract cannot be voided', () => {
    assert.throws(() => D.voidContract(ctx.k.id, 'x'), /只有待签署/);
  });
  test('DL-15f after voiding, a new contract can be created for the quote', async () => {
    const k2 = await D.createContractForQuote(st.q.id);
    assert.notEqual(k2.id, st.k.id);
  });
  test('DL-16a a contract template that is too short is refused', () => {
    assert.throws(() => D.saveContractTemplate('too short'), /太短/);
  });
  test('DL-16b a contract template without {{goods_table}} is refused', () => {
    assert.throws(() => D.saveContractTemplate('x'.repeat(300)), /goods_table/);
  });
  test('DL-16c a new template is used for new contracts', async () => {
    ctx.before = D.getContract(ctx.k.id).body;
    D.saveContractTemplate(`## Goods\n{{goods_table}}\nTotal {{currency}} {{total}}.\n\n## Payment\n{{payment_terms}}.\n\n## Special clause\nCUSTOM-CLAUSE-XYZ ${'lorem ipsum '.repeat(20)}`);
    const cust = S.findOrCreateCustomer({ email: 'tpl@buyer-co.test' });
    const q = S.createQuote({ customer: cust, lines: [{ sku: 'NEG-1-A', qty: 10, unit_price: 100 }] });
    const k = await D.createContractForQuote(q.id);
    assert.match(k.body, /CUSTOM-CLAUSE-XYZ/);
  });
  test('DL-16d a new template does not change existing contracts', () => {
    assert.equal(D.getContract(ctx.k.id).body, ctx.before);
  });
  const ex = {};
  test('DL-17a an expired offer cannot become a contract', async () => {
    const o = offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }]);
    db.prepare('UPDATE deal_offers SET valid_until = ? WHERE number = ?').run('2020-01-01T00:00:00Z', o.offer_id);
    ex.o2 = offer(fresh(), [{ product_id: 'NEG-1', qty: 10 }]);
    db.prepare('UPDATE deal_offers SET valid_until = ? WHERE number = ?').run('2020-01-01T00:00:00Z', ex.o2.offer_id);
    assert.equal((await D.issueContract(o.offer_id, { email: D.getOffer(o.offer_id).email })).error, 'offer_expired');
  });
  test('DL-17b expireOffers closes expired offers', () => {
    assert.ok(D.expireOffers() >= 1);
    assert.equal(D.getOffer(ex.o2.offer_id).status, 'expired');
  });
});
