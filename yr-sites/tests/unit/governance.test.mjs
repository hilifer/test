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
  test('GV-01a all approval rules are disabled by default', () => {
    assert.deepEqual(Object.values(A.rules()).map((r) => r.enabled), [false, false, false]);
  });
  test('GV-01b saving rejects a discount percentage outside 0–100', () => {
    assert.throws(() => A.saveRules({ quote_discount: { enabled: true, percent: 120 } }), /0–100/);
  });
  test('GV-01c saving rejects a negative refund amount', () => {
    assert.throws(() => A.saveRules({ refund: { enabled: true, amount: -1 } }), /不小于 0/);
  });
  test('GV-01d saving rejects an unknown approver', () => {
    assert.throws(() => A.saveRules({ product_delete: { enabled: true, approver: 'nobody' } }), /审批人无效/);
  });
  test('GV-01e valid rules are saved and read back', () => {
    A.saveRules({ quote_discount: { enabled: true, percent: 10, approver: 'leads.all' }, refund: { enabled: true, amount: 200, approver: 'payments' }, product_delete: { enabled: true, approver: 'admin' } });
    assert.deepEqual(A.rules().refund, { enabled: true, amount: 200, approver: 'payments' });
  });
});

describe('gates', () => {
  const approvalCount = () => db.prepare('SELECT COUNT(*) n FROM approvals').get().n;
  let q2, a2;
  test('GV-02a sending a quote over the discount limit files an approval request and is blocked', () => {
    q2 = quote(150); // 15 % of 1000
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q2.id, 'sent')), /需要审批：已提交审批（审批人：销售主管，审批单 #(\d+)）/);
  });
  test('GV-02b sending again while pending reports the waiting request and the quote stays draft', () => {
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q2.id, 'sent')), /已在等待审批/);
    assert.equal(S.getQuote(q2.id).status, 'draft');
  });
  test('GV-02c the request appears once for the sales manager with kind, ref, amount, requester and detail', () => {
    const list = A.toDecide(max);
    assert.equal(list.filter((x) => x.ref === q2.id).length, 1, 'filed only once');
    [a2] = list;
    assert.deepEqual([a2.kind, a2.ref, a2.amount, a2.requested_by], ['quote_discount', q2.id, 150, 'sam']);
    assert.match(a2.detail, /折扣 USD 150（15%）/);
  });
  test('GV-02d finance neither sees nor may decide the discount request', () => {
    assert.equal(A.toDecide(fay).length, 0, 'finance is not the approver');
    assert.throws(() => A.decide(a2.id, 'approve', fay), /没有审批权限/);
  });
  test('GV-02e the manager approves it and it cannot be decided a second time', () => {
    assert.equal(A.decide(a2.id, 'approve', max, 'ok this time').status, 'approved');
    assert.throws(() => A.decide(a2.id, 'reject', max), /审批单状态：已通过/);
  });
  test('GV-02f after approval the quote is sent and the approval is marked used', () => {
    runAs(sam, () => S.setQuoteStatus(q2.id, 'sent'));
    assert.equal(S.getQuote(q2.id).status, 'sent');
    assert.equal(A.getApproval(a2.id).status, 'used');
  });
  test('GV-03a a discount under the limit is sent without a request', () => {
    const before = approvalCount();
    runAs(sam, () => S.setQuoteStatus(quote(50).id, 'sent'));
    assert.equal(approvalCount(), before);
  });
  test('GV-03b the sales manager (an approver) sends a big discount without a request', () => {
    const before = approvalCount();
    runAs(max, () => S.setQuoteStatus(quote(300).id, 'sent'));
    assert.equal(approvalCount(), before);
  });
  test('GV-03c the administrator sends a big discount without a request', () => {
    const before = approvalCount();
    runAs(boss, () => S.setQuoteStatus(quote(300).id, 'sent'));
    assert.equal(approvalCount(), before);
  });
  test('GV-03d a non-staff context (AI, jobs, customers) sends a big discount without a request', () => {
    const before = approvalCount();
    S.setQuoteStatus(quote(300).id, 'sent'); // no staff user (AI, jobs, customers)
    assert.equal(approvalCount(), before);
  });
  let q4, b4, c4;
  test('GV-04a a discount request is filed and approved for its amount', () => {
    q4 = quote(150);
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q4.id, 'sent')), /需要审批/);
    A.decide(A.toDecide(max)[0].id, 'approve', max);
  });
  test('GV-04b raising the discount above the approved amount needs a new request for the new amount', () => {
    S.updateQuote(q4.id, { discount: 250 });
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q4.id, 'sent')), /需要审批：已提交审批/);
    b4 = A.toDecide(max)[0];
    assert.equal(b4.amount, 250);
  });
  test('GV-04c a rejected request does not let the quote through', () => {
    assert.equal(A.decide(b4.id, 'reject', max, 'too much').status, 'rejected');
    assert.throws(() => runAs(sam, () => S.setQuoteStatus(q4.id, 'sent')), /需要审批：已提交审批/, 'rejected does not let it through');
  });
  test('GV-04d only the requester may withdraw a request', () => {
    c4 = A.toDecide(max)[0];
    assert.throws(() => A.cancel(c4.id, max), /只能撤回自己/);
    A.cancel(c4.id, sam);
    assert.equal(A.getApproval(c4.id).status, 'cancelled');
  });
  test('GV-04e a withdrawn request cannot be decided', () => {
    assert.throws(() => A.decide(c4.id, 'approve', boss), /审批单状态：已撤回/);
  });
  let o5, d5;
  test('GV-05a a refund over the amount is blocked pending finance approval and nothing is refunded', async () => {
    const q = quote(0);
    S.setQuoteStatus(q.id, 'sent');
    o5 = S.acceptQuote(q.id);
    S.recordPayment(o5.id, { kind: 'deposit', amount: 1000 });
    await assert.rejects(runAs(sam, () => refundOrder(o5.id, { amount: 300, reason: 'damaged' })), /需要审批.*审批人：财务/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM refunds WHERE order_id = ?').get(o5.id).n, 0, 'nothing refunded yet');
  });
  test('GV-05b a refund under the amount goes through without approval', async () => {
    await runAs(sam, () => refundOrder(o5.id, { amount: 100 }));
    assert.equal(S.getOrder(o5.id).paid, 900);
  });
  test('GV-05c finance sees the refund detail, approves it, and the refund then goes through', async () => {
    const r = A.toDecide(fay)[0];
    assert.match(r.detail, /USD 300 · damaged/);
    A.decide(r.id, 'approve', fay);
    await runAs(sam, () => refundOrder(o5.id, { amount: 300, reason: 'damaged' }));
    assert.equal(S.getOrder(o5.id).paid, 600);
  });
  test('GV-05d deleting a product files a request for the administrator with a readable label', () => {
    C.saveProduct({ id: 'YR-TEMP-1', slug: 'yr-temp-1', name: 'Temp product', category: 'high-bay', summary: 'A test fixture.', warranty: '5 years', unit: 'pcs', moq: 10, leadTimeDays: [10, 20], sampleDays: [3, 5], specs: 'Power: 100 W' }, { isNew: true, variants: [{ sku: 'YR-TEMP-1-A', options: 'CCT=5000K', price: '25', min_qty: '10' }] });
    assert.throws(() => runAs(dee, () => C.deleteProduct('YR-TEMP-1')), /需要审批.*审批人：管理员/);
    d5 = A.listFor(dee).find((x) => x.kind === 'product_delete');
    assert.equal(d5.label, '删除商品 YR-TEMP-1');
  });
  test('GV-05e a content editor cannot approve a product deletion', () => {
    assert.throws(() => A.decide(d5.id, 'approve', dee), /没有审批权限/);
  });
  test('GV-05f after the administrator approves, the product is deleted', () => {
    A.decide(d5.id, 'approve', boss);
    runAs(dee, () => C.deleteProduct('YR-TEMP-1'));
    assert.equal(C.getProduct('YR-TEMP-1'), null);
  });
  test('GV-05g nobody may approve their own request', () => {
    const own = db.prepare("INSERT INTO approvals (kind, ref, label, status, requested_by, requested_at) VALUES ('refund', 'x', 'x', 'pending', 'fay', '2026-01-01') RETURNING id").get().id;
    assert.throws(() => A.decide(own, 'approve', fay), /不能审批自己/);
  });
  test('GV-06a a requester sees only their own requests', () => {
    assert.ok(A.listFor(sam).every((a) => a.requested_by === 'sam'));
  });
  test('GV-06b an approver sees the requests they may decide and not others', () => {
    assert.ok(A.listFor(max).some((a) => a.requested_by === 'sam'));
    assert.ok(!A.listFor(max).some((a) => a.kind === 'refund'));
  });
  test('GV-06c the approvals board is shown to requesters and approvers only', () => {
    assert.ok(A.involved(sam) && A.involved(max) && A.involved(boss));
    assert.ok(!A.involved({ username: 'wes', role: 'warehouse' }));
  });
});

describe('global board', () => {
  let s;
  test('GV-07a summary has every department section and the site currency', () => {
    s = B.summary();
    for (const k of ['sales', 'marketing', 'finance', 'logistics', 'service', 'system', 'backlog']) assert.ok(s[k], k);
    assert.equal(s.cur, 'USD');
  });
  test('GV-07b summary counts this month\'s orders and received money', () => {
    assert.ok(s.sales.ordersMonth >= 1);
    assert.ok(s.finance.receivedMonth > 0);
  });
  test('GV-07c summary lists the backlog per board', () => {
    assert.ok(s.backlog.some((b) => b.title === '销售：线索'));
  });
  test('GV-07d summary counts pending approvals', () => {
    assert.equal(s.approvals, db.prepare("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").get().n);
  });
  let m;
  test('GV-08a merging two sites joins the site names and keeps money per currency', () => {
    const a = { site: 'led', brand: 'A', cur: 'USD', sales: { gmvMonth: 1000, won: 500, target: 1000, ordersMonth: 2 }, marketing: { visitors30: 100, conversion: 0.1, inquiryRate: 0.2, shopRevenue30: 10 }, finance: { receivable: 5, overdue: 1, receivedMonth: 2 }, logistics: { toShip: 1 }, service: { rating: 5, ratings: 1, waiting: 2 }, system: { backupOk: true, errors24h: 1 }, approvals: 1, backlog: [{ title: 'X', count: 2 }] };
    const b = { site: 'grid', brand: 'B', cur: 'CNY', sales: { gmvMonth: 7000, won: 0, target: 0, ordersMonth: 3 }, marketing: { visitors30: 300, conversion: 0.02, inquiryRate: 0.1, shopRevenue30: 0 }, finance: { receivable: 1, overdue: 0, receivedMonth: 0 }, logistics: { toShip: 4 }, service: { rating: 2, ratings: 3, waiting: 1 }, system: { backupOk: false, errors24h: 0 }, approvals: 2, backlog: [{ title: 'X', count: 1 }, { title: 'Y', count: 5 }] };
    m = B.merge([a, b]);
    assert.equal(m.site, 'led + grid');
    assert.deepEqual(m.sales.gmvMonth, { USD: 1000, CNY: 7000 });
  });
  test('GV-08b merging sums counts (orders, to ship, approvals)', () => {
    assert.equal(m.sales.ordersMonth, 5);
    assert.equal(m.logistics.toShip, 5);
    assert.equal(m.approvals, 3);
  });
  test('GV-08c merging weights rates (conversion by visitors, rating by ratings)', () => {
    assert.ok(Math.abs(m.marketing.conversion - 0.04) < 1e-9, 'weighted by visitors');
    assert.equal(m.service.rating, 2.8);
  });
  test('GV-08d backup is OK only when every site\'s backup is OK', () => {
    assert.equal(m.system.backupOk, false);
  });
  test('GV-08e backlog is summed per board title', () => {
    assert.deepEqual(m.backlog, [{ title: 'X', count: 3 }, { title: 'Y', count: 5 }]);
  });
});
