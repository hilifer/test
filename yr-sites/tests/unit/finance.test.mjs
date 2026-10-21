// Modules: server/src/finance/finance.js (receivables, reconciliation, monthly report, Kingdee receipts) and
// trade-docs.js (commercial invoice, packing list). Mock Stripe / PayPal / WeCom; ERP in mock mode. IDs FN-xx.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const hooks = [];
const wecom = await mockServer((call) => { hooks.push(call.body); return { json: { errcode: 0 } }; });
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString();
const prov = await mockServer((call) => {
  if (call.url.startsWith('/v1/balance_transactions')) {
    const t = (id, pi, amount, d = -1, type = 'charge') => ({ id, type, amount: amount * 100, currency: 'usd', created: Math.floor(Date.parse(day(d)) / 1000), source: { id: `ch_${id}`, payment_intent: pi }, description: 'Order' });
    return { json: { has_more: false, data: [t('t1', 'pi_1', 100), t('t2', 'pi_2', 55), t('t4', 'pi_4', 80), { id: 'fee', type: 'stripe_fee', amount: -100, currency: 'usd', created: Math.floor(Date.now() / 1000) }] } };
  }
  if (call.url === '/v1/oauth2/token') return { json: { access_token: 'T' } };
  if (call.url.startsWith('/v1/reporting/transactions')) return { json: { transaction_details: [{ transaction_info: { transaction_id: 'CAP1', transaction_amount: { value: '200.00', currency_code: 'USD' }, transaction_initiation_date: day(-2), transaction_event_code: 'T0006' } }] } };
  return { status: 404 };
});
useTempEnv({ site: 'led', ERP_MODE: 'mock', WECOM_WEBHOOK_URL: wecom.url, STRIPE_SECRET_KEY: 'sk_test', STRIPE_API_BASE: prov.url, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_API_BASE: prov.url });
const F = await import('../../server/src/finance/finance.js');
const D = await import('../../server/src/finance/trade-docs.js');
const S = await import('../../server/src/ops/service.js');
const K = await import('../../server/src/ops/erp/kingdee.js');
const { db } = await import('../../server/src/db.js');
after(async () => { await wecom.close(); await prov.close(); });
const settle = () => new Promise((r) => setTimeout(r, 150));

/** A B2B order from an accepted PI. */
function order({ email = `${Math.random().toString(36).slice(2)}@x.test`, company = 'Buyer', qty = 10, price = 50, terms = 'tt30', createdDaysAgo = 0 } = {}) {
  const q = S.createQuote({ customer: { email, company }, lines: [{ sku: 'YR-HB-U2', qty, unit_price: price }], payment_terms: terms });
  S.setQuoteStatus(q.id, 'sent');
  const o = S.acceptQuote(q.id);
  if (createdDaysAgo) db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(day(-createdDaysAgo), o.id);
  return S.getOrder(o.id);
}

describe('receivables', () => {
  test('FN-01 due dates by payment terms; ageing buckets; overdue days', () => {
    const fresh = order({ company: 'Fresh' });
    const late = order({ company: 'Late', createdDaysAgo: 40 });
    const deposited = order({ company: 'Deposited', createdDaysAgo: 70 });
    S.recordPayment(deposited.id, { kind: 'deposit', amount: deposited.deposit_due });
    const rows = Object.fromEntries(F.receivables().map((r) => [r.company, r]));
    assert.equal(rows.Fresh.overdueDays, 0);
    assert.equal(rows.Fresh.due.slice(0, 10), new Date(Date.parse(fresh.created_at) + 7 * 86400e3).toISOString().slice(0, 10));
    assert.equal(rows.Late.overdueDays, 33);
    assert.equal(rows.Late.bucket, '31-60');
    assert.equal(rows.Deposited.due, null, 'balance due before shipment, not shipped yet');
    assert.equal(rows.Deposited.bucket, '61-90');
    assert.equal(rows.Deposited.outstanding, deposited.total - deposited.deposit_due);
    S.setOrderStatus(deposited.id, 'ready_to_ship', { force: true });
    assert.ok(F.receivables().find((r) => r.company === 'Deposited').due, 'due once ready to ship');
    assert.equal(F.dueDate({ ...late, payment_terms: 'tt30bl', paid: late.deposit_due }), null, 'B/L terms: due after shipping');
  });
  test('FN-02 by customer: outstanding, overdue, buckets, oldest; overdue reminder alerts each order once', async () => {
    const byC = F.receivablesByCustomer();
    const late = byC.find((x) => x.company === 'Late');
    assert.equal(late.overdue, late.outstanding);
    assert.equal(late.buckets['31-60'], late.outstanding);
    assert.equal(byC[0].company, 'Late', 'most overdue first');
    hooks.length = 0;
    assert.equal(F.overdueReminder(), 1);
    assert.equal(F.overdueReminder(), 0, 'not again');
    await settle();
    assert.match(hooks[0].markdown.content, /1 笔应收款已逾期[\s\S]*Late[\s\S]*逾期 33 天/);
  });
});

describe('reconciliation', () => {
  test('FN-03 Stripe: matched by payment intent; money we never recorded; money they do not show; amount differences', async () => {
    const a = order({ qty: 2, price: 50 }), b = order({ qty: 2, price: 50 }), c = order({ qty: 2, price: 50 });
    S.recordPayment(a.id, { kind: 'deposit', amount: 100, ref: 'stripe pi_1' });
    S.recordPayment(b.id, { kind: 'deposit', amount: 60, ref: 'stripe pi_3' });
    S.recordPayment(c.id, { kind: 'deposit', amount: 70, ref: 'stripe pi_4' });
    const today = day(0).slice(0, 10), from = day(-7).slice(0, 10);
    const r = await F.reconcile({ source: 'stripe', from, to: today, by: 'fin' });
    assert.deepEqual(r.matched.map((m) => m.theirs.ref), ['pi_1']);
    assert.deepEqual(r.missingOurs.map((t) => t.ref), ['pi_2']);
    assert.deepEqual(r.missingSource.map((p) => p.ref), ['stripe pi_3']);
    assert.deepEqual(r.mismatched.map((m) => [m.theirs.amount, m.ours.amount]), [[80, 70]]);
    assert.equal(F.reconRuns()[0].issues, 3);
    assert.match(prov.calls.find((x) => x.url.startsWith('/v1/balance_transactions')).url, /expand%5B%5D=data\.source/);
    await assert.rejects(F.reconcile({ source: 'stripe', from: today, to: from }), /起止日期/);
  });
  test('FN-04 PayPal: matched by capture id', async () => {
    const o = order({ qty: 4, price: 50 });
    S.recordPayment(o.id, { kind: 'deposit', amount: 200, ref: 'paypal CAP1' });
    const r = await F.reconcile({ source: 'paypal', from: day(-7).slice(0, 10), to: day(0).slice(0, 10) });
    assert.equal(r.matched.length, 1);
    assert.equal(r.missingOurs.length + r.missingSource.length + r.mismatched.length, 0);
  });
  test('FN-05 bank statement: matched by order number in the reference, else by amount and date; unreadable lines reported', async () => {
    const o = order({ company: 'BankCo', qty: 3, price: 100 });
    S.recordPayment(o.id, { kind: 'deposit', amount: 90, ref: 'TT 0001' });
    const o2 = order({ company: 'NoRef', qty: 3, price: 100 });
    S.recordPayment(o2.id, { kind: 'deposit', amount: 91, ref: 'TT 0002' });
    const csv = `date, reference, amount, currency\n${day(0).slice(0, 10)}, ${o.number} deposit, 90, USD\n${day(-1).slice(0, 10)}, WIRE FROM CUSTOMER, 91.00, USD\n${day(0).slice(0, 10)}, unknown, 500, USD\nnot a line`;
    const r = await F.reconcile({ source: 'bank', from: day(-7).slice(0, 10), to: day(0).slice(0, 10), csv });
    assert.deepEqual(r.matched.map((m) => m.ours.number).sort(), [o.number, o2.number].sort());
    assert.deepEqual(r.missingOurs.map((t) => t.amount), [500]);
    assert.equal(r.parseErrors.length, 1);
    assert.ok(r.missingSource.every((p) => !/^(stripe|paypal) /.test(p.ref)), 'online payments are not expected on the bank statement');
    await assert.rejects(F.reconcile({ source: 'bank', from: day(-7).slice(0, 10), to: day(0).slice(0, 10), csv: 'garbage' }), /没有读到流水/);
  });
});

describe('report, ERP, documents', () => {
  test('FN-06 monthly report: orders, order value, received online / transfer, refunds, net', () => {
    const m = day(0).slice(0, 7);
    const [r] = F.monthlyReport([m]);
    const payments = db.prepare('SELECT amount, ref, kind FROM payments WHERE substr(ts, 1, 7) = ?').all(m);
    assert.equal(r.received, Math.round(payments.filter((p) => p.amount > 0).reduce((a, p) => a + p.amount, 0) * 100) / 100);
    assert.equal(r.receivedOnline, 100 + 60 + 70 + 200);
    assert.equal(r.received, r.receivedOnline + r.receivedTransfer);
    const o = order({ qty: 1, price: 40 });
    S.recordPayment(o.id, { kind: 'deposit', amount: 12 });
    S.recordPayment(o.id, { kind: 'refund', amount: 5 });
    const [r2] = F.monthlyReport([m]);
    assert.equal(r2.refunds, 5);
    assert.equal(r2.net, Math.round((r2.received - 5) * 100) / 100);
    assert.equal(r2.orders, db.prepare("SELECT COUNT(*) n FROM orders WHERE status != 'cancelled' AND substr(created_at, 1, 7) = ?").get(m).n);
  });
  test('FN-07 receipts go to the ERP when a payment is recorded (once the customer is in the ERP); refunds are skipped', async () => {
    const o = order({ company: 'ErpCo', qty: 2, price: 100 });
    S.recordPayment(o.id, { kind: 'deposit', amount: 60 });
    await settle();
    let p = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC').get(o.id);
    assert.equal(p.erp_bill_no, null);
    assert.match(p.erp_error, /先推送订单/);
    db.prepare("UPDATE customers SET erp_number = 'CUST001' WHERE id = ?").run(o.customer_id);
    const r = await F.pushReceipt(p.id);
    assert.match(r.bill, /^SKD\d+$/);
    assert.deepEqual(await F.pushReceipt(p.id), { already: r.bill });
    S.recordPayment(o.id, { kind: 'balance', amount: 40 });
    await settle();
    p = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC').get(o.id);
    assert.match(p.erp_bill_no, /^SKD/, 'pushed automatically');
    S.recordPayment(o.id, { kind: 'refund', amount: 10 });
    const ref = db.prepare('SELECT id FROM payments WHERE order_id = ? AND amount < 0').get(o.id);
    assert.deepEqual(await F.pushReceipt(ref.id), { skipped: 'refund' });
    const body = K.buildReceipt({ ...p, order_number: o.number, ref: 'stripe pi_9', kind: 'online', currency: 'USD', amount: 40, ts: '2026-11-08T00:00:00Z' }, { erp_number: 'CUST001' });
    assert.equal(body.Model.FCONTACTUNIT.FNumber, 'CUST001');
    assert.equal(body.Model.FRECEIVEBILLENTRY[0].FRECTOTALAMOUNTFOR, 40);
    assert.equal(body.Model.FRECEIVEBILLENTRY[0].FSETTLETYPEID.FNumber, 'JSFS06_SYS', 'online settlement type');
    assert.equal(body.Model.FDATE, '2026-11-08');
  });
  test('FN-08 packing list: cartons numbered continuously with weights and volume; commercial invoice with HS codes and totals', () => {
    S.saveSku({ ...S.getSku('YR-HB-U2'), pcs_per_carton: 4, carton_cbm: 0.05, carton_gw: 10, hs_code: '9405420000' });
    const second = S.listSkus().find((s) => s.sku !== 'YR-HB-U2' && s.product_id !== 'YR-HB-U2');
    S.saveSku({ ...second, pcs_per_carton: 10, carton_cbm: 0.1, carton_gw: 12 });
    const p = D.packingRows([{ sku: 'YR-HB-U2', qty: 10 }, { sku: second.sku, qty: 25 }, { sku: 'UNKNOWN', qty: 1 }]);
    assert.deepEqual(p.rows.slice(0, 2).map((r) => [r.from, r.to, r.cartons, r.gw, r.cbm]), [[1, 3, 3, 30, 0.15], [4, 6, 3, 36, 0.3]]);
    assert.deepEqual(p.totals, { cartons: 6, qty: 36, nw: p.totals.nw, gw: 66, cbm: 0.45 });
    assert.deepEqual(p.missing, ['UNKNOWN']);
    const o = order({ company: 'Doc Co', qty: 10, price: 50 });
    const ci = D.renderCommercialInvoice(o.id);
    assert.match(ci, /Commercial Invoice/);
    assert.match(ci, /9405420000/);
    assert.match(ci, new RegExp(`CI-${o.number.replace(/^[A-Z]+-?/, '')}`));
    assert.match(ci, /USD 500\.00/);
    assert.match(D.renderCommercialInvoice(o.id, { lang: 'zh' }), /商业发票[\s\S]*原产地/);
    const pl = D.renderPackingList(o.id);
    assert.match(pl, /Packing List[\s\S]*1–3[\s\S]*Shipping marks[\s\S]*C\/No\. 1-3/);
    assert.equal(D.renderPackingList('nope'), null);
  });
});
