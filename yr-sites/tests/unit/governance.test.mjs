// Modules: server/src/governance/approvals.js (approval rules and the gates on quotes, refunds and product deletion) and
// server/src/governance/board.js (global board figures and adding sites together). IDs GV-xx.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';

useTempEnv({ site: 'led', ERP_MODE: 'local' });
const A = await import('../../server/src/governance/approvals.js');
const B = await import('../../server/src/governance/board.js');
const S = await import('../../server/src/ops/service.js');
const C = await import('../../server/src/catalog/store.js');
const { refundOrder } = await import('../../server/src/shop/refunds.js');
const { runAs } = await import('../../server/src/auth.js');
const { db } = await import('../../server/src/db.js');

const sam = { username: 'sam', name: 'Sam', role: 'sales' };
const max = { username: 'max', name: 'Max', role: 'sales_manager' };
const fay = { username: 'fay', name: 'Fay', role: 'finance' };
const dee = { username: 'dee', name: 'Dee', role: 'content' };
const boss = { username: 'admin', name: 'Boss', role: 'admin' };
const quote = (discount) => S.createQuote({ customer: { email: `${Math.random().toString(36).slice(2)}@x.test`, company: 'Buyer' }, lines: [{ sku: 'YR-HB-U2', qty: 10, unit_price: 100 }], discount, payment_terms: 'tt100' });

describe('rules', () => {
  test('GV-01 defaults are off; saving validates percentage, amount and approver', () => {
    assert.deepEqual(Object.values(A.rules()).map((r) => r.enabled), [false, false, false]);
    assert.throws(() => A.saveRules({ quote_discount: { enabled: true, percent: 120 } }), /0–100/);
    assert.throws(() => A.saveRules({ refund: { enabled: true, amount: -1 } }), /不小于 0/);
    assert.throws(() => A.saveRules({ product_delete: { enabled: true, approver: 'nobody' } }), /审批人无效/);
    A.saveRules({ quote_discount: { enabled: true, percent: 10, approver: 'leads.all' }, refund: { enabled: true, amount: 200, approver: 'payments' }, product_delete: { enabled: true, approver: 'admin' } });
    assert.deepEqual(A.rules().refund, { enabled: true, amount: 200, approver: 'payments' });
  });
});

describe('gates', () => {
  test('GV-02 a quote over the discount limit: request filed once, approved by a manager, then it goes through once', () => {
    const q = quote(150); // 15 % of 1000
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q.id, 'sent')), /需要审批：已提交审批（审批人：销售主管，审批单 #(\d+)）/);
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q.id, 'sent')), /已在等待审批/);
    assert.equal(S.getQuote(q.id).status, 'draft');
    const [a] = A.toDecide(max);
    assert.deepEqual([a.kind, a.ref, a.amount, a.requested_by], ['quote_discount', q.id, 150, 'sam']);
    assert.match(a.detail, /折扣 USD 150（15%）/);
    assert.equal(A.toDecide(fay).length, 0, 'finance is not the approver');
    assert.throws(() => A.decide(a.id, 'approve', fay), /没有审批权限/);
    assert.equal(A.decide(a.id, 'approve', max, 'ok this time').status, 'approved');
    assert.throws(() => A.decide(a.id, 'reject', max), /审批单状态：已通过/);
    runAs(sam, () => S.setQuoteStatus(q.id, 'sent'));
    assert.equal(S.getQuote(q.id).status, 'sent');
    assert.equal(A.getApproval(a.id).status, 'used');
  });
  test('GV-03 under the limit, approvers themselves, and non-staff contexts pass without a request', () => {
    const before = db.prepare('SELECT COUNT(*) n FROM approvals').get().n;
    runAs(sam, () => S.setQuoteStatus(quote(50).id, 'sent'));
    runAs(max, () => S.setQuoteStatus(quote(300).id, 'sent'));
    runAs(boss, () => S.setQuoteStatus(quote(300).id, 'sent'));
    S.setQuoteStatus(quote(300).id, 'sent'); // no staff user (AI, jobs, customers)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM approvals').get().n, before);
  });
  test('GV-04 an approval covers its amount only; a bigger discount needs a new one; rejection and withdrawal', () => {
    const q = quote(150);
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q.id, 'sent')), /需要审批/);
    A.decide(A.toDecide(max)[0].id, 'approve', max);
    S.updateQuote(q.id, { discount: 250 });
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q.id, 'sent')), /需要审批：已提交审批/);
    const b = A.toDecide(max)[0];
    assert.equal(b.amount, 250);
    assert.equal(A.decide(b.id, 'reject', max, 'too much').status, 'rejected');
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q.id, 'sent')), /需要审批：已提交审批/, 'rejected does not let it through');
    const c = A.toDecide(max)[0];
    assert.throws(() => A.cancel(c.id, max), /只能撤回自己/);
    A.cancel(c.id, sam);
    assert.equal(A.getApproval(c.id).status, 'cancelled');
    assert.throws(() => A.decide(c.id, 'approve', boss), /审批单状态：已撤回/);
  });
  test('GV-05 refunds over the amount need finance; product deletion needs the administrator; nobody approves their own', async () => {
    const q = quote(0);
    S.setQuoteStatus(q.id, 'sent');
    const o = S.acceptQuote(q.id);
    S.recordPayment(o.id, { kind: 'deposit', amount: 1000 });
    await assert.rejects(runAs(sam, () => refundOrder(o.id, { amount: 300, reason: 'damaged' })), /需要审批.*审批人：财务/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM refunds WHERE order_id = ?').get(o.id).n, 0, 'nothing refunded yet');
    await runAs(sam, () => refundOrder(o.id, { amount: 100 }));
    const r = A.toDecide(fay)[0];
    assert.match(r.detail, /USD 300 · damaged/);
    A.decide(r.id, 'approve', fay);
    await runAs(sam, () => refundOrder(o.id, { amount: 300, reason: 'damaged' }));
    assert.equal(S.getOrder(o.id).paid, 600);

    C.saveProduct({ id: 'YR-TEMP-1', slug: 'yr-temp-1', name: 'Temp product', category: 'high-bay', summary: 'A test fixture.', warranty: '5 years', unit: 'pcs', moq: 10, leadTimeDays: [10, 20], sampleDays: [3, 5], specs: 'Power: 100 W' }, { isNew: true, variants: [{ sku: 'YR-TEMP-1-A', options: 'CCT=5000K', price: '25', min_qty: '10' }] });
    assert.throws(() => runAs(dee, () => C.deleteProduct('YR-TEMP-1')), /需要审批.*审批人：管理员/);
    const d = A.listFor(dee).find((x) => x.kind === 'product_delete');
    assert.equal(d.label, '删除商品 YR-TEMP-1');
    assert.throws(() => A.decide(d.id, 'approve', dee), /没有审批权限/);
    A.decide(d.id, 'approve', boss);
    runAs(dee, () => C.deleteProduct('YR-TEMP-1'));
    assert.equal(C.getProduct('YR-TEMP-1'), null);
    const own = db.prepare("INSERT INTO approvals (kind, ref, label, status, requested_by, requested_at) VALUES ('refund', 'x', 'x', 'pending', 'fay', '2026-01-01') RETURNING id").get().id;
    assert.throws(() => A.decide(own, 'approve', fay), /不能审批自己/);
  });
  test('GV-06 who sees what: requesters their own, approvers what they may decide; board shown to the people involved', () => {
    assert.ok(A.listFor(sam).every((a) => a.requested_by === 'sam'));
    assert.ok(A.listFor(max).some((a) => a.requested_by === 'sam'));
    assert.ok(!A.listFor(max).some((a) => a.kind === 'refund'));
    assert.ok(A.involved(sam) && A.involved(max) && A.involved(boss));
    assert.ok(!A.involved({ username: 'wes', role: 'warehouse' }));
  });
});

describe('global board', () => {
  test('GV-07 summary has every department, the backlog per board and pending approvals', () => {
    const s = B.summary();
    for (const k of ['sales', 'marketing', 'finance', 'logistics', 'service', 'system', 'backlog']) assert.ok(s[k], k);
    assert.equal(s.cur, 'USD');
    assert.ok(s.sales.ordersMonth >= 1);
    assert.ok(s.finance.receivedMonth > 0);
    assert.ok(s.backlog.some((b) => b.title === '销售：线索'));
    assert.equal(s.approvals, db.prepare("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").get().n);
  });
  test('GV-08 two sites added together: counts summed, money per currency, rates weighted, backlog per board', () => {
    const a = { site: 'led', brand: 'A', cur: 'USD', sales: { gmvMonth: 1000, won: 500, target: 1000, ordersMonth: 2 }, marketing: { visitors30: 100, conversion: 0.1, inquiryRate: 0.2, shopRevenue30: 10 }, finance: { receivable: 5, overdue: 1, receivedMonth: 2 }, logistics: { toShip: 1 }, service: { rating: 5, ratings: 1, waiting: 2 }, system: { backupOk: true, errors24h: 1 }, approvals: 1, backlog: [{ title: 'X', count: 2 }] };
    const b = { site: 'grid', brand: 'B', cur: 'CNY', sales: { gmvMonth: 7000, won: 0, target: 0, ordersMonth: 3 }, marketing: { visitors30: 300, conversion: 0.02, inquiryRate: 0.1, shopRevenue30: 0 }, finance: { receivable: 1, overdue: 0, receivedMonth: 0 }, logistics: { toShip: 4 }, service: { rating: 2, ratings: 3, waiting: 1 }, system: { backupOk: false, errors24h: 0 }, approvals: 2, backlog: [{ title: 'X', count: 1 }, { title: 'Y', count: 5 }] };
    const m = B.merge([a, b]);
    assert.equal(m.site, 'led + grid');
    assert.deepEqual(m.sales.gmvMonth, { USD: 1000, CNY: 7000 });
    assert.equal(m.sales.ordersMonth, 5);
    assert.equal(m.logistics.toShip, 5);
    assert.ok(Math.abs(m.marketing.conversion - 0.04) < 1e-9, 'weighted by visitors');
    assert.equal(m.service.rating, 2.8);
    assert.equal(m.system.backupOk, false);
    assert.equal(m.approvals, 3);
    assert.deepEqual(m.backlog, [{ title: 'X', count: 3 }, { title: 'Y', count: 5 }]);
  });
});
