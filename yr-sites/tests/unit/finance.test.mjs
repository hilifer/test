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
  const ar = {};
  test('FN-01a the due date follows the payment terms; a new order is not overdue', () => {
    ar.fresh = order({ company: 'Fresh' });
    ar.late = order({ company: 'Late', createdDaysAgo: 40 });
    ar.deposited = order({ company: 'Deposited', createdDaysAgo: 70 });
    S.recordPayment(ar.deposited.id, { kind: 'deposit', amount: ar.deposited.deposit_due });
    ar.rows = Object.fromEntries(F.receivables().map((r) => [r.company, r]));
    assert.equal(ar.rows.Fresh.overdueDays, 0);
    assert.equal(ar.rows.Fresh.due.slice(0, 10), new Date(Date.parse(ar.fresh.created_at) + 7 * 86400e3).toISOString().slice(0, 10));
  });
  test('FN-01b an unpaid old order shows its overdue days and ageing bucket', () => {
    assert.equal(ar.rows.Late.overdueDays, 33);
    assert.equal(ar.rows.Late.bucket, '31-60');
  });
  test('FN-01c after the deposit, the balance is not due before shipment but is aged and outstanding', () => {
    const { deposited } = ar;
    assert.equal(ar.rows.Deposited.due, null, 'balance due before shipment, not shipped yet');
    assert.equal(ar.rows.Deposited.bucket, '61-90');
    assert.equal(ar.rows.Deposited.outstanding, deposited.total - deposited.deposit_due);
  });
  test('FN-01d the balance becomes due once the order is ready to ship', () => {
    S.setOrderStatus(ar.deposited.id, 'ready_to_ship', { force: true });
    assert.ok(F.receivables().find((r) => r.company === 'Deposited').due, 'due once ready to ship');
  });
  test('FN-01e with B/L terms the balance is due only after shipping', () => {
    assert.equal(F.dueDate({ ...ar.late, payment_terms: 'tt30bl', paid: ar.late.deposit_due }), null, 'B/L terms: due after shipping');
  });
  test('FN-02a receivables by customer show outstanding, overdue and ageing buckets', () => {
    const late = F.receivablesByCustomer().find((x) => x.company === 'Late');
    assert.equal(late.overdue, late.outstanding);
    assert.equal(late.buckets['31-60'], late.outstanding);
  });
  test('FN-02b receivables by customer list the most overdue first', () => {
    assert.equal(F.receivablesByCustomer()[0].company, 'Late', 'most overdue first');
  });
  test('FN-02c the overdue reminder covers each overdue order only once', () => {
    hooks.length = 0;
    assert.equal(F.overdueReminder(), 1);
    assert.equal(F.overdueReminder(), 0, 'not again');
  });
  test('FN-02d the overdue reminder alert names the customer and the days overdue', async () => {
    await settle();
    assert.match(hooks[0].markdown.content, /1 笔应收款已逾期[\s\S]*Late[\s\S]*逾期 33 天/);
  });
});

describe('reconciliation', () => {
  const rc = {};
  test('FN-03a Stripe: transactions are matched to our payments by payment intent', async () => {
    const a = order({ qty: 2, price: 50 }), b = order({ qty: 2, price: 50 }), c = order({ qty: 2, price: 50 });
    S.recordPayment(a.id, { kind: 'deposit', amount: 100, ref: 'stripe pi_1' });
    S.recordPayment(b.id, { kind: 'deposit', amount: 60, ref: 'stripe pi_3' });
    S.recordPayment(c.id, { kind: 'deposit', amount: 70, ref: 'stripe pi_4' });
    rc.today = day(0).slice(0, 10); rc.from = day(-7).slice(0, 10);
    rc.r = await F.reconcile({ source: 'stripe', from: rc.from, to: rc.today, by: 'fin' });
    assert.deepEqual(rc.r.matched.map((m) => m.theirs.ref), ['pi_1']);
  });
  test('FN-03b Stripe: money we never recorded is reported', () => {
    assert.deepEqual(rc.r.missingOurs.map((t) => t.ref), ['pi_2']);
  });
  test('FN-03c Stripe: payments Stripe does not show are reported', () => {
    assert.deepEqual(rc.r.missingSource.map((p) => p.ref), ['stripe pi_3']);
  });
  test('FN-03d Stripe: amount differences are reported', () => {
    assert.deepEqual(rc.r.mismatched.map((m) => [m.theirs.amount, m.ours.amount]), [[80, 70]]);
  });
  test('FN-03e the reconciliation run is logged with its issue count', () => {
    assert.equal(F.reconRuns()[0].issues, 3);
  });
  test('FN-03f the Stripe request expands the transaction source', () => {
    assert.match(prov.calls.find((x) => x.url.startsWith('/v1/balance_transactions')).url, /expand%5B%5D=data\.source/);
  });
  test('FN-03g a reversed date range is refused', async () => {
    await assert.rejects(F.reconcile({ source: 'stripe', from: rc.today, to: rc.from }), /起止日期/);
  });
  test('FN-04 PayPal: matched by capture id', async () => {
    const o = order({ qty: 4, price: 50 });
    S.recordPayment(o.id, { kind: 'deposit', amount: 200, ref: 'paypal CAP1' });
    const r = await F.reconcile({ source: 'paypal', from: day(-7).slice(0, 10), to: day(0).slice(0, 10) });
    assert.equal(r.matched.length, 1);
    assert.equal(r.missingOurs.length + r.missingSource.length + r.mismatched.length, 0);
  });
  const bk = {};
  test('FN-05a bank statement lines are matched by the order number in the reference, else by amount and date', async () => {
    const o = order({ company: 'BankCo', qty: 3, price: 100 });
    S.recordPayment(o.id, { kind: 'deposit', amount: 90, ref: 'TT 0001' });
    const o2 = order({ company: 'NoRef', qty: 3, price: 100 });
    S.recordPayment(o2.id, { kind: 'deposit', amount: 91, ref: 'TT 0002' });
    const csv = `date, reference, amount, currency\n${day(0).slice(0, 10)}, ${o.number} deposit, 90, USD\n${day(-1).slice(0, 10)}, WIRE FROM CUSTOMER, 91.00, USD\n${day(0).slice(0, 10)}, unknown, 500, USD\nnot a line`;
    bk.r = await F.reconcile({ source: 'bank', from: day(-7).slice(0, 10), to: day(0).slice(0, 10), csv });
    assert.deepEqual(bk.r.matched.map((m) => m.ours.number).sort(), [o.number, o2.number].sort());
  });
  test('FN-05b a bank line with no matching payment is reported', () => {
    assert.deepEqual(bk.r.missingOurs.map((t) => t.amount), [500]);
  });
  test('FN-05c unreadable statement lines are reported', () => {
    assert.equal(bk.r.parseErrors.length, 1);
  });
  test('FN-05d online (Stripe / PayPal) payments are not expected on the bank statement', () => {
    assert.ok(bk.r.missingSource.every((p) => !/^(stripe|paypal) /.test(p.ref)), 'online payments are not expected on the bank statement');
  });
  test('FN-05e a statement with no readable lines is refused', async () => {
    await assert.rejects(F.reconcile({ source: 'bank', from: day(-7).slice(0, 10), to: day(0).slice(0, 10), csv: 'garbage' }), /没有读到流水/);
  });
});

describe('report, ERP, documents', () => {
  const mr = {};
  test('FN-06a monthly report: received equals the sum of the month\'s incoming payments', () => {
    mr.m = day(0).slice(0, 7);
    [mr.r] = F.monthlyReport([mr.m]);
    const payments = db.prepare('SELECT amount, ref, kind FROM payments WHERE substr(ts, 1, 7) = ?').all(mr.m);
    assert.equal(mr.r.received, Math.round(payments.filter((p) => p.amount > 0).reduce((a, p) => a + p.amount, 0) * 100) / 100);
  });
  test('FN-06b monthly report: online receipts are summed separately', () => {
    assert.equal(mr.r.receivedOnline, 100 + 60 + 70 + 200);
  });
  test('FN-06c monthly report: received = online + transfer', () => {
    assert.equal(mr.r.received, mr.r.receivedOnline + mr.r.receivedTransfer);
  });
  test('FN-06d monthly report: refunds are shown and deducted from net', () => {
    const o = order({ qty: 1, price: 40 });
    S.recordPayment(o.id, { kind: 'deposit', amount: 12 });
    S.recordPayment(o.id, { kind: 'refund', amount: 5 });
    [mr.r2] = F.monthlyReport([mr.m]);
    assert.equal(mr.r2.refunds, 5);
    assert.equal(mr.r2.net, Math.round((mr.r2.received - 5) * 100) / 100);
  });
  test('FN-06e monthly report: counts the month\'s orders that are not cancelled', () => {
    assert.equal(mr.r2.orders, db.prepare("SELECT COUNT(*) n FROM orders WHERE status != 'cancelled' AND substr(created_at, 1, 7) = ?").get(mr.m).n);
  });
  const erp = {};
  test('FN-07a a receipt is not pushed while the customer is not in the ERP, and the reason is recorded', async () => {
    erp.o = order({ company: 'ErpCo', qty: 2, price: 100 });
    S.recordPayment(erp.o.id, { kind: 'deposit', amount: 60 });
    await settle();
    erp.p = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC').get(erp.o.id);
    assert.equal(erp.p.erp_bill_no, null);
    assert.match(erp.p.erp_error, /先推送订单/);
  });
  test('FN-07b once the customer is in the ERP the receipt can be pushed and gets a bill number', async () => {
    db.prepare("UPDATE customers SET erp_number = 'CUST001' WHERE id = ?").run(erp.o.customer_id);
    erp.r = await F.pushReceipt(erp.p.id);
    assert.match(erp.r.bill, /^SKD\d+$/);
  });
  test('FN-07c pushing the same receipt again returns the existing bill', async () => {
    assert.deepEqual(await F.pushReceipt(erp.p.id), { already: erp.r.bill });
  });
  test('FN-07d later payments are pushed to the ERP automatically', async () => {
    S.recordPayment(erp.o.id, { kind: 'balance', amount: 40 });
    await settle();
    erp.p = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC').get(erp.o.id);
    assert.match(erp.p.erp_bill_no, /^SKD/, 'pushed automatically');
  });
  test('FN-07e refunds are not pushed as receipts', async () => {
    S.recordPayment(erp.o.id, { kind: 'refund', amount: 10 });
    const ref = db.prepare('SELECT id FROM payments WHERE order_id = ? AND amount < 0').get(erp.o.id);
    assert.deepEqual(await F.pushReceipt(ref.id), { skipped: 'refund' });
  });
  test('FN-07f the Kingdee receipt carries the customer, amount, settlement type and date', () => {
    const body = K.buildReceipt({ ...erp.p, order_number: erp.o.number, ref: 'stripe pi_9', kind: 'online', currency: 'USD', amount: 40, ts: '2026-11-08T00:00:00Z' }, { erp_number: 'CUST001' });
    assert.equal(body.Model.FCONTACTUNIT.FNumber, 'CUST001');
    assert.equal(body.Model.FRECEIVEBILLENTRY[0].FRECTOTALAMOUNTFOR, 40);
    assert.equal(body.Model.FRECEIVEBILLENTRY[0].FSETTLETYPEID.FNumber, 'JSFS06_SYS', 'online settlement type');
    assert.equal(body.Model.FDATE, '2026-11-08');
  });
  const doc = {};
  test('FN-08a packing list rows number cartons continuously with weights and volume', () => {
    S.saveSku({ ...S.getSku('YR-HB-U2'), pcs_per_carton: 4, carton_cbm: 0.05, carton_gw: 10, hs_code: '9405420000' });
    const second = S.listSkus().find((s) => s.sku !== 'YR-HB-U2' && s.product_id !== 'YR-HB-U2');
    S.saveSku({ ...second, pcs_per_carton: 10, carton_cbm: 0.1, carton_gw: 12 });
    doc.p = D.packingRows([{ sku: 'YR-HB-U2', qty: 10 }, { sku: second.sku, qty: 25 }, { sku: 'UNKNOWN', qty: 1 }]);
    assert.deepEqual(doc.p.rows.slice(0, 2).map((r) => [r.from, r.to, r.cartons, r.gw, r.cbm]), [[1, 3, 3, 30, 0.15], [4, 6, 3, 36, 0.3]]);
  });
  test('FN-08b packing list totals add up cartons, quantity, weight and volume', () => {
    assert.deepEqual(doc.p.totals, { cartons: 6, qty: 36, nw: doc.p.totals.nw, gw: 66, cbm: 0.45 });
  });
  test('FN-08c SKUs without packing data are reported', () => {
    assert.deepEqual(doc.p.missing, ['UNKNOWN']);
  });
  test('FN-08d the commercial invoice shows the HS code, invoice number and total', () => {
    doc.o = order({ company: 'Doc Co', qty: 10, price: 50 });
    const ci = D.renderCommercialInvoice(doc.o.id);
    assert.match(ci, /Commercial Invoice/);
    assert.match(ci, /9405420000/);
    assert.match(ci, new RegExp(`CI-${doc.o.number.replace(/^[A-Z]+-?/, '')}`));
    assert.match(ci, /USD 500\.00/);
  });
  test('FN-08e the commercial invoice is available in Chinese', () => {
    assert.match(D.renderCommercialInvoice(doc.o.id, { lang: 'zh' }), /商业发票[\s\S]*原产地/);
  });
  test('FN-08f the packing list document shows carton ranges and shipping marks', () => {
    const pl = D.renderPackingList(doc.o.id);
    assert.match(pl, /Packing List[\s\S]*1–3[\s\S]*Shipping marks[\s\S]*C\/No\. 1-3/);
  });
  test('FN-08g the packing list for an unknown order is empty', () => {
    assert.equal(D.renderPackingList('nope'), null);
  });
});
